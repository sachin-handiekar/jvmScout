"""REST + WebSocket routes."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import (
    APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect,
)

from .. import storage
from ..config import settings
from ..models import AgentStartEvent, ExceptionEvent
from ..security import authorize_websocket, client_key, rate_limiter, require_auth

log = logging.getLogger("collector.routes")

# Public router: no auth (health checks, liveness probes).
public_router = APIRouter()

# Data router: every endpoint requires a valid API key (when auth is enabled).
router = APIRouter(dependencies=[Depends(require_auth)])


class ConnectionManager:
    """Tracks live WebSocket clients and fans out events to them."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._clients)
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:
                await self.disconnect(ws)


manager = ConnectionManager()


@public_router.get("/healthz")
async def healthz() -> dict:
    """Cheap liveness/readiness probe (no DB aggregation, no auth)."""
    return {"status": "ok"}


async def _read_json_body(request: Request) -> Any:
    """Read and parse the request body, enforcing the max-body-size limit."""
    limit = settings.max_body_bytes
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > limit:
                raise HTTPException(status_code=413, detail="payload too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid Content-Length")
    body = await request.body()
    if len(body) > limit:
        raise HTTPException(status_code=413, detail="payload too large")
    try:
        return json.loads(body) if body else None
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid JSON")


@router.post("/collector")
async def ingest(request: Request) -> dict:
    if not rate_limiter.allow(client_key(request)):
        raise HTTPException(status_code=429, detail="rate limit exceeded")

    payload = await _read_json_body(request)
    items = payload if isinstance(payload, list) else [payload]
    accepted = 0
    failed = 0
    for raw in items:
        if not isinstance(raw, dict):
            failed += 1
            continue
        try:
            if raw.get("type") == "agent_start":
                ev = AgentStartEvent.model_validate(raw)
                await storage.store_agent_start(ev, raw)
                await manager.broadcast({"kind": "agent_start", "event": raw})
            else:
                ev = ExceptionEvent.model_validate(raw)
                row_id = await storage.store_exception(ev, raw)
                await manager.broadcast({"kind": "exception", "id": row_id, "event": raw})
            accepted += 1
        except Exception:
            failed += 1
            log.warning("dropping malformed event", exc_info=True)
    return {"accepted": accepted, "failed": failed}


@router.get("/exceptions")
async def get_exceptions(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    type: Optional[str] = None,
    deployment: Optional[str] = None,
    caught: Optional[bool] = None,
    fingerprint: Optional[str] = None,
) -> dict:
    items, total = await storage.list_exceptions(
        limit=limit, offset=offset, exception_type=type,
        deployment_id=deployment, caught=caught, fingerprint=fingerprint)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/exceptions/{exc_id}")
async def get_exception_detail(exc_id: int) -> dict:
    ev = await storage.get_exception(exc_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="not found")
    return ev


@router.delete("/exceptions/{exc_id}")
async def delete_exception(exc_id: int) -> dict:
    if not await storage.delete_exception(exc_id):
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": exc_id}


@router.delete("/exceptions")
async def delete_all(confirm: bool = Query(False)) -> dict:
    # Destructive: require an explicit confirm=true so a stray DELETE can't wipe data.
    if not confirm:
        raise HTTPException(
            status_code=400, detail="pass ?confirm=true to delete all exceptions")
    n = await storage.delete_all_exceptions()
    return {"deleted": n}


@router.get("/stats")
async def get_stats() -> dict:
    return await storage.stats()


@router.get("/jvm-info")
async def jvm_info() -> list[dict]:
    return await storage.list_instances()


@router.get("/jvm-info/{instance_id}")
async def jvm_info_one(instance_id: str) -> dict:
    inst = await storage.get_instance(instance_id)
    if inst is None:
        raise HTTPException(status_code=404, detail="not found")
    return inst


@router.get("/jvm-instances")
async def jvm_instances() -> list[dict]:
    return await storage.list_instances()


def _check_config_table(table: str) -> None:
    if table not in storage.CONFIG_TABLES:
        raise HTTPException(status_code=404, detail=f"unknown config table: {table}")


@router.get("/config/{table}")
async def list_config(table: str) -> list[dict]:
    _check_config_table(table)
    return await storage.list_config(table)


@router.post("/config/{table}")
async def create_config(table: str, request: Request) -> dict:
    _check_config_table(table)
    payload = await _read_json_body(request)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    return await storage.insert_config(table, payload)


@router.patch("/config/{table}/{entity_id}")
async def patch_config(table: str, entity_id: str, request: Request) -> dict:
    _check_config_table(table)
    payload = await _read_json_body(request)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    updated = await storage.update_config(table, entity_id, payload)
    if updated is None:
        raise HTTPException(status_code=404, detail="not found")
    return updated


@router.delete("/config/{table}/{entity_id}")
async def remove_config(table: str, entity_id: str) -> dict:
    _check_config_table(table)
    if not await storage.delete_config(table, entity_id):
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": entity_id}


@router.websocket("/ws/live")
async def ws_live(ws: WebSocket) -> None:
    if not authorize_websocket(ws):
        await ws.close(code=1008)  # policy violation
        return
    await manager.connect(ws)
    try:
        while True:
            # We only push; ignore client traffic but keep the socket alive.
            await ws.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:
        await manager.disconnect(ws)

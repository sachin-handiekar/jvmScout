"""REST + WebSocket routes."""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from .. import storage
from ..models import AgentStartEvent, ExceptionEvent

router = APIRouter()


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


@router.post("/collector")
async def ingest(request: Request) -> dict:
    payload = await request.json()
    items = payload if isinstance(payload, list) else [payload]
    accepted = 0
    for raw in items:
        if not isinstance(raw, dict):
            continue
        if raw.get("type") == "agent_start":
            ev = AgentStartEvent.model_validate(raw)
            await storage.store_agent_start(ev, raw)
            await manager.broadcast({"kind": "agent_start", "event": raw})
        else:
            ev = ExceptionEvent.model_validate(raw)
            row_id = await storage.store_exception(ev, raw)
            await manager.broadcast({"kind": "exception", "id": row_id, "event": raw})
        accepted += 1
    return {"accepted": accepted}


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
async def delete_all() -> dict:
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


@router.websocket("/ws/live")
async def ws_live(ws: WebSocket) -> None:
    await manager.connect(ws)
    try:
        while True:
            # We only push; ignore client traffic but keep the socket alive.
            await ws.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:
        await manager.disconnect(ws)

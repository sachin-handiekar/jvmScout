"""REST + WebSocket routes."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from typing import Any, Optional

from fastapi import (
    APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect,
)
from starlette.responses import PlainTextResponse

from .. import alerts, decompiler, redaction, storage
from ..config import settings
from ..metrics import metrics
from ..models import AgentStartEvent, ExceptionEvent
from ..security import (
    Principal, authorize_websocket, hash_token, rate_key, rate_limiter,
    require_admin, require_auth, require_ingest, require_read, token_store,
    DEFAULT_PROJECT, VALID_ROLES, ROLE_INGEST,
)

log = logging.getLogger("collector.routes")
# Destructive/admin actions land here with the acting principal, so operators
# can answer "who minted that token / deleted that data" after the fact.
audit = logging.getLogger("collector.audit")


def _who(principal: Principal) -> str:
    if principal.is_master:
        return f"master(token={principal.token_id or 'env-key'})"
    return (f"token={principal.token_id or '?'} "
            f"project={principal.project_id} role={principal.role}")

# Public router: no auth (health checks, liveness probes).
public_router = APIRouter()

# Data router: every endpoint requires a valid API key (when auth is enabled).
router = APIRouter(dependencies=[Depends(require_auth)])


class ConnectionManager:
    """Tracks live WebSocket clients and fans out events to them, scoped per
    project so a dashboard only receives its own tenant's events (the master /
    superadmin sees every project)."""

    # One stalled dashboard (full TCP window) must not delay everyone else or
    # back-pressure ingest: sends run concurrently and a client that can't
    # accept a frame within this budget is disconnected.
    SEND_TIMEOUT_S = 2.0

    def __init__(self) -> None:
        self._clients: dict[WebSocket, Principal] = {}
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket, principal: Principal) -> None:
        await ws.accept()
        async with self._lock:
            self._clients[ws] = principal
            metrics.ws_clients = len(self._clients)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.pop(ws, None)
            metrics.ws_clients = len(self._clients)

    async def _send_one(self, ws: WebSocket, message: dict[str, Any]) -> None:
        try:
            await asyncio.wait_for(ws.send_json(message), self.SEND_TIMEOUT_S)
        except Exception:
            await self.disconnect(ws)
            try:
                await ws.close()
            except Exception:
                pass

    async def broadcast(self, message: dict[str, Any],
                        project_id: Optional[str] = None) -> None:
        async with self._lock:
            targets = [
                ws for ws, principal in self._clients.items()
                if principal.is_master or principal.project_id == project_id
            ]
        if targets:
            await asyncio.gather(*(self._send_one(ws, message) for ws in targets))


manager = ConnectionManager()


class _RedactionCache:
    """Short-TTL, per-project cache of compiled redaction rules so ingest doesn't
    hit the DB per event but still picks up UI rule changes within a few seconds.
    Rules are scoped to the event's tenant (NULL project = the default)."""

    def __init__(self, ttl_s: float = 5.0) -> None:
        self._ttl = ttl_s
        self._by_project: dict[Optional[str], tuple[float, redaction.CompiledRules]] = {}

    async def get(self, project_id: Optional[str]) -> redaction.CompiledRules:
        now = time.monotonic()
        ent = self._by_project.get(project_id)
        if ent and now - ent[0] <= self._ttl:
            return ent[1]
        rules = await storage.list_config("redaction_rules", project_id=project_id)
        compiled = redaction.compile_rules(rules)
        self._by_project[project_id] = (now, compiled)
        return compiled

    def reset(self) -> None:
        """Force a reload on next get() (used for test isolation)."""
        self._by_project = {}


redaction_cache = _RedactionCache()


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
async def ingest(request: Request,
                 principal: Principal = Depends(require_ingest)) -> dict:
    if not rate_limiter.allow(rate_key(request, principal)):
        metrics.rate_limited += 1
        raise HTTPException(status_code=429, detail="rate limit exceeded")

    # The event's tenant is taken authoritatively from the token, not from
    # anything the agent self-reports (so one app can't claim another's data).
    project_id = principal.scope  # None for the master key

    payload = await _read_json_body(request)
    items = payload if isinstance(payload, list) else [payload]
    rules = await redaction_cache.get(project_id)
    accepted = 0
    failed = 0
    # Validate/redact everything first, then persist the exceptions in ONE
    # transaction (agents send batches; a commit per event fsyncs per event).
    batch: list[tuple[ExceptionEvent, dict]] = []
    for raw in items:
        if not isinstance(raw, dict):
            failed += 1
            continue
        try:
            if raw.get("type") == "agent_start":
                ev = AgentStartEvent.model_validate(raw)
                await storage.store_agent_start(ev, raw, project_id)
                await manager.broadcast({"kind": "agent_start", "event": raw}, project_id)
                accepted += 1
            elif raw.get("type") == "source_class":
                # App-class bytecode for the decompiled source view (not an event).
                await storage.store_source_class(
                    project_id, raw.get("className") or "", raw.get("bytecodeB64") or "")
                accepted += 1
            else:
                # Redact captured values before parsing/storing/broadcasting.
                raw = redaction.redact_event(raw, rules)
                batch.append((ExceptionEvent.model_validate(raw), raw))
        except Exception:
            failed += 1
            log.warning("dropping malformed event", exc_info=True)

    if batch:
        try:
            row_ids = await storage.store_exceptions(batch, project_id)
        except Exception:
            failed += len(batch)
            log.warning("failed to store exception batch", exc_info=True)
        else:
            accepted += len(batch)
            for row_id, (_ev, raw) in zip(row_ids, batch):
                await manager.broadcast(
                    {"kind": "exception", "id": row_id, "event": raw}, project_id)
                # Evaluate alert rules off the ingest path (never blocks/breaks it).
                alerts.schedule_evaluation(raw, project_id)

    metrics.ingest_batches += 1
    metrics.events_accepted += accepted
    metrics.events_failed += failed
    return {"accepted": accepted, "failed": failed}


@router.get("/exceptions")
async def get_exceptions(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    type: Optional[str] = None,
    deployment: Optional[str] = None,
    environment: Optional[str] = None,
    caught: Optional[bool] = None,
    fingerprint: Optional[str] = None,
    principal: Principal = Depends(require_read),
) -> dict:
    items, total = await storage.list_exceptions(
        limit=limit, offset=offset, exception_type=type,
        deployment_id=deployment, caught=caught, fingerprint=fingerprint,
        environment=environment, project_id=principal.scope)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/exceptions/{exc_id}")
async def get_exception_detail(
        exc_id: int, principal: Principal = Depends(require_read)) -> dict:
    ev = await storage.get_exception(exc_id, project_id=principal.scope)
    if ev is None:
        raise HTTPException(status_code=404, detail="not found")
    await _attach_source(ev, principal.scope)
    return ev


async def _attach_source(ev: dict, project_id: Optional[str]) -> None:
    """Best-effort: decompile each app frame's captured bytecode and attach a
    ``sourceSnippet`` so the dashboard frame panel can show source. No-op when no
    decompiler/bytecode is available."""
    if not decompiler.available():
        return
    frames = ev.get("stackTrace") or ev.get("stack_trace") or []
    for f in frames:
        if not isinstance(f, dict):
            continue
        if not (f.get("isAppCode") or f.get("is_app_code")):
            continue
        if f.get("sourceSnippet"):
            continue
        cls = f.get("className") or f.get("class_name") or ""
        if not cls:
            continue
        slash = cls.replace(".", "/")
        b64 = await storage.get_source_class(slash, project_id=project_id)
        if not b64:
            continue
        # Decompilation shells out to the JVM; run it off the event loop.
        src = await asyncio.to_thread(decompiler.decompile_class, slash, b64)
        if not src:
            continue
        method = f.get("methodName") or f.get("method_name") or ""
        line = int(f.get("lineNumber") or f.get("line_number") or 0)
        f["sourceSnippet"] = decompiler.build_snippet(src, method, line)


@router.delete("/exceptions/{exc_id}")
async def delete_exception(
        exc_id: int, principal: Principal = Depends(require_admin)) -> dict:
    if not await storage.delete_exception(exc_id, project_id=principal.scope):
        raise HTTPException(status_code=404, detail="not found")
    audit.info("deleted exception %s by %s", exc_id, _who(principal))
    return {"deleted": exc_id}


@router.delete("/exceptions")
async def delete_all(confirm: bool = Query(False),
                     principal: Principal = Depends(require_admin)) -> dict:
    # Destructive: require an explicit confirm=true so a stray DELETE can't wipe data.
    if not confirm:
        raise HTTPException(
            status_code=400, detail="pass ?confirm=true to delete all exceptions")
    n = await storage.delete_all_exceptions(project_id=principal.scope)
    audit.info("deleted ALL exceptions (%d rows, scope=%s) by %s",
               n, principal.scope or "all-projects", _who(principal))
    return {"deleted": n}


@router.get("/metrics")
async def get_metrics(principal: Principal = Depends(require_read)) -> PlainTextResponse:
    """Prometheus text-format operational counters (aggregate only — no event
    content). Point a scraper here with any read-capable token."""
    return PlainTextResponse(metrics.render(),
                             media_type="text/plain; version=0.0.4")


@router.delete("/admin/data")
async def delete_all_data(confirm: bool = Query(False),
                          principal: Principal = Depends(require_admin)) -> dict:
    """Admin reset: wipe ALL captured monitoring data for the caller's tenant —
    exceptions/events, JVM instances (agents), and decompiler source classes.
    Configuration (tokens, redaction rules, integrations, team) is left intact.
    Destructive: requires an explicit ?confirm=true. Scoped to the admin's
    project; the master key clears every project's data."""
    if not confirm:
        raise HTTPException(
            status_code=400, detail="pass ?confirm=true to delete all data")
    scope = principal.scope
    exceptions = await storage.delete_all_exceptions(project_id=scope)
    instances = await storage.delete_all_instances(project_id=scope)
    source_classes = await storage.delete_all_source_classes(project_id=scope)
    audit.info("admin data reset (%d exceptions, %d instances, %d source "
               "classes, scope=%s) by %s", exceptions, instances,
               source_classes, scope or "all-projects", _who(principal))
    return {
        "deleted": {
            "exceptions": exceptions,
            "instances": instances,
            "source_classes": source_classes,
        },
    }


@router.get("/stats")
async def get_stats(principal: Principal = Depends(require_read)) -> dict:
    return await storage.stats(project_id=principal.scope)


@router.get("/stats/timeseries")
async def get_timeseries(
    hours: int = Query(24, ge=1, le=24 * 90),
    buckets: int = Query(24, ge=1, le=200),
    environment: Optional[str] = None,
    principal: Principal = Depends(require_read),
) -> dict:
    return await storage.timeseries(hours=hours, buckets=buckets,
                                    environment=environment, project_id=principal.scope)


@router.get("/stats/event-series")
async def get_event_series(
    hours: int = Query(24, ge=1, le=24 * 90),
    buckets: int = Query(24, ge=1, le=200),
    environment: Optional[str] = None,
    principal: Principal = Depends(require_read),
) -> dict:
    """Per-fingerprint bucketed occurrence counts (real data behind the
    dashboard's per-event hit totals, sparklines, and trend)."""
    return await storage.event_series(hours=hours, buckets=buckets,
                                      environment=environment, project_id=principal.scope)


@router.get("/jvm-info")
async def jvm_info(principal: Principal = Depends(require_read)) -> list[dict]:
    return await storage.list_instances(project_id=principal.scope)


@router.get("/jvm-info/{instance_id}")
async def jvm_info_one(
        instance_id: str, principal: Principal = Depends(require_read)) -> dict:
    inst = await storage.get_instance(instance_id, project_id=principal.scope)
    if inst is None:
        raise HTTPException(status_code=404, detail="not found")
    return inst


@router.get("/jvm-instances")
async def jvm_instances(principal: Principal = Depends(require_read)) -> list[dict]:
    return await storage.list_instances(project_id=principal.scope)


@router.post("/tokens")
async def create_token(request: Request,
                       principal: Principal = Depends(require_admin)) -> dict:
    """Issue an API token: generate it server-side, store only its SHA-256 hash,
    and return the raw token once. The token is bound to a project and a role
    (ingest | viewer | admin). A non-master admin can only mint tokens for its
    own project. Agents send the token as the api_key."""
    payload = await _read_json_body(request)
    payload = payload if isinstance(payload, dict) else {}
    name = payload.get("name")

    role = payload.get("role")
    if role not in VALID_ROLES:
        role = ROLE_INGEST  # tokens are most often minted for agents

    # Scope the new token. The master key may target any project (default if
    # unspecified); a project admin is pinned to its own project.
    requested_project = payload.get("project_id")
    if principal.is_master:
        project_id = requested_project or DEFAULT_PROJECT
    else:
        if requested_project and requested_project != principal.project_id:
            raise HTTPException(status_code=403,
                                detail="cannot mint tokens for another project")
        project_id = principal.project_id or DEFAULT_PROJECT

    raw = "stk_" + secrets.token_hex(24)
    prefix = raw[:10]
    stored = await storage.insert_config("api_tokens", {
        "name": name or "Untitled token",
        "token_prefix": prefix,
        "token_hash": hash_token(raw),
        "role": role,
        "revoked_at": None,
    }, project_id=project_id)
    token_store.reset()  # make the new token usable immediately
    audit.info("minted token %s (name=%r project=%s role=%s) by %s",
               prefix, name, project_id, role, _who(principal))
    return {"token": raw, "token_prefix": prefix, "id": stored["id"],
            "name": stored.get("name"), "project_id": project_id, "role": role}


def _check_config_table(table: str) -> None:
    if table not in storage.CONFIG_TABLES:
        raise HTTPException(status_code=404, detail=f"unknown config table: {table}")


def _config_scope(principal: Principal) -> tuple[Optional[str], bool]:
    """(project_id, all_projects) for config CRUD. The master key manages every
    tenant; a scoped admin only its own project."""
    if principal.is_master:
        return None, True
    return principal.project_id, False


@router.get("/config/{table}")
async def list_config(table: str,
                      principal: Principal = Depends(require_read)) -> list[dict]:
    _check_config_table(table)
    # Token metadata (names/prefixes/hashes) is admin-only.
    if table == "api_tokens" and not principal.can_admin:
        raise HTTPException(status_code=403, detail="token lacks admin access")
    project_id, all_projects = _config_scope(principal)
    return await storage.list_config(table, project_id=project_id,
                                     all_projects=all_projects)


@router.post("/config/{table}")
async def create_config(table: str, request: Request,
                        principal: Principal = Depends(require_admin)) -> dict:
    _check_config_table(table)
    payload = await _read_json_body(request)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    # New config belongs to the creating admin's project (master -> default/NULL).
    project_id = None if principal.is_master else principal.project_id
    created = await storage.insert_config(table, payload, project_id=project_id)
    if table == "alert_rules":
        alerts.rule_cache.reset()
    if table == "api_tokens":
        token_store.reset()
    audit.info("created config %s/%s by %s", table, created.get("id"), _who(principal))
    return created


@router.patch("/config/{table}/{entity_id}")
async def patch_config(table: str, entity_id: str, request: Request,
                       principal: Principal = Depends(require_admin)) -> dict:
    _check_config_table(table)
    payload = await _read_json_body(request)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    project_id, all_projects = _config_scope(principal)
    updated = await storage.update_config(table, entity_id, payload,
                                          project_id=project_id, all_projects=all_projects)
    if updated is None:
        raise HTTPException(status_code=404, detail="not found")
    if table == "api_tokens":
        token_store.reset()  # revocation/edits take effect immediately
    if table == "alert_rules":
        alerts.rule_cache.reset()
    audit.info("updated config %s/%s (fields=%s) by %s",
               table, entity_id, sorted(payload.keys()), _who(principal))
    return updated


@router.delete("/config/{table}/{entity_id}")
async def remove_config(table: str, entity_id: str,
                        principal: Principal = Depends(require_admin)) -> dict:
    _check_config_table(table)
    project_id, all_projects = _config_scope(principal)
    if not await storage.delete_config(table, entity_id,
                                       project_id=project_id, all_projects=all_projects):
        raise HTTPException(status_code=404, detail="not found")
    if table == "api_tokens":
        token_store.reset()
    if table == "alert_rules":
        alerts.rule_cache.reset()
    audit.info("deleted config %s/%s by %s", table, entity_id, _who(principal))
    return {"deleted": entity_id}


# On public_router: router-level require_auth reads headers only, which
# browsers cannot set on a WebSocket handshake. authorize_websocket below does
# the full check itself (headers OR ?key=, read role required).
@public_router.websocket("/ws/live")
async def ws_live(ws: WebSocket) -> None:
    principal = await authorize_websocket(ws)
    if principal is None:
        await ws.close(code=1008)  # policy violation
        return
    await manager.connect(ws, principal)
    try:
        while True:
            # We only push; ignore client traffic but keep the socket alive.
            await ws.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:
        await manager.disconnect(ws)

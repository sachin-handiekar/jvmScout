"""Async SQLAlchemy storage: two tables plus CRUD/stat helpers."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import (
    Boolean, Integer, String, Text, delete, func, or_, select,
)
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .config import settings
from .models import AgentStartEvent, ExceptionEvent


class Base(DeclarativeBase):
    pass


class ExceptionRow(Base):
    __tablename__ = "exceptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    received_at: Mapped[str] = mapped_column(String(32))
    timestamp: Mapped[Optional[str]] = mapped_column(String(32))
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    capture_mode: Mapped[Optional[str]] = mapped_column(String(16))
    hit_count: Mapped[int] = mapped_column(Integer, default=1)
    # Tenant the event belongs to, derived authoritatively from the ingest token
    # (NULL for events ingested with the master key / when auth is disabled).
    project_id: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    deployment_id: Mapped[Optional[str]] = mapped_column(String(128), index=True)
    environment: Mapped[Optional[str]] = mapped_column(String(32), index=True)
    instance_id: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    exception_type: Mapped[Optional[str]] = mapped_column(String(256), index=True)
    exception_message: Mapped[Optional[str]] = mapped_column(Text)
    caught: Mapped[Optional[bool]] = mapped_column(Boolean)
    class_name: Mapped[Optional[str]] = mapped_column(String(256))
    method_name: Mapped[Optional[str]] = mapped_column(String(256))
    line_number: Mapped[Optional[int]] = mapped_column(Integer)
    source_file: Mapped[Optional[str]] = mapped_column(String(256))
    thread_name: Mapped[Optional[str]] = mapped_column(String(128))
    raw_json: Mapped[str] = mapped_column(Text)


class JvmInstanceRow(Base):
    __tablename__ = "jvm_instances"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    received_at: Mapped[str] = mapped_column(String(32))
    timestamp: Mapped[Optional[str]] = mapped_column(String(32))
    instance_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    project_id: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    deployment_id: Mapped[Optional[str]] = mapped_column(String(128), index=True)
    host_name: Mapped[Optional[str]] = mapped_column(String(256))
    jvm_version: Mapped[Optional[str]] = mapped_column(String(64))
    jvm_vendor: Mapped[Optional[str]] = mapped_column(String(128))
    os_name: Mapped[Optional[str]] = mapped_column(String(128))
    kubernetes: Mapped[Optional[bool]] = mapped_column(Boolean)
    raw_json: Mapped[str] = mapped_column(Text)


class ConfigEntityRow(Base):
    """Generic JSON store for UI-managed config (alert rules, integrations,
    redaction rules, API tokens, team members, workspace settings). Each row is
    one entity of a given ``table`` namespace, persisted as opaque JSON so the
    UI owns the shape."""

    __tablename__ = "config_entities"

    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    table: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[str] = mapped_column(String(32))
    json_data: Mapped[str] = mapped_column(Text)


_engine = create_async_engine(settings.db_url, future=True)
_Session = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _env_clause(environment: str):
    """Filter condition for an environment. 'production' also matches untagged
    rows (NULL/empty), mirroring the UI's default-to-production behavior."""
    if environment == "production":
        return or_(
            ExceptionRow.environment == "production",
            ExceptionRow.environment.is_(None),
            ExceptionRow.environment == "",
        )
    return ExceptionRow.environment == environment


def _apply_project(q, project_id: Optional[str], column):
    """Restrict a query to a tenant. ``project_id is None`` means 'no scoping'
    (the master key / superadmin sees every project)."""
    if project_id is None:
        return q
    return q.where(column == project_id)


async def init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def session() -> AsyncSession:
    return _Session()


async def store_exception(ev: ExceptionEvent, raw: dict[str, Any],
                          project_id: Optional[str] = None) -> int:
    loc = ev.location
    row = ExceptionRow(
        received_at=_now_iso(),
        timestamp=ev.timestamp,
        fingerprint=ev.fingerprint,
        capture_mode=ev.capture_mode,
        hit_count=ev.hit_count or 1,
        project_id=project_id,
        deployment_id=ev.deployment_id,
        environment=ev.environment,
        instance_id=ev.instance_id,
        exception_type=ev.exception_type,
        exception_message=ev.exception_message,
        caught=ev.caught,
        class_name=loc.class_name if loc else None,
        method_name=loc.method_name if loc else None,
        line_number=loc.line_number if loc else None,
        source_file=loc.source_file if loc else None,
        thread_name=ev.thread_info.name if ev.thread_info else None,
        raw_json=json.dumps(raw),
    )
    async with session() as s:
        s.add(row)
        await s.commit()
        return row.id


async def store_agent_start(ev: AgentStartEvent, raw: dict[str, Any],
                            project_id: Optional[str] = None) -> None:
    host = ev.host_info
    jvm = ev.jvm_info
    async with session() as s:
        existing = await s.scalar(
            select(JvmInstanceRow).where(JvmInstanceRow.instance_id == (ev.instance_id or ""))
        )
        if existing:
            existing.raw_json = json.dumps(raw)
            existing.timestamp = ev.timestamp
            existing.project_id = project_id
        else:
            s.add(JvmInstanceRow(
                received_at=_now_iso(),
                timestamp=ev.timestamp,
                instance_id=ev.instance_id or "",
                project_id=project_id,
                deployment_id=ev.deployment_id,
                host_name=host.name if host else None,
                jvm_version=jvm.version if jvm else None,
                jvm_vendor=jvm.vendor if jvm else None,
                os_name=host.os if host else None,
                kubernetes=host.kubernetes if host else None,
                raw_json=json.dumps(raw),
            ))
        await s.commit()


async def list_exceptions(*, limit: int, offset: int, exception_type: Optional[str],
                          deployment_id: Optional[str], caught: Optional[bool],
                          fingerprint: Optional[str],
                          environment: Optional[str] = None,
                          project_id: Optional[str] = None) -> tuple[list[dict], int]:
    cols = (
        ExceptionRow.id, ExceptionRow.received_at, ExceptionRow.timestamp,
        ExceptionRow.fingerprint, ExceptionRow.capture_mode, ExceptionRow.hit_count,
        ExceptionRow.deployment_id, ExceptionRow.environment, ExceptionRow.instance_id,
        ExceptionRow.exception_type, ExceptionRow.exception_message, ExceptionRow.caught,
        ExceptionRow.class_name, ExceptionRow.method_name, ExceptionRow.line_number,
        ExceptionRow.source_file, ExceptionRow.thread_name,
    )
    q = select(*cols).order_by(ExceptionRow.id.desc())
    cq = select(func.count()).select_from(ExceptionRow)
    q = _apply_project(q, project_id, ExceptionRow.project_id)
    cq = _apply_project(cq, project_id, ExceptionRow.project_id)
    if exception_type:
        q = q.where(ExceptionRow.exception_type == exception_type)
        cq = cq.where(ExceptionRow.exception_type == exception_type)
    if deployment_id:
        q = q.where(ExceptionRow.deployment_id == deployment_id)
        cq = cq.where(ExceptionRow.deployment_id == deployment_id)
    if environment:
        clause = _env_clause(environment)
        q = q.where(clause)
        cq = cq.where(clause)
    if caught is not None:
        q = q.where(ExceptionRow.caught == caught)
        cq = cq.where(ExceptionRow.caught == caught)
    if fingerprint:
        q = q.where(ExceptionRow.fingerprint == fingerprint)
        cq = cq.where(ExceptionRow.fingerprint == fingerprint)
    q = q.limit(limit).offset(offset)

    async with session() as s:
        rows = (await s.execute(q)).mappings().all()
        total = await s.scalar(cq) or 0
    return [dict(r) for r in rows], total


async def get_exception(exc_id: int, project_id: Optional[str] = None) -> Optional[dict]:
    async with session() as s:
        row = await s.get(ExceptionRow, exc_id)
        if not row:
            return None
        # Tenant isolation: a scoped caller can't read another project's row.
        if project_id is not None and row.project_id != project_id:
            return None
        return json.loads(row.raw_json)


async def delete_exception(exc_id: int, project_id: Optional[str] = None) -> bool:
    async with session() as s:
        row = await s.get(ExceptionRow, exc_id)
        if not row:
            return False
        if project_id is not None and row.project_id != project_id:
            return False
        await s.delete(row)
        await s.commit()
        return True


async def delete_all_exceptions(project_id: Optional[str] = None) -> int:
    async with session() as s:
        stmt = _apply_project(delete(ExceptionRow), project_id, ExceptionRow.project_id)
        result = await s.execute(stmt)
        await s.commit()
        return result.rowcount or 0


async def stats(project_id: Optional[str] = None) -> dict:
    def scoped(q):
        return _apply_project(q, project_id, ExceptionRow.project_id)

    async with session() as s:
        total = await s.scalar(scoped(select(func.count()).select_from(ExceptionRow))) or 0
        unique = await s.scalar(scoped(
            select(func.count(func.distinct(ExceptionRow.fingerprint))))) or 0
        uncaught = await s.scalar(scoped(
            select(func.count()).select_from(ExceptionRow).where(ExceptionRow.caught.is_(False)))) or 0
        deployments = await s.scalar(scoped(
            select(func.count(func.distinct(ExceptionRow.deployment_id))))) or 0

        top_rows = (await s.execute(scoped(
            select(ExceptionRow.exception_type, func.count().label("c"))
            .group_by(ExceptionRow.exception_type)
            .order_by(func.count().desc())
            .limit(10)
        ))).all()
        recent_dep = (await s.execute(_apply_project(
            select(JvmInstanceRow.deployment_id, func.max(JvmInstanceRow.received_at))
            .group_by(JvmInstanceRow.deployment_id)
            .order_by(func.max(JvmInstanceRow.received_at).desc())
            .limit(10), project_id, JvmInstanceRow.project_id
        ))).all()
    return {
        "totalExceptions": total,
        "uniqueFingerprints": unique,
        "uncaught": uncaught,
        "deployments": deployments,
        "topTypes": [{"type": t or "unknown", "count": c} for t, c in top_rows],
        "recentDeployments": [
            {"deployment": d or "(none)", "lastSeen": ts} for d, ts in recent_dep
        ],
    }


async def timeseries(*, hours: int, buckets: int,
                     environment: Optional[str] = None,
                     project_id: Optional[str] = None) -> dict:
    """Bucket exception counts over the last `hours` into `buckets` slots,
    split by caught vs uncaught. Buckets by collector receive time."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    start_iso = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    start_ts = start.timestamp()
    bucket_s = max(1.0, (hours * 3600.0) / buckets)

    q = select(ExceptionRow.received_at, ExceptionRow.caught).where(
        ExceptionRow.received_at >= start_iso)
    if environment:
        q = q.where(_env_clause(environment))
    q = _apply_project(q, project_id, ExceptionRow.project_id)

    series = [
        {"t": int((start_ts + i * bucket_s) * 1000), "caught": 0, "uncaught": 0}
        for i in range(buckets)
    ]
    async with session() as s:
        rows = (await s.execute(q)).all()
    for received_at, caught in rows:
        try:
            t = datetime.strptime(received_at, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc).timestamp()
        except (ValueError, TypeError):
            continue
        idx = int((t - start_ts) / bucket_s)
        idx = 0 if idx < 0 else (buckets - 1 if idx >= buckets else idx)
        series[idx]["caught" if caught else "uncaught"] += 1
    return {"hours": hours, "buckets": buckets, "series": series}


async def event_series(*, hours: int, buckets: int,
                       environment: Optional[str] = None,
                       project_id: Optional[str] = None) -> dict:
    """Per-fingerprint bucketed occurrence counts over the last `hours`.

    Returns, for every fingerprint seen in the window, its total occurrences
    (summed `hit_count`) and a per-bucket array. This is the real data behind the
    dashboard's per-event hit counts, sparklines, and rising/falling trend — no
    client-side fabrication. Buckets by collector receive time."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    start_iso = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    start_ts = start.timestamp()
    bucket_s = max(1.0, (hours * 3600.0) / buckets)

    q = select(
        ExceptionRow.received_at, ExceptionRow.fingerprint, ExceptionRow.hit_count,
    ).where(ExceptionRow.received_at >= start_iso)
    if environment:
        q = q.where(_env_clause(environment))
    q = _apply_project(q, project_id, ExceptionRow.project_id)

    async with session() as s:
        rows = (await s.execute(q)).all()

    series: dict[str, dict] = {}
    for received_at, fingerprint, hit_count in rows:
        if not fingerprint:
            continue
        try:
            t = datetime.strptime(received_at, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc).timestamp()
        except (ValueError, TypeError):
            continue
        idx = int((t - start_ts) / bucket_s)
        idx = 0 if idx < 0 else (buckets - 1 if idx >= buckets else idx)
        entry = series.get(fingerprint)
        if entry is None:
            entry = {"total": 0, "buckets": [0] * buckets}
            series[fingerprint] = entry
        h = hit_count or 1
        entry["total"] += h
        entry["buckets"][idx] += h

    return {
        "hours": hours,
        "buckets": buckets,
        "start": int(start_ts * 1000),
        "bucket_ms": int(bucket_s * 1000),
        "series": series,
    }


async def count_occurrences(*, minutes: int, deployment_id: Optional[str] = None,
                            fingerprint: Optional[str] = None,
                            exception_type: Optional[str] = None,
                            environment: Optional[str] = None,
                            project_id: Optional[str] = None) -> int:
    """Sum `hit_count` over the last `minutes`, optionally scoped. Used by the
    alert engine's volume-threshold evaluation."""
    start = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    start_iso = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    q = select(func.coalesce(func.sum(ExceptionRow.hit_count), 0)).where(
        ExceptionRow.received_at >= start_iso)
    if deployment_id:
        q = q.where(ExceptionRow.deployment_id == deployment_id)
    if fingerprint:
        q = q.where(ExceptionRow.fingerprint == fingerprint)
    if exception_type:
        q = q.where(ExceptionRow.exception_type == exception_type)
    if environment:
        q = q.where(_env_clause(environment))
    q = _apply_project(q, project_id, ExceptionRow.project_id)
    async with session() as s:
        return int(await s.scalar(q) or 0)


async def fingerprint_row_count(fingerprint: str,
                                project_id: Optional[str] = None) -> int:
    """How many stored rows share this fingerprint (1 == first-ever occurrence)
    within the tenant. Lets the alert engine detect genuinely new exception
    classes per project."""
    q = select(func.count()).select_from(ExceptionRow).where(
        ExceptionRow.fingerprint == fingerprint)
    q = _apply_project(q, project_id, ExceptionRow.project_id)
    async with session() as s:
        return int(await s.scalar(q) or 0)


async def list_instances(project_id: Optional[str] = None) -> list[dict]:
    q = _apply_project(
        select(JvmInstanceRow).order_by(JvmInstanceRow.id.desc()),
        project_id, JvmInstanceRow.project_id)
    async with session() as s:
        rows = (await s.execute(q)).scalars().all()
    return [json.loads(r.raw_json) for r in rows]


async def get_instance(instance_id: str,
                       project_id: Optional[str] = None) -> Optional[dict]:
    async with session() as s:
        row = await s.scalar(
            select(JvmInstanceRow).where(JvmInstanceRow.instance_id == instance_id))
        if not row:
            return None
        if project_id is not None and row.project_id != project_id:
            return None
        return json.loads(row.raw_json)


import uuid

# Namespaces the UI is allowed to manage via the generic config API.
CONFIG_TABLES = frozenset({
    "alert_rules",
    "integrations",
    "redaction_rules",
    "api_tokens",
    "team_members",
    "workspace_settings",
    "projects",
})


def _config_to_dict(row: ConfigEntityRow) -> dict:
    data = json.loads(row.json_data)
    data["id"] = row.entity_id
    data.setdefault("created_at", row.created_at)
    return data


async def list_config(table: str) -> list[dict]:
    async with session() as s:
        rows = (await s.execute(
            select(ConfigEntityRow)
            .where(ConfigEntityRow.table == table)
            .order_by(ConfigEntityRow.pk.asc())
        )).scalars().all()
    return [_config_to_dict(r) for r in rows]


async def insert_config(table: str, payload: dict) -> dict:
    entity_id = str(payload.get("id") or uuid.uuid4())
    created_at = str(payload.get("created_at") or _now_iso())
    data = {k: v for k, v in payload.items() if k != "id"}
    data["created_at"] = created_at
    async with session() as s:
        s.add(ConfigEntityRow(
            table=table,
            entity_id=entity_id,
            created_at=created_at,
            json_data=json.dumps(data),
        ))
        await s.commit()
    out = dict(data)
    out["id"] = entity_id
    return out


async def update_config(table: str, entity_id: str, patch: dict) -> Optional[dict]:
    async with session() as s:
        row = await s.scalar(
            select(ConfigEntityRow).where(
                ConfigEntityRow.table == table,
                ConfigEntityRow.entity_id == entity_id,
            ))
        if not row:
            return None
        data = json.loads(row.json_data)
        for k, v in patch.items():
            if k != "id":
                data[k] = v
        row.json_data = json.dumps(data)
        await s.commit()
        return _config_to_dict(row)


async def delete_config(table: str, entity_id: str) -> bool:
    async with session() as s:
        row = await s.scalar(
            select(ConfigEntityRow).where(
                ConfigEntityRow.table == table,
                ConfigEntityRow.entity_id == entity_id,
            ))
        if not row:
            return False
        await s.delete(row)
        await s.commit()
        return True


async def purge_old_records() -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=settings.retention_days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    async with session() as s:
        result = await s.execute(
            delete(ExceptionRow).where(ExceptionRow.received_at < cutoff))
        await s.commit()
        return result.rowcount or 0

"""Async SQLAlchemy storage: two tables plus CRUD/stat helpers."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import (
    Boolean, Integer, String, Text, delete, event, func, or_, select, text,
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
    # Cumulative lifetime occurrence counter for the fingerprint, as reported by
    # the agent at capture time ("this was the Nth hit"). Display only.
    hit_count: Mapped[int] = mapped_column(Integer, default=1)
    # How many real throws this row represents (1 for normal events; >1 for the
    # agent's aggregated COUNT_ONLY summaries). SUM this for volume/series.
    occurrences: Mapped[int] = mapped_column(Integer, default=1)
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


class SourceClassRow(Base):
    """Original class-file bytes of an app class (base64), shipped by the agent
    so the collector can decompile it on demand for the dashboard source view.
    One row per (project, class). Stored as opaque base64 text."""

    __tablename__ = "source_classes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    class_name: Mapped[str] = mapped_column(String(256), index=True)  # slash form
    received_at: Mapped[str] = mapped_column(String(32))
    bytecode_b64: Mapped[str] = mapped_column(Text)


class ConfigEntityRow(Base):
    """Generic JSON store for UI-managed config (alert rules, integrations,
    redaction rules, API tokens, team members, workspace settings). Each row is
    one entity of a given ``table`` namespace, persisted as opaque JSON so the
    UI owns the shape."""

    __tablename__ = "config_entities"

    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    table: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[str] = mapped_column(String(64), index=True)
    # Tenant that owns this config row (NULL = the default project / master).
    # api_tokens rows are read globally for auth but listed per-project in the UI.
    project_id: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    created_at: Mapped[str] = mapped_column(String(32))
    json_data: Mapped[str] = mapped_column(Text)


# COLLECTOR_DB_POOL=null disables connection pooling (a fresh connection per
# checkout). Required when sessions are used from multiple event loops — e.g.
# the test suite drives some operations on ad-hoc loops — because pooled
# asyncpg connections are bound to the loop that created them and awaiting one
# from another loop deadlocks. Production (one loop) keeps the default pool.
import os as _os
_engine_kwargs: dict = {}
if _os.environ.get("COLLECTOR_DB_POOL", "").lower() == "null":
    from sqlalchemy.pool import NullPool
    _engine_kwargs["poolclass"] = NullPool

_engine = create_async_engine(settings.db_url, future=True, **_engine_kwargs)
_Session = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)

if _engine.dialect.name == "sqlite":
    # WAL lets readers proceed during writes (dashboard queries vs. ingest);
    # busy_timeout retries briefly instead of surfacing "database is locked";
    # synchronous=NORMAL is the recommended WAL fsync level (durable to app
    # crash; the OS-crash window is acceptable for telemetry).
    @event.listens_for(_engine.sync_engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()


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


# Hot-path indexes. Issued as explicit IF NOT EXISTS DDL because
# metadata.create_all() skips tables that already exist, so new indexes (and
# the occurrences column below) would never reach databases created by older
# builds. Works on both SQLite and Postgres.
_INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS ix_exceptions_received_at "
    "ON exceptions (received_at)",
    "CREATE INDEX IF NOT EXISTS ix_exceptions_project_received "
    "ON exceptions (project_id, received_at)",
    "CREATE INDEX IF NOT EXISTS ix_exceptions_fingerprint_received "
    "ON exceptions (fingerprint, received_at)",
)


async def init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # Mini-migration for databases created before the occurrences column, in
    # its own transaction: on Postgres a failed statement poisons the whole
    # transaction, which must not take create_all/index DDL down with it.
    try:
        async with _engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE exceptions ADD COLUMN occurrences INTEGER"))
    except Exception:
        pass  # column already exists
    async with _engine.begin() as conn:
        for ddl in _INDEX_DDL:
            await conn.execute(text(ddl))


def session() -> AsyncSession:
    return _Session()


def _exception_row(ev: ExceptionEvent, raw: dict[str, Any],
                   project_id: Optional[str]) -> ExceptionRow:
    loc = ev.location
    return ExceptionRow(
        received_at=_now_iso(),
        timestamp=ev.timestamp,
        fingerprint=ev.fingerprint,
        capture_mode=ev.capture_mode,
        hit_count=ev.hit_count or 1,
        occurrences=ev.occurrences or 1,
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


async def store_exception(ev: ExceptionEvent, raw: dict[str, Any],
                          project_id: Optional[str] = None) -> int:
    ids = await store_exceptions([(ev, raw)], project_id)
    return ids[0]


async def store_exceptions(events: list[tuple[ExceptionEvent, dict[str, Any]]],
                           project_id: Optional[str] = None) -> list[int]:
    """Persist a batch of exception events in ONE transaction. Agents deliver
    batches; committing per event would fsync per event and cap ingest at a few
    hundred rows/second on SQLite. Also touches the senders' instance rows
    (received_at = last activity) so long-running JVMs that registered once and
    kept sending are never evicted as stale."""
    now = _now_iso()
    rows = [_exception_row(ev, raw, project_id) for ev, raw in events]
    instance_ids = {ev.instance_id for ev, _raw in events if ev.instance_id}
    async with session() as s:
        s.add_all(rows)
        if instance_ids:
            from sqlalchemy import update
            await s.execute(
                update(JvmInstanceRow)
                .where(JvmInstanceRow.instance_id.in_(instance_ids))
                .values(received_at=now))
        await s.commit()
        return [row.id for row in rows]


async def store_agent_start(ev: AgentStartEvent, raw: dict[str, Any],
                            project_id: Optional[str] = None) -> None:
    host = ev.host_info
    jvm = ev.jvm_info
    async with session() as s:
        existing = await s.scalar(
            select(JvmInstanceRow).where(
                JvmInstanceRow.instance_id == (ev.instance_id or ""))
        )
        if existing:
            # Tenant isolation: instance_id is agent-self-reported (trivially
            # forgeable), so a scoped token may only refresh a row its own
            # project registered — anything else would let one tenant
            # overwrite/steal another tenant's instance record. The master key
            # may refresh any row but never reassigns its project.
            if project_id is not None and existing.project_id != project_id:
                raise PermissionError(
                    f"instance_id {ev.instance_id!r} is registered to another "
                    "project; refusing cross-tenant re-registration")
            existing.raw_json = json.dumps(raw)
            existing.timestamp = ev.timestamp
            existing.received_at = _now_iso()  # last-seen, drives staleness eviction
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


async def delete_all_instances(project_id: Optional[str] = None) -> int:
    async with session() as s:
        stmt = _apply_project(
            delete(JvmInstanceRow), project_id, JvmInstanceRow.project_id)
        result = await s.execute(stmt)
        await s.commit()
        return result.rowcount or 0


async def delete_all_source_classes(project_id: Optional[str] = None) -> int:
    async with session() as s:
        stmt = _apply_project(
            delete(SourceClassRow), project_id, SourceClassRow.project_id)
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


# Aggregation granularity for the chart endpoints: rows are grouped in SQL by a
# received_at prefix — "YYYY-MM-DDTHH:MM" (len 16, minute) for coarse buckets or
# "…:SS" (len 19, second) for sub-minute ones — so a chart transfers O(groups)
# rows instead of O(events). substr() works on both SQLite and Postgres.
def _group_key(bucket_s: float):
    gran = 19 if bucket_s < 60.0 else 16
    return gran, func.substr(ExceptionRow.received_at, 1, gran)


def _parse_group_key(key: str, gran: int) -> Optional[float]:
    fmt = "%Y-%m-%dT%H:%M:%S" if gran == 19 else "%Y-%m-%dT%H:%M"
    try:
        return datetime.strptime(key, fmt).replace(tzinfo=timezone.utc).timestamp()
    except (ValueError, TypeError):
        return None


# One stored row can represent several real throws (aggregated COUNT_ONLY
# summaries carry occurrences > 1); NULL means a pre-migration row (= 1).
_OCC = func.coalesce(ExceptionRow.occurrences, 1)


async def timeseries(*, hours: int, buckets: int,
                     environment: Optional[str] = None,
                     project_id: Optional[str] = None) -> dict:
    """Bucket exception counts over the last `hours` into `buckets` slots,
    split by caught vs uncaught. Buckets by collector receive time; counts are
    aggregated in SQL (see _group_key)."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    start_iso = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    start_ts = start.timestamp()
    bucket_s = max(1.0, (hours * 3600.0) / buckets)

    gran, key = _group_key(bucket_s)
    q = (select(key.label("k"), ExceptionRow.caught,
                func.sum(_OCC).label("n"))
         .where(ExceptionRow.received_at >= start_iso)
         .group_by(key, ExceptionRow.caught))
    if environment:
        q = q.where(_env_clause(environment))
    q = _apply_project(q, project_id, ExceptionRow.project_id)

    series = [
        {"t": int((start_ts + i * bucket_s) * 1000), "caught": 0, "uncaught": 0}
        for i in range(buckets)
    ]
    async with session() as s:
        rows = (await s.execute(q)).all()
    for k, caught, n in rows:
        t = _parse_group_key(k, gran)
        if t is None:
            continue
        idx = int((t - start_ts) / bucket_s)
        idx = 0 if idx < 0 else (buckets - 1 if idx >= buckets else idx)
        series[idx]["caught" if caught else "uncaught"] += int(n or 0)
    return {"hours": hours, "buckets": buckets, "series": series}


async def event_series(*, hours: int, buckets: int,
                       environment: Optional[str] = None,
                       project_id: Optional[str] = None) -> dict:
    """Per-fingerprint bucketed occurrence counts over the last `hours`.

    Returns, for every fingerprint seen in the window, its total occurrences and
    a per-bucket array, aggregated in SQL (see _group_key). Occurrence counts
    SUM the rows' `occurrences` (1 per normal event; >1 for agent-aggregated
    COUNT_ONLY summaries) — never `hit_count`, which is a *cumulative* lifetime
    display counter. This is the real data behind the dashboard's per-event hit
    counts, sparklines, and rising/falling trend — no client-side fabrication.
    Buckets by collector receive time."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    start_iso = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    start_ts = start.timestamp()
    bucket_s = max(1.0, (hours * 3600.0) / buckets)

    gran, key = _group_key(bucket_s)
    q = (select(ExceptionRow.fingerprint, key.label("k"),
                func.sum(_OCC).label("n"))
         .where(ExceptionRow.received_at >= start_iso)
         .group_by(ExceptionRow.fingerprint, key))
    if environment:
        q = q.where(_env_clause(environment))
    q = _apply_project(q, project_id, ExceptionRow.project_id)

    async with session() as s:
        rows = (await s.execute(q)).all()

    series: dict[str, dict] = {}
    for fingerprint, k, n in rows:
        if not fingerprint:
            continue
        t = _parse_group_key(k, gran)
        if t is None:
            continue
        idx = int((t - start_ts) / bucket_s)
        idx = 0 if idx < 0 else (buckets - 1 if idx >= buckets else idx)
        entry = series.get(fingerprint)
        if entry is None:
            entry = {"total": 0, "buckets": [0] * buckets}
            series[fingerprint] = entry
        count = int(n or 0)
        entry["total"] += count
        entry["buckets"][idx] += count

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
    """Count occurrences over the last `minutes`, optionally scoped. Used by the
    alert engine's volume-threshold evaluation. Sums the rows' `occurrences`
    (1 per normal event; >1 for aggregated COUNT_ONLY summaries); the rows'
    `hit_count` is a cumulative lifetime counter (display only) and must never
    be summed."""
    start = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    start_iso = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    q = select(func.coalesce(func.sum(_OCC), 0)).where(
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


async def store_source_class(project_id: Optional[str], class_name: str,
                             bytecode_b64: str) -> None:
    """Upsert the bytecode for one app class (slash name) within a project."""
    if not class_name or not bytecode_b64:
        return
    async with session() as s:
        q = select(SourceClassRow).where(SourceClassRow.class_name == class_name)
        q = _apply_project(q, project_id, SourceClassRow.project_id)
        existing = await s.scalar(q)
        if existing:
            existing.bytecode_b64 = bytecode_b64
            existing.received_at = _now_iso()
        else:
            s.add(SourceClassRow(
                project_id=project_id,
                class_name=class_name,
                received_at=_now_iso(),
                bytecode_b64=bytecode_b64,
            ))
        await s.commit()


async def get_source_class(class_name: str,
                           project_id: Optional[str] = None) -> Optional[str]:
    """Return the base64 bytecode for a class (slash name) in the tenant, or None."""
    q = select(SourceClassRow.bytecode_b64).where(
        SourceClassRow.class_name == class_name)
    q = _apply_project(q, project_id, SourceClassRow.project_id)
    async with session() as s:
        return await s.scalar(q)


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
    data["project_id"] = row.project_id
    data.setdefault("created_at", row.created_at)
    return data


async def list_config(table: str, *, project_id: Optional[str] = None,
                      all_projects: bool = False) -> list[dict]:
    """List config rows for a table. ``all_projects`` (master key / auth) returns
    every tenant's rows; otherwise only those owned by ``project_id`` (NULL rows
    for the default project)."""
    q = (select(ConfigEntityRow)
         .where(ConfigEntityRow.table == table)
         .order_by(ConfigEntityRow.pk.asc()))
    if not all_projects:
        q = q.where(ConfigEntityRow.project_id == project_id)
    async with session() as s:
        rows = (await s.execute(q)).scalars().all()
    return [_config_to_dict(r) for r in rows]


async def insert_config(table: str, payload: dict, *,
                        project_id: Optional[str] = None) -> dict:
    entity_id = str(payload.get("id") or uuid.uuid4())
    created_at = str(payload.get("created_at") or _now_iso())
    data = {k: v for k, v in payload.items() if k not in ("id", "project_id")}
    data["created_at"] = created_at
    async with session() as s:
        s.add(ConfigEntityRow(
            table=table,
            entity_id=entity_id,
            project_id=project_id,
            created_at=created_at,
            json_data=json.dumps(data),
        ))
        await s.commit()
    out = dict(data)
    out["id"] = entity_id
    out["project_id"] = project_id
    return out


async def _find_config(s, table: str, entity_id: str,
                       project_id: Optional[str], all_projects: bool):
    q = select(ConfigEntityRow).where(
        ConfigEntityRow.table == table,
        ConfigEntityRow.entity_id == entity_id,
    )
    if not all_projects:
        q = q.where(ConfigEntityRow.project_id == project_id)
    return await s.scalar(q)


async def update_config(table: str, entity_id: str, patch: dict, *,
                        project_id: Optional[str] = None,
                        all_projects: bool = False) -> Optional[dict]:
    async with session() as s:
        row = await _find_config(s, table, entity_id, project_id, all_projects)
        if not row:
            return None
        data = json.loads(row.json_data)
        for k, v in patch.items():
            if k not in ("id", "project_id"):
                data[k] = v
        row.json_data = json.dumps(data)
        await s.commit()
        return _config_to_dict(row)


async def delete_config(table: str, entity_id: str, *,
                        project_id: Optional[str] = None,
                        all_projects: bool = False) -> bool:
    async with session() as s:
        row = await _find_config(s, table, entity_id, project_id, all_projects)
        if not row:
            return False
        await s.delete(row)
        await s.commit()
        return True


async def purge_old_records(*, vacuum_threshold: int = 10_000) -> int:
    """Delete exception rows older than the retention window, evict JVM
    instances with no activity in twice the window (received_at is refreshed on
    every re-registration and on every ingested event from that instance), and
    reclaim SQLite file space when a purge removed enough rows to matter
    (deletes alone never shrink an SQLite file)."""
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=settings.retention_days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    instance_cutoff = (now - timedelta(days=2 * settings.retention_days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    async with session() as s:
        result = await s.execute(
            delete(ExceptionRow).where(ExceptionRow.received_at < cutoff))
        await s.execute(
            delete(JvmInstanceRow).where(JvmInstanceRow.received_at < instance_cutoff))
        await s.commit()
        purged = result.rowcount or 0

    if purged >= vacuum_threshold and _engine.dialect.name == "sqlite":
        # VACUUM cannot run inside a transaction; use an autocommit connection.
        async with _engine.connect() as conn:
            auto = await conn.execution_options(isolation_level="AUTOCOMMIT")
            await auto.execute(text("VACUUM"))
    return purged

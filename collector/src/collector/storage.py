"""Async SQLAlchemy storage: two tables plus CRUD/stat helpers."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import (
    Boolean, Integer, String, Text, delete, func, select,
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
    deployment_id: Mapped[Optional[str]] = mapped_column(String(128), index=True)
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


async def init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def session() -> AsyncSession:
    return _Session()


async def store_exception(ev: ExceptionEvent, raw: dict[str, Any]) -> int:
    loc = ev.location
    row = ExceptionRow(
        received_at=_now_iso(),
        timestamp=ev.timestamp,
        fingerprint=ev.fingerprint,
        capture_mode=ev.capture_mode,
        hit_count=ev.hit_count or 1,
        deployment_id=ev.deployment_id,
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


async def store_agent_start(ev: AgentStartEvent, raw: dict[str, Any]) -> None:
    host = ev.host_info
    jvm = ev.jvm_info
    async with session() as s:
        existing = await s.scalar(
            select(JvmInstanceRow).where(JvmInstanceRow.instance_id == (ev.instance_id or ""))
        )
        if existing:
            existing.raw_json = json.dumps(raw)
            existing.timestamp = ev.timestamp
        else:
            s.add(JvmInstanceRow(
                received_at=_now_iso(),
                timestamp=ev.timestamp,
                instance_id=ev.instance_id or "",
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
                          fingerprint: Optional[str]) -> tuple[list[dict], int]:
    cols = (
        ExceptionRow.id, ExceptionRow.received_at, ExceptionRow.timestamp,
        ExceptionRow.fingerprint, ExceptionRow.capture_mode, ExceptionRow.hit_count,
        ExceptionRow.deployment_id, ExceptionRow.instance_id, ExceptionRow.exception_type,
        ExceptionRow.exception_message, ExceptionRow.caught, ExceptionRow.class_name,
        ExceptionRow.method_name, ExceptionRow.line_number, ExceptionRow.source_file,
        ExceptionRow.thread_name,
    )
    q = select(*cols).order_by(ExceptionRow.id.desc())
    cq = select(func.count()).select_from(ExceptionRow)
    if exception_type:
        q = q.where(ExceptionRow.exception_type == exception_type)
        cq = cq.where(ExceptionRow.exception_type == exception_type)
    if deployment_id:
        q = q.where(ExceptionRow.deployment_id == deployment_id)
        cq = cq.where(ExceptionRow.deployment_id == deployment_id)
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


async def get_exception(exc_id: int) -> Optional[dict]:
    async with session() as s:
        row = await s.get(ExceptionRow, exc_id)
        if not row:
            return None
        return json.loads(row.raw_json)


async def delete_exception(exc_id: int) -> bool:
    async with session() as s:
        row = await s.get(ExceptionRow, exc_id)
        if not row:
            return False
        await s.delete(row)
        await s.commit()
        return True


async def delete_all_exceptions() -> int:
    async with session() as s:
        result = await s.execute(delete(ExceptionRow))
        await s.commit()
        return result.rowcount or 0


async def stats() -> dict:
    async with session() as s:
        total = await s.scalar(select(func.count()).select_from(ExceptionRow)) or 0
        unique = await s.scalar(
            select(func.count(func.distinct(ExceptionRow.fingerprint)))) or 0
        uncaught = await s.scalar(
            select(func.count()).select_from(ExceptionRow).where(ExceptionRow.caught.is_(False))) or 0
        deployments = await s.scalar(
            select(func.count(func.distinct(ExceptionRow.deployment_id)))) or 0

        top_rows = (await s.execute(
            select(ExceptionRow.exception_type, func.count().label("c"))
            .group_by(ExceptionRow.exception_type)
            .order_by(func.count().desc())
            .limit(10)
        )).all()
        recent_dep = (await s.execute(
            select(JvmInstanceRow.deployment_id, func.max(JvmInstanceRow.received_at))
            .group_by(JvmInstanceRow.deployment_id)
            .order_by(func.max(JvmInstanceRow.received_at).desc())
            .limit(10)
        )).all()
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


async def list_instances() -> list[dict]:
    async with session() as s:
        rows = (await s.execute(
            select(JvmInstanceRow).order_by(JvmInstanceRow.id.desc()))).scalars().all()
    return [json.loads(r.raw_json) for r in rows]


async def get_instance(instance_id: str) -> Optional[dict]:
    async with session() as s:
        row = await s.scalar(
            select(JvmInstanceRow).where(JvmInstanceRow.instance_id == instance_id))
        return json.loads(row.raw_json) if row else None


import uuid

# Namespaces the UI is allowed to manage via the generic config API.
CONFIG_TABLES = frozenset({
    "alert_rules",
    "integrations",
    "redaction_rules",
    "api_tokens",
    "team_members",
    "workspace_settings",
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

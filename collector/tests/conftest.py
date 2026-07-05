"""Shared pytest fixtures.

Environment must be configured *before* the collector package is imported,
because `config.Settings.from_env()` runs at import time and is frozen.
"""
from __future__ import annotations

import asyncio
import os
import tempfile

# A throwaway on-disk SQLite DB and a known API key for the whole test session.
# setdefault so CI can point the suite at Postgres via COLLECTOR_DB_URL.
_DB_FD, _DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_DB_FD)
os.environ.setdefault("COLLECTOR_DB_URL", f"sqlite+aiosqlite:///{_DB_PATH}")
os.environ["COLLECTOR_API_KEY"] = "test-key"
os.environ.setdefault("COLLECTOR_PURGE_INTERVAL_SECONDS", "0")  # no background task in tests
# Alert tests stub httpx and use fake hostnames; skip the SSRF DNS check here
# (the guard itself is unit-tested with a patched settings object).
os.environ.setdefault("COLLECTOR_ALERT_ALLOW_PRIVATE", "1")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from collector.app import app  # noqa: E402
from collector import storage  # noqa: E402

API_KEY = "test-key"
AUTH = {"Authorization": f"Bearer {API_KEY}"}


@pytest.fixture(scope="session")
def client():
    # Context-manager form runs the lifespan (init_db, etc.).
    with TestClient(app) as c:
        yield c


def run_async(coro):
    """Run a coroutine to completion on a fresh event loop (test helper)."""
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _clean_tables(client):
    """Wipe tables + reset the redaction cache before each test for isolation."""
    async def _wipe():
        from sqlalchemy import delete
        async with storage.session() as s:
            await s.execute(delete(storage.ExceptionRow))
            await s.execute(delete(storage.JvmInstanceRow))
            await s.execute(delete(storage.ConfigEntityRow))
            await s.commit()

    run_async(_wipe())
    from collector.api import routes
    from collector import security, alerts
    routes.redaction_cache.reset()
    security.token_store.reset()
    alerts.rule_cache.reset()
    yield


def exception_event(**overrides) -> dict:
    ev = {
        "timestamp": "2026-06-20T10:00:00Z",
        "fingerprint": 1234567890,  # int on the wire; collector coerces to str
        "captureMode": "FULL",
        "exceptionType": "java/lang/NullPointerException",
        "exceptionMessage": "boom",
        "caught": False,
        "location": {
            "className": "com/example/Service",
            "methodName": "doWork",
            "lineNumber": 42,
            "sourceFile": "Service.java",
        },
        "threadInfo": {"name": "main", "priority": 5, "isDaemon": False},
    }
    ev.update(overrides)
    return ev


def agent_start_event(**overrides) -> dict:
    ev = {
        "type": "agent_start",
        "timestamp": "2026-06-20T09:59:00Z",
        "instanceId": "inst-1",
        "deploymentId": "demo",
        "jvmInfo": {"version": "26", "vendor": "Eclipse Adoptium"},
        "hostInfo": {"name": "host-1", "os": "Linux", "kubernetes": False},
    }
    ev.update(overrides)
    return ev

"""FastAPI application: lifespan init, CORS, routes, and static UI mount."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse, Response

from . import storage
from .api.routes import public_router, router
from .config import settings

log = logging.getLogger("collector")

# The repo root: collector/src/collector/app.py -> ../../..
_REPO_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)


def _resolve_ui_dir() -> str:
    """Locate the directory to serve the dashboard from.

    Prefers the React SPA build (`frontend/dist/client`, containing
    `_shell.html`); falls back to the legacy static `ui/`. Override with
    `COLLECTOR_UI_DIR`.
    """
    override = os.environ.get("COLLECTOR_UI_DIR")
    if override:
        return os.path.normpath(override)
    spa = os.path.join(_REPO_ROOT, "frontend", "dist", "client")
    if os.path.isfile(os.path.join(spa, "_shell.html")):
        return spa
    return os.path.join(_REPO_ROOT, "ui")


async def _periodic_purge() -> None:
    """Run retention purge on an interval so long-lived instances stay bounded."""
    interval = settings.purge_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            purged = await storage.purge_old_records()
            if purged:
                log.info("purged %d records older than retention", purged)
        except Exception:  # never let the background task die
            log.exception("periodic purge failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(
        level=os.environ.get("COLLECTOR_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if not settings.auth_enabled:
        log.warning(
            "COLLECTOR_API_KEY is not set - all endpoints are UNAUTHENTICATED. "
            "Set COLLECTOR_API_KEY before exposing the collector beyond localhost."
        )
    await storage.init_db()
    purged = await storage.purge_old_records()
    if purged:
        log.info("purged %d records older than retention", purged)

    task: asyncio.Task | None = None
    if settings.purge_interval_seconds > 0:
        task = asyncio.create_task(_periodic_purge())
    try:
        yield
    finally:
        if task is not None:
            task.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title="JVMTI Exception Collector", lifespan=lifespan)

    # CORS: only enable when explicit origins are configured. The dashboard is
    # served same-origin and needs no CORS; a wildcard with credentials is unsafe.
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "X-API-Key", "Content-Type"],
        )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response: Response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    app.include_router(public_router)
    app.include_router(router)

    ui_dir = _resolve_ui_dir()
    shell = os.path.join(ui_dir, "_shell.html")
    if os.path.isfile(shell):
        # SPA build: serve hashed assets directly and fall back to the shell for
        # client-side routes (e.g. /dashboard, /events/123) so deep links work.
        assets_dir = os.path.join(ui_dir, "assets")
        if os.path.isdir(assets_dir):
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str) -> FileResponse:
            candidate = os.path.normpath(os.path.join(ui_dir, full_path))
            if (
                full_path
                and candidate.startswith(ui_dir)
                and os.path.isfile(candidate)
            ):
                return FileResponse(candidate)
            return FileResponse(shell)

        log.info("serving SPA dashboard from %s", ui_dir)
    elif os.path.isdir(ui_dir):
        app.mount("/", StaticFiles(directory=ui_dir, html=True), name="ui")
        log.info("serving static dashboard from %s", ui_dir)
    return app


app = create_app()

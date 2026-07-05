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

from . import alerts, storage
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


def _build_csp() -> str | None:
    """Construct the Content-Security-Policy for the dashboard. Override entirely
    with ``COLLECTOR_CSP`` (set it empty to disable).

    ``script-src`` allows ``'unsafe-inline'`` because the TanStack Start SPA
    injects inline bootstrap/hydration scripts at runtime (router-state
    streaming) that can't be statically hashed or nonced from a plain static
    file server. The policy still blocks external script origins and ``eval``
    (no ``'unsafe-eval'``), and keeps default-src/object-src/frame-ancestors/
    connect-src locked down.

    NOTE: if the dashboard is configured to reach a *cross-origin* collector
    (``VITE_COLLECTOR_URL``), set ``COLLECTOR_CSP`` to add that origin to
    ``connect-src`` — the default only permits same-origin.
    """
    override = os.environ.get("COLLECTOR_CSP")
    if override is not None:
        return override.strip() or None

    return "; ".join([
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "font-src 'self' https://fonts.gstatic.com data:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self' ws: wss:",
        "form-action 'self'",
    ])


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
            "COLLECTOR_ALLOW_ANONYMOUS is set - all endpoints are "
            "UNAUTHENTICATED. Only safe on a trusted local network."
        )
    await storage.init_db()
    if not settings.api_key and not settings.allow_anonymous:
        # Auth is on but no master key is configured: bootstrap a master token
        # on first start so the collector never silently runs open.
        from .security import ensure_bootstrap_admin_token
        raw = await ensure_bootstrap_admin_token()
        if raw is not None:
            log.warning(
                "No COLLECTOR_API_KEY set and no tokens exist - generated a "
                "master token (shown ONCE, store it now):\n\n"
                "    %s\n\n"
                "Use it as the dashboard/API key and to mint scoped tokens. "
                "To run unauthenticated instead, set COLLECTOR_ALLOW_ANONYMOUS=1.",
                raw,
            )
    purged = await storage.purge_old_records()
    if purged:
        log.info("purged %d records older than retention", purged)

    alerts.start_worker()
    task: asyncio.Task | None = None
    if settings.purge_interval_seconds > 0:
        task = asyncio.create_task(_periodic_purge())
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
        await alerts.stop_worker()


def create_app() -> FastAPI:
    app = FastAPI(title="JVMTI Exception Collector", lifespan=lifespan)

    ui_dir = _resolve_ui_dir()
    shell = os.path.join(ui_dir, "_shell.html")
    csp = _build_csp()
    # Operators can run the policy in report-only mode first (it then never
    # blocks resources, only reports) to validate before enforcing.
    csp_header = (
        "Content-Security-Policy-Report-Only"
        if os.environ.get("COLLECTOR_CSP_REPORT_ONLY") in ("1", "true", "True")
        else "Content-Security-Policy"
    )

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
        if csp:
            response.headers.setdefault(csp_header, csp)
        return response

    app.include_router(public_router)
    app.include_router(router)

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

"""FastAPI application: lifespan init, CORS, routes, and static UI mount."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import storage
from .api.routes import router

# ui/ lives at the repo root: collector/src/collector/app.py -> ../../../ui
_UI_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "ui")
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await storage.init_db()
    purged = await storage.purge_old_records()
    if purged:
        print(f"[collector] purged {purged} records older than retention")
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="JVMTI Exception Collector", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)

    if os.path.isdir(_UI_DIR):
        app.mount("/", StaticFiles(directory=_UI_DIR, html=True), name="ui")
    return app


app = create_app()

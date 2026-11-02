"""FastAPI application: AI/eval routers + systems routers + mock system of record + the built UI.

Run:  ``python -m uvicorn backend.api.main:app --host 127.0.0.1 --port 8010``  (see scripts\\run_backend.bat)
"""
from __future__ import annotations

import importlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.config import REPO_ROOT, get_settings

log = logging.getLogger(__name__)

CORE_ROUTERS = ["system", "engines", "voice", "lab", "eval", "samples", "morning", "jobs"]
SYSTEM_ROUTERS = ["auth", "bundle", "workorders", "kb", "sync", "sor"]
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"]
_API_PREFIXES = ("api/", "ws/", "sor/", "docs", "openapi.json", "redoc")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("FieldVoice API starting (data dir: %s)", get_settings().data_dir)
    yield
    try:
        from backend.engines.registry import get_registry

        get_registry().unload_all()
    except Exception:
        log.exception("error while unloading models")


def _include(app: FastAPI, name: str, required: bool) -> None:
    module = f"backend.api.routers.{name}"
    try:
        app.include_router(importlib.import_module(module).router)
    except ModuleNotFoundError as exc:
        if required or exc.name != module:
            raise
        log.warning("router %s is not available yet - skipping", module)
        app.state.missing_routers.append(name)


def _mount_sor(app: FastAPI) -> None:
    """The device talks to the mock system of record over HTTP under /sor/api (in-process unless FV_SOR_URL is set)."""
    try:
        sor = importlib.import_module("backend.demo.sor.app")
        app.mount("/sor", sor.app, name="sor")
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.startswith("backend.demo.sor"):
            log.warning("mock system of record is not available yet - skipping /sor mount")
            app.state.missing_routers.append("sor-app")
        else:
            raise


def _serve_frontend(app: FastAPI) -> None:
    dist = REPO_ROOT / "frontend" / "dist"
    index = dist / "index.html"
    if not index.exists():
        return
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        if full_path.startswith(_API_PREFIXES):
            raise HTTPException(404)
        candidate = (dist / full_path).resolve()
        if full_path and candidate.is_file() and dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(index)


def create_app() -> FastAPI:
    app = FastAPI(title="FieldVoice - offline voice-to-form on Foundry Local", version="0.1.0", lifespan=lifespan)
    app.state.missing_routers = []
    app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["*"], allow_headers=["*"],
                       allow_credentials=False)
    from backend.api.errors import install_error_handlers

    install_error_handlers(app)
    for name in CORE_ROUTERS:
        _include(app, name, required=True)
    for name in SYSTEM_ROUTERS:
        _include(app, name, required=False)
    _mount_sor(app)
    _serve_frontend(app)
    return app


app = create_app()

"""Shared HTTP error mapping (CONTRACT.md section 3): offline -> 503, unauthenticated -> 401, version conflicts -> 409."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from backend.demo.auth import AuthError
from backend.demo.bundle import BundleIntegrityError
from backend.demo.connectivity import OfflineError
from backend.demo.remote import RemoteError
from backend.demo.sync import SyncStateError


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(OfflineError)
    async def _offline(_: Request, exc: OfflineError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": {"code": "offline", "message": str(exc)}})

    @app.exception_handler(AuthError)
    async def _auth(_: Request, exc: AuthError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={"detail": {"code": exc.code, "message": exc.message}})

    @app.exception_handler(BundleIntegrityError)
    async def _integrity(_: Request, exc: BundleIntegrityError) -> JSONResponse:
        return JSONResponse(status_code=502, content={"detail": {"code": "bundle_integrity", "message": str(exc)}})

    @app.exception_handler(SyncStateError)
    async def _sync_state(_: Request, exc: SyncStateError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": {"code": "invalid_state", "message": str(exc)}})

    @app.exception_handler(RemoteError)
    async def _remote(_: Request, exc: RemoteError) -> JSONResponse:
        status = 503 if exc.status >= 500 else exc.status
        return JSONResponse(status_code=status, content={"detail": {"code": exc.code, "message": exc.message, **exc.extra}})

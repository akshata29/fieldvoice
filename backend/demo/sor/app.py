"""HTTP face of the mock system of record, mounted at ``/sor`` by the main app (device API under ``/sor/api``).

The device client (``backend.demo.remote``) uses these endpoints when ``FV_SOR_URL`` is set; by default it calls the
in-process ``SorService`` directly (same semantics, no sockets). Auth: ``Authorization: Bearer <token>`` from login.
"""
from __future__ import annotations

from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.responses import JSONResponse

from backend.demo.sor.service import CompletionPayload, CompletionResult, LoginResult, SorError, get_sor
from backend.schemas.api import LoginRequest
from backend.schemas.workorders import Bundle

app = FastAPI(title="Mock system of record", docs_url="/docs", openapi_url="/openapi.json")


@app.exception_handler(SorError)
async def _sor_error(_, exc: SorError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": exc.detail()})


def _token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise SorError(401, "invalid_token", "Missing bearer token.")
    return authorization[7:].strip()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/login", response_model=LoginResult)
def login(req: LoginRequest) -> LoginResult:
    return get_sor().login(req.worker_id, req.pin)


@app.get("/api/bundle", response_model=Bundle)
def bundle(authorization: str | None = Header(None)) -> Bundle:
    return get_sor().bundle_for(_token(authorization))


@app.post("/api/completions", response_model=CompletionResult)
def completions(payload: CompletionPayload, authorization: str | None = Header(None)) -> CompletionResult:
    return get_sor().submit_completion(_token(authorization), payload)


@app.post("/api/photos")
async def photos(photo_id: str = Form(...), work_order_id: str = Form(...), sha256: str = Form(...),
                 file: UploadFile = File(...), authorization: str | None = Header(None)) -> dict:
    return get_sor().upload_photo(_token(authorization), photo_id, work_order_id, sha256, await file.read())

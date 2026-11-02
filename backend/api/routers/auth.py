"""Worker sign-in (demo picker + PIN), online or offline unlock."""
from __future__ import annotations

from fastapi import APIRouter, Response

from backend.demo import auth
from backend.schemas.api import LoginRequest
from backend.schemas.reference import Worker
from backend.schemas.workorders import AuthSession

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.get("/workers", response_model=list[Worker])
def workers() -> list[Worker]:
    return auth.known_workers()


@router.post("/login", response_model=AuthSession)
def login(req: LoginRequest) -> AuthSession:
    return auth.login(req.worker_id, req.pin)


@router.post("/logout", status_code=204)
def logout() -> Response:
    auth.logout()
    return Response(status_code=204)


@router.get("/session", response_model=AuthSession | None)
def session() -> AuthSession | None:
    return auth.current_session()

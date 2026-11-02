"""Device -> remote system client. In-process by default, HTTP when ``FV_SOR_URL`` is set. Every call first checks the
device's connectivity switch, then translates the remote's errors into three kinds the sync logic understands."""
from __future__ import annotations

import logging
from typing import Protocol

import httpx

from backend.config import get_settings
from backend.demo.connectivity import connectivity
from backend.demo.sor.service import CompletionPayload, CompletionResult, LoginResult, SorError, get_sor
from backend.schemas.workorders import Bundle

log = logging.getLogger(__name__)


class RemoteError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, **extra: object) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


class RemoteUnavailable(RemoteError):
    """Transient: 503/504/network. Safe to retry (completions are idempotent)."""


class RemoteConflict(RemoteError):
    """409: the work order changed on the server; carries ``server_version``."""

    @property
    def server_version(self) -> int | None:
        v = self.extra.get("server_version")
        return int(v) if isinstance(v, (int, float, str)) and str(v).lstrip("-").isdigit() else None


class RemoteAuthError(RemoteError):
    """401: bad credentials or an invalid session."""


def _translate(status: int, code: str, message: str, extra: dict) -> RemoteError:
    if status == 409:
        return RemoteConflict(status, code, message, **extra)
    if status in (401, 403):
        return RemoteAuthError(status, code, message, **extra)
    if status in (502, 503, 504) or status >= 500:
        return RemoteUnavailable(status, code, message, **extra)
    return RemoteError(status, code, message, **extra)


class Remote(Protocol):
    def login(self, worker_id: str, pin: str) -> LoginResult: ...
    def get_bundle(self, token: str) -> Bundle: ...
    def submit_completion(self, token: str, payload: CompletionPayload) -> CompletionResult: ...
    def upload_photo(self, token: str, photo_id: str, work_order_id: str, sha256: str, data: bytes) -> dict: ...


class InProcessRemote:
    """Calls the mock system of record directly (same semantics as the HTTP API, no sockets)."""

    def _call(self, fn, *args):
        connectivity.require_online()
        try:
            return fn(*args)
        except SorError as exc:
            raise _translate(exc.status, exc.code, exc.message, exc.extra) from None

    def login(self, worker_id: str, pin: str) -> LoginResult:
        return self._call(get_sor().login, worker_id, pin)

    def get_bundle(self, token: str) -> Bundle:
        return self._call(get_sor().bundle_for, token)

    def submit_completion(self, token: str, payload: CompletionPayload) -> CompletionResult:
        return self._call(get_sor().submit_completion, token, payload)

    def upload_photo(self, token: str, photo_id: str, work_order_id: str, sha256: str, data: bytes) -> dict:
        return self._call(get_sor().upload_photo, token, photo_id, work_order_id, sha256, data)


class HttpRemote:
    def __init__(self, base_url: str, timeout: float = 20.0) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    def _request(self, method: str, path: str, token: str | None = None, **kw) -> dict:
        connectivity.require_online()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            r = httpx.request(method, f"{self._base}{path}", headers=headers, timeout=self._timeout, **kw)
        except httpx.HTTPError as exc:
            raise RemoteUnavailable(503, "network", f"cannot reach the system of record: {exc}") from None
        if r.status_code >= 400:
            try:
                d = r.json().get("detail", {})
            except ValueError:
                d = {}
            d = d if isinstance(d, dict) else {"message": str(d)}
            extra = {k: v for k, v in d.items() if k not in ("code", "message")}
            raise _translate(r.status_code, str(d.get("code", "error")), str(d.get("message", r.text[:200])), extra)
        return r.json()

    def login(self, worker_id: str, pin: str) -> LoginResult:
        return LoginResult.model_validate(self._request("POST", "/api/login", json={"worker_id": worker_id, "pin": pin}))

    def get_bundle(self, token: str) -> Bundle:
        return Bundle.model_validate(self._request("GET", "/api/bundle", token))

    def submit_completion(self, token: str, payload: CompletionPayload) -> CompletionResult:
        return CompletionResult.model_validate(
            self._request("POST", "/api/completions", token, json=payload.model_dump(mode="json")))

    def upload_photo(self, token: str, photo_id: str, work_order_id: str, sha256: str, data: bytes) -> dict:
        return self._request("POST", "/api/photos", token, data={"photo_id": photo_id, "work_order_id": work_order_id,
                                                                  "sha256": sha256},
                             files={"file": (photo_id, data, "application/octet-stream")})


def get_remote() -> Remote:
    url = get_settings().sor_url
    return HttpRemote(url) if url else InProcessRemote()

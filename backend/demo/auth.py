"""Worker authentication: online login against the system of record, plus a PIN-based offline unlock.

Online login stores an *offline grant* on the device: a salted PBKDF2 verifier of the worker's PIN (never the PIN itself)
valid until ``offline_grant_expires_at``. While disconnected the same worker can unlock the app with that PIN; anyone else,
or an expired grant, is refused. This is demo-grade: a production build keeps the verifier in the OS keystore and ties it to
the device (see docs/SYSTEMS.md).
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timezone

from backend.config import get_settings
from backend.demo.connectivity import OfflineError, connectivity
from backend.demo.remote import RemoteAuthError, RemoteUnavailable, get_remote
from backend.demo.store import get_store
from backend.schemas.reference import Worker
from backend.schemas.workorders import AuthSession

log = logging.getLogger(__name__)
_ITERATIONS = 120_000


class AuthError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _hash_pin(pin: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, _ITERATIONS).hex()


def _grant_key(worker_id: str) -> str:
    return f"grant:{worker_id}"


def _store_grant(session: AuthSession, pin: str) -> None:
    salt = secrets.token_bytes(16)
    get_store().set_json(_grant_key(session.worker.id), {
        "worker": session.worker.model_dump(), "salt": salt.hex(), "verifier": _hash_pin(pin, salt),
        "expires_at": session.offline_grant_expires_at, "token": session.token})


def known_workers() -> list[Worker]:
    """Workers offered on the demo picker: the in-process system of record's roster, or - with an external system of
    record (``FV_SOR_URL``) - the workers that already hold an offline grant on this device."""
    if not get_settings().sor_url:
        from backend.demo.sor.service import get_sor

        return get_sor().workers
    return [Worker.model_validate(g["worker"]) for g in get_store().list_json("grant:")]


def login(worker_id: str, pin: str) -> AuthSession:
    store = get_store()
    if connectivity.online:
        try:
            res = get_remote().login(worker_id, pin)
        except RemoteAuthError:
            raise AuthError(401, "invalid_credentials", "Wrong worker or PIN.") from None
        except RemoteUnavailable as exc:
            log.warning("system of record unreachable during login (%s); trying offline unlock", exc)
            return _offline_unlock(worker_id, pin)
        session = AuthSession(worker=res.worker, token=res.token, issued_at=res.issued_at, expires_at=res.expires_at,
                              offline_grant_expires_at=res.offline_grant_expires_at, mode="online")
        _store_grant(session, pin)
        store.save_session(session)
        return session
    return _offline_unlock(worker_id, pin)


def _offline_unlock(worker_id: str, pin: str) -> AuthSession:
    store = get_store()
    grant = store.get_json(_grant_key(worker_id))
    if grant is None:
        raise OfflineError("This device has no offline unlock for that worker. Connect and sign in once first.")
    expires = grant["expires_at"]
    if _parse(expires) <= _now():
        raise OfflineError("The offline unlock has expired. Connect to the network and sign in again.")
    if not hmac.compare_digest(_hash_pin(pin, bytes.fromhex(grant["salt"])), grant["verifier"]):
        raise AuthError(401, "invalid_credentials", "Wrong worker or PIN.")
    issued = _now().strftime("%Y-%m-%dT%H:%M:%SZ")
    session = AuthSession(worker=Worker.model_validate(grant["worker"]), token=grant["token"], issued_at=issued,
                          expires_at=expires, offline_grant_expires_at=expires, mode="offline_unlock")
    store.save_session(session)
    return session


def logout() -> None:
    get_store().clear_session()


def current_session() -> AuthSession | None:
    s = get_store().get_session()
    if s is not None and _parse(s.offline_grant_expires_at) <= _now():
        get_store().clear_session()
        return None
    return s

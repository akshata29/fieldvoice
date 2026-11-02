"""Late-bound access to the systems package (connectivity, local store) with safe fallbacks.

The offline-systems modules (backend.demo: connectivity, local store, sync) are imported lazily, so the AI/eval API stays
usable without them.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone

from backend.schemas.system import ConnectivityState
from backend.schemas.workorders import AuthSession, Bundle, BundleSummary

log = logging.getLogger(__name__)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class _FallbackConnectivity:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.online = True
        self.since = now_iso()

    def set_online(self, online: bool) -> None:
        with self._lock:
            if online != self.online:
                self.online, self.since = online, now_iso()


_fallback = _FallbackConnectivity()


def get_connectivity():
    try:
        from backend.demo.connectivity import connectivity

        return connectivity
    except Exception as exc:
        log.debug("using fallback connectivity: %s", exc)
        return _fallback


def connectivity_state() -> ConnectivityState:
    c = get_connectivity()
    return ConnectivityState(online=bool(c.online), since=str(c.since))


def get_session() -> AuthSession | None:
    try:
        from backend.demo.store import get_store

        return get_store().get_session()
    except Exception as exc:
        log.debug("no local store session: %s", exc)
        return None


def get_bundle() -> Bundle | None:
    try:
        from backend.demo import bundle as demo_bundle

        return demo_bundle.get_bundle()
    except Exception as exc:
        log.debug("no bundle: %s", exc)
        return None


def summarize_bundle(b: Bundle) -> BundleSummary:
    return BundleSummary(
        bundle_id=b.bundle_id, worker_id=b.worker.id, issued_at=b.issued_at, expires_at=b.expires_at,
        n_work_orders=len(b.work_orders), n_forms=len(b.forms), n_assets=len(b.assets), n_kb_docs=len(b.kb_docs),
        content_hash=b.content_hash)


def get_bundle_summary() -> BundleSummary | None:
    b = get_bundle()
    return summarize_bundle(b) if b else None

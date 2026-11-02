"""The morning work package: download from the system of record, verify, store locally; read it back offline."""
from __future__ import annotations

import logging
from collections.abc import Callable

from backend.demo.auth import AuthError
from backend.demo.connectivity import connectivity
from backend.demo.integrity import content_hash
from backend.demo.remote import RemoteAuthError, get_remote
from backend.demo.store import get_store
from backend.schemas.reference import Asset
from backend.schemas.workorders import Bundle, BundleSummary

log = logging.getLogger(__name__)
ProgressFn = Callable[[float, str], None]


class BundleIntegrityError(RuntimeError):
    """The downloaded package does not match its content hash (corrupt or tampered); nothing was stored."""


def summarize(b: Bundle) -> BundleSummary:
    return BundleSummary(
        bundle_id=b.bundle_id, worker_id=b.worker.id, issued_at=b.issued_at, expires_at=b.expires_at,
        n_work_orders=len(b.work_orders), n_forms=len(b.forms), n_assets=len(b.assets), n_kb_docs=len(b.kb_docs),
        content_hash=b.content_hash)


def sync_bundle(progress: ProgressFn | None = None) -> BundleSummary:
    """Download today's package (online required), verify its hash and replace the local copy."""
    report = progress or (lambda f, m: None)
    connectivity.require_online()
    store = get_store()
    session = store.get_session()
    if session is None:
        raise AuthError(401, "unauthenticated", "Sign in before downloading today's work.")
    report(0.1, "requesting today's work package")
    try:
        bundle = get_remote().get_bundle(session.token)
    except RemoteAuthError:
        raise AuthError(401, "session_expired", "The session has expired. Sign in again while connected.") from None
    report(0.6, f"verifying {len(bundle.work_orders)} work orders, {len(bundle.forms)} forms, {len(bundle.assets)} assets")
    expected = content_hash(bundle.work_orders, bundle.forms, bundle.assets, bundle.kb_docs, bundle.model_manifest)
    if expected != bundle.content_hash:
        raise BundleIntegrityError("The work package failed its integrity check and was discarded.")
    report(0.85, "saving to the device")
    store.save_bundle(bundle)
    report(1.0, f"{len(bundle.work_orders)} work orders ready")
    return summarize(bundle)


def get_bundle() -> Bundle | None:
    return get_store().get_bundle()


def job_assets(work_order_id: str) -> list[Asset]:
    """The closed world for a job: the assets on its work order plus the truck's stock inventory."""
    b = get_bundle()
    if b is None:
        raise KeyError(work_order_id)
    wo = next((w for w in b.work_orders if w.id == work_order_id), None)
    if wo is None:
        raise KeyError(work_order_id)
    ids = set(wo.asset_ids)
    return [a for a in b.assets if a.id in ids or a.kind == "stock_unit"]

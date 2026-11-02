"""Sync the outbox back to the system of record when connectivity returns.

Guarantees: nothing is lost (the outbox is written atomically with the approval), nothing is double-applied (each completion
carries an idempotency key and the server answers a repeat with the original result), and a dispatch change made while the
worker was offline is never silently overwritten (409 -> CONFLICT -> the worker chooses keep-mine / take-theirs).
"""
from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable

from backend.demo.auth import AuthError
from backend.demo.connectivity import connectivity
from backend.demo.remote import RemoteAuthError, RemoteConflict, RemoteError, RemoteUnavailable, get_remote
from backend.demo.sor.service import CompletionPayload
from backend.demo.store import LocalStore, get_store
from backend.schemas.workorders import FormDraft, OutboxItem, OutboxState, SyncSummary

log = logging.getLogger(__name__)
ProgressFn = Callable[[float, str], None]


class SyncStateError(RuntimeError):
    """The requested resolution does not apply to the item's current state."""


def _payload(draft: FormDraft, item: OutboxItem, worker_id: str) -> CompletionPayload:
    return CompletionPayload(
        operation_id=item.id, work_order_id=draft.work_order_id, form_id=draft.form_id, form_version=draft.form_version,
        base_version=item.base_version, worker_id=worker_id,
        values={k: v.model_dump(mode="json") for k, v in draft.values.items()}, transcript=draft.transcript,
        stt_engine_id=draft.stt_engine_id, llm_engine_id=draft.llm_engine_id, strategy_id=draft.strategy_id,
        photo_ids=[p.id for p in draft.photos], completed_at=draft.approved_at)


def _set_draft_status(store: LocalStore, work_order_id: str, status: str, **changes: object) -> None:
    draft = store.get_draft(work_order_id)
    if draft is not None:
        draft.status = status  # type: ignore[assignment]
        for k, v in changes.items():
            setattr(draft, k, v)
        store.save_draft(draft)


def run_sync(progress: ProgressFn | None = None) -> SyncSummary:
    """Send every pending/failed outbox item (online required). Safe to call repeatedly."""
    report = progress or (lambda f, m: None)
    connectivity.require_online()
    store = get_store()
    session = store.get_session()
    if session is None:
        raise AuthError(401, "unauthenticated", "Sign in before syncing.")
    remote = get_remote()
    summary = SyncSummary()
    items = store.pending_outbox()
    for i, item in enumerate(items):
        report(i / max(1, len(items)), f"sending {item.kind} for {item.work_order_id}")
        summary.attempted += 1
        item.state, item.attempts = OutboxState.SENDING, item.attempts + 1
        store.update_outbox(item)
        try:
            if item.kind == "completion":
                draft = store.get_draft(item.work_order_id)
                if draft is None:
                    raise RemoteError(422, "missing_draft", "the local draft for this completion is gone")
                result = remote.submit_completion(session.token, _payload(draft, item, session.worker.id))
                item.state, item.server_version, item.last_error = OutboxState.SYNCED, result.server_version, None
                item.detail["server_status"] = result.status  # "accepted" or "duplicate" (a retried, already-applied send)
                _set_draft_status(store, item.work_order_id, "synced")
            else:
                found = store.get_photo(str(item.detail.get("photo_id")))
                if found is None or not found[1].exists():
                    raise RemoteError(422, "missing_photo", "the photo file is missing on this device")
                photo, path = found
                data = path.read_bytes()
                remote.upload_photo(session.token, photo.id, item.work_order_id, hashlib.sha256(data).hexdigest(), data)
                item.state, item.last_error = OutboxState.SYNCED, None
            summary.synced += 1
        except RemoteConflict as exc:
            item.state, item.server_version, item.last_error = OutboxState.CONFLICT, exc.server_version, exc.message
            _set_draft_status(store, item.work_order_id, "conflict")
            summary.conflicts += 1
        except RemoteUnavailable as exc:
            item.state, item.last_error = OutboxState.FAILED, exc.message
            summary.failed += 1
        except RemoteAuthError:
            item.state = OutboxState.FAILED
            store.update_outbox(item)
            raise AuthError(401, "session_expired", "The session expired during sync. Sign in again.") from None
        except RemoteError as exc:
            item.state, item.last_error = OutboxState.FAILED, f"{exc.code}: {exc.message}"
            summary.failed += 1
        store.update_outbox(item)
        summary.items.append(item.model_copy(deep=True))
    report(1.0, f"{summary.synced} synced, {summary.failed} failed, {summary.conflicts} conflicts")
    return summary


def resolve(item_id: str, action: str) -> OutboxItem:
    """Settle a CONFLICT: ``keep_mine`` re-sends against the server's current version, ``take_theirs`` discards the local result."""
    store = get_store()
    item = store.get_outbox_item(item_id)
    if item is None:
        raise KeyError(item_id)
    if item.state != OutboxState.CONFLICT or item.kind != "completion":
        raise SyncStateError("only a conflicted completion can be resolved")
    if action == "keep_mine":
        item.base_version = item.server_version if item.server_version is not None else item.base_version
        item.state, item.attempts, item.last_error = OutboxState.PENDING, 0, None
        item.detail["resolution"] = "keep_mine"
        _set_draft_status(store, item.work_order_id, "approved", base_version=item.base_version)
    elif action == "take_theirs":
        item.state, item.last_error = OutboxState.SYNCED, None
        item.detail["resolution"] = "discarded_local"
        _set_draft_status(store, item.work_order_id, "synced")
        for other in store.list_outbox():  # photos of a discarded completion are not uploaded
            if other.kind == "photo" and other.detail.get("operation_id") == item.id and other.state != OutboxState.SYNCED:
                other.state = OutboxState.SYNCED
                other.detail["resolution"] = "discarded_local"
                store.update_outbox(other)
    else:
        raise SyncStateError(f"unknown resolution {action!r}")
    store.update_outbox(item)
    return item

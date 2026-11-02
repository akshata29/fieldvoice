"""Outbox and sync (online required to send; reading the outbox always works)."""
from __future__ import annotations

import logging

from fastapi import APIRouter

from backend.demo import bundle, sync
from backend.demo.connectivity import connectivity
from backend.demo.store import get_store
from backend.schemas.api import ResolveRequest
from backend.schemas.workorders import OutboxItem, SyncSummary

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/sync", tags=["sync"])


@router.get("/outbox", response_model=list[OutboxItem])
def outbox() -> list[OutboxItem]:
    return get_store().list_outbox()


@router.post("/run", response_model=SyncSummary)
def run() -> SyncSummary:
    return sync.run_sync()


@router.post("/resolve", response_model=OutboxItem)
def resolve(req: ResolveRequest) -> OutboxItem:
    try:
        item = sync.resolve(req.item_id, req.action)
    except KeyError:
        from fastapi import HTTPException

        raise HTTPException(404, detail=f"outbox item {req.item_id!r} not found") from None
    if req.action == "take_theirs" and connectivity.online:
        try:  # pick up the dispatcher's newer version of the work order right away
            bundle.sync_bundle()
        except Exception as exc:  # best effort: the next morning prep / manual refresh will do it
            log.warning("could not refresh the bundle after take_theirs: %s", exc)
    return item

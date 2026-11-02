"""Offline knowledge-base search."""
from __future__ import annotations

from fastapi import APIRouter, Query

from backend.demo import kb
from backend.schemas.api import KbHit

router = APIRouter(prefix="/api/v1/kb", tags=["kb"])


@router.get("/search", response_model=list[KbHit])
def search(q: str = "", work_order_id: str | None = None, k: int = Query(5, ge=1, le=20)) -> list[KbHit]:
    return kb.search(q, work_order_id, k)

"""Shared bundle integrity helper (used by the mock system of record when issuing and by the device when verifying)."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel


def _canonical(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_canonical(v) for v in value]
    return value


def content_hash(work_orders: list, forms: list, assets: list, kb_docs: list, model_manifest: Any) -> str:
    """sha256 over the canonical JSON of everything a worker's day depends on (not ids/timestamps)."""
    body = json.dumps(
        [_canonical(work_orders), _canonical(forms), _canonical(assets), _canonical(kb_docs), _canonical(model_manifest)],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()

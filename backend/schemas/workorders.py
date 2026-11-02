"""Work orders, the morning bundle, local drafts, and the sync outbox."""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field

from backend.schemas.extraction import FieldValue, Scalar, StageTiming
from backend.schemas.forms import FormSchema
from backend.schemas.reference import Asset, KbDoc, Worker, WorkerRecord


class WorkOrder(BaseModel):
    id: str
    title: str
    description: str
    location: str
    scheduled_for: str  # ISO date
    priority: Literal["low", "normal", "high", "emergency"] = "normal"
    status: Literal["assigned", "in_progress", "completed"] = "assigned"
    worker_id: str
    form_id: str
    form_version: int = 1
    asset_ids: list[str] = Field(default_factory=list)  # closed world for this job (poles, installed units, ...)
    kb_doc_ids: list[str] = Field(default_factory=list)
    version: int = 1  # bumped by the system of record when dispatch changes the job
    prefill: dict[str, Scalar] = Field(default_factory=dict)


class DemoWorld(BaseModel):
    """Everything the synthetic system of record knows. Produced by ``backend.synth.world.build_world``."""

    seed: int = 7
    workers: list[WorkerRecord]
    forms: list[FormSchema]
    assets: list[Asset]  # includes stock inventory (kind "stock_unit")
    kb_docs: list[KbDoc]
    work_orders: list[WorkOrder]


class ModelRequirement(BaseModel):
    role: Literal["stt", "llm", "embedding"]
    engine_id: str  # see docs/CONTRACT.md engine id convention
    alias: str
    device: str = "cpu"
    required: bool = True


class ModelManifest(BaseModel):
    requirements: list[ModelRequirement] = Field(default_factory=list)


class Bundle(BaseModel):
    """The worker's morning download. Self-contained: enough to work a full day offline."""

    bundle_id: str
    worker: Worker
    issued_at: str  # ISO timestamp
    expires_at: str  # ISO timestamp (offline authorization horizon)
    work_orders: list[WorkOrder]
    forms: list[FormSchema]
    assets: list[Asset]
    kb_docs: list[KbDoc]
    model_manifest: ModelManifest
    content_hash: str


class BundleSummary(BaseModel):
    bundle_id: str
    worker_id: str
    issued_at: str
    expires_at: str
    n_work_orders: int
    n_forms: int
    n_assets: int
    n_kb_docs: int
    content_hash: str


class PhotoRef(BaseModel):
    id: str
    filename: str
    content_type: str = "image/jpeg"
    sha256: str
    size_bytes: int
    taken_at: str


class FormDraft(BaseModel):
    work_order_id: str
    form_id: str
    form_version: int
    base_version: int  # work-order version this draft was based on (optimistic concurrency)
    values: dict[str, FieldValue] = Field(default_factory=dict)
    transcript: str | None = None
    stt_engine_id: str | None = None
    llm_engine_id: str | None = None
    strategy_id: str | None = None
    timings: list[StageTiming] = Field(default_factory=list)
    photos: list[PhotoRef] = Field(default_factory=list)
    status: Literal["draft", "approved", "synced", "conflict"] = "draft"
    operation_id: str | None = None  # idempotency key, assigned on approve
    updated_at: str = ""
    approved_at: str | None = None


class OutboxState(str, Enum):
    PENDING = "pending"
    SENDING = "sending"
    SYNCED = "synced"
    FAILED = "failed"  # transient failure; will be retried
    CONFLICT = "conflict"  # server version moved on; needs a human decision


class OutboxItem(BaseModel):
    id: str  # operation id (idempotency key)
    kind: Literal["completion", "photo"]
    work_order_id: str
    state: OutboxState = OutboxState.PENDING
    attempts: int = 0
    last_error: str | None = None
    created_at: str
    updated_at: str
    base_version: int
    server_version: int | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class SyncSummary(BaseModel):
    attempted: int = 0
    synced: int = 0
    failed: int = 0
    conflicts: int = 0
    items: list[OutboxItem] = Field(default_factory=list)


class AuthSession(BaseModel):
    worker: Worker
    token: str
    issued_at: str
    expires_at: str
    offline_grant_expires_at: str  # until when the PIN can unlock the app without connectivity
    mode: Literal["online", "offline_unlock"] = "online"

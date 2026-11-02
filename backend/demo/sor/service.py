"""The mock system of record: dispatch (work orders + versions), forms, KB, completions, photos, fault injection.

In-process by default; ``backend.demo.sor.app`` exposes the same operations over HTTP under ``/sor/api`` so the device
client can also be pointed at an external service (``FV_SOR_URL``). State persists to ``<data>/demo/sor.json``.
"""
from __future__ import annotations

import hashlib
import json
import logging
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from pydantic import BaseModel, Field

from backend.api.compat import now_iso
from backend.config import get_settings
from backend.demo.integrity import content_hash
from backend.schemas.api import BumpRequest, SorFaults, SorState
from backend.schemas.reference import Worker
from backend.schemas.workorders import Bundle, DemoWorld, ModelManifest, ModelRequirement, WorkOrder
from backend.synth.world import build_world

log = logging.getLogger(__name__)
SESSION_HOURS = 12
BUNDLE_HOURS = 36  # how long a morning bundle stays valid offline
OFFLINE_GRANT_HOURS = 48


class SorError(Exception):
    """An error the remote system reports; ``status`` mirrors the HTTP status it would use."""

    def __init__(self, status: int, code: str, message: str, **extra: object) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}


class LoginResult(BaseModel):
    worker: Worker
    token: str
    issued_at: str
    expires_at: str
    offline_grant_expires_at: str


class CompletionPayload(BaseModel):
    operation_id: str  # idempotency key
    work_order_id: str
    form_id: str
    form_version: int = 1
    base_version: int
    worker_id: str
    values: dict[str, dict] = Field(default_factory=dict)  # FieldValue JSON per field key
    transcript: str | None = None
    stt_engine_id: str | None = None
    llm_engine_id: str | None = None
    strategy_id: str | None = None
    photo_ids: list[str] = Field(default_factory=list)
    completed_at: str | None = None


class CompletionResult(BaseModel):
    operation_id: str
    work_order_id: str
    status: str  # "accepted" | "duplicate"
    server_version: int
    received_at: str


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _engine_requirement(role: str, engine_id: str, required: bool) -> ModelRequirement:
    parts = engine_id.split(":")
    alias = parts[2] if len(parts) > 2 else engine_id
    return ModelRequirement(role=role, engine_id=engine_id, alias=alias, device=parts[3] if len(parts) > 3 else "cpu",
                            required=required)  # type: ignore[arg-type]


class SorService:
    def __init__(self, world: DemoWorld | None = None, persist_path: Path | None = None) -> None:
        self._lock = threading.RLock()
        self._persist = persist_path
        self._initial = world or build_world(7, today=date.today())
        self.faults = SorFaults()
        self._tokens: dict[str, tuple[str, datetime]] = {}
        self._photos: dict[str, dict] = {}
        self._load_or_init()

    # ---- state ------------------------------------------------------------------------------------------------
    def _load_or_init(self) -> None:
        self.world = self._initial.model_copy(deep=True)
        self.work_orders: dict[str, WorkOrder] = {w.id: w for w in self.world.work_orders}
        self.completions: dict[str, dict] = {}  # operation id -> record
        if self._persist and self._persist.exists():
            try:
                raw = json.loads(self._persist.read_text(encoding="utf-8"))
                for wo in raw.get("work_orders", []):
                    w = WorkOrder.model_validate(wo)
                    self.work_orders[w.id] = w
                self.completions = raw.get("completions", {})
            except Exception:
                log.exception("could not read %s; starting from the initial world", self._persist)

    def _save(self) -> None:
        if not self._persist:
            return
        try:
            self._persist.parent.mkdir(parents=True, exist_ok=True)
            self._persist.write_text(json.dumps({
                "work_orders": [w.model_dump(mode="json") for w in self.work_orders.values()],
                "completions": self.completions}, indent=1), encoding="utf-8")
        except OSError:
            log.exception("could not persist the mock system of record")

    def reset(self) -> None:
        with self._lock:
            self.faults = SorFaults()
            self._tokens.clear()
            self._photos.clear()
            if self._persist:
                self._persist.unlink(missing_ok=True)
            self._load_or_init()

    @property
    def workers(self) -> list[Worker]:
        return [Worker(id=w.id, name=w.name, role=w.role, crew=w.crew) for w in self.world.workers]

    # ---- fault injection --------------------------------------------------------------------------------------
    def _gate(self) -> None:
        """Every device request passes here first: injected latency, then injected 503s (before any work is done)."""
        if self.faults.latency_ms:
            time.sleep(self.faults.latency_ms / 1000.0)
        with self._lock:
            if self.faults.fail_next > 0:
                self.faults.fail_next -= 1
                raise SorError(503, "unavailable", "The system of record is temporarily unavailable (injected fault).")

    # ---- device API -------------------------------------------------------------------------------------------
    def login(self, worker_id: str, pin: str) -> LoginResult:
        self._gate()
        rec = next((w for w in self.world.workers if w.id == worker_id), None)
        if rec is None or not secrets.compare_digest(rec.pin, pin):
            raise SorError(401, "invalid_credentials", "Wrong worker or PIN.")
        now = datetime.now(timezone.utc)
        token = secrets.token_urlsafe(24)
        with self._lock:
            self._tokens[token] = (worker_id, now + timedelta(hours=SESSION_HOURS))
        return LoginResult(worker=Worker(id=rec.id, name=rec.name, role=rec.role, crew=rec.crew), token=token,
                           issued_at=_iso(now), expires_at=_iso(now + timedelta(hours=SESSION_HOURS)),
                           offline_grant_expires_at=_iso(now + timedelta(hours=OFFLINE_GRANT_HOURS)))

    def _worker_for(self, token: str) -> str:
        with self._lock:
            entry = self._tokens.get(token)
        if entry is None or entry[1] < datetime.now(timezone.utc):
            raise SorError(401, "invalid_token", "The session is not valid (sign in again).")
        return entry[0]

    def bundle_for(self, token: str) -> Bundle:
        self._gate()
        worker_id = self._worker_for(token)
        with self._lock:
            wos = [w.model_copy(deep=True) for w in self.work_orders.values() if w.worker_id == worker_id]
        form_ids = {w.form_id for w in wos}
        asset_ids = {a for w in wos for a in w.asset_ids}
        kb_ids = {k for w in wos for k in w.kb_doc_ids}
        forms = [f for f in self.world.forms if f.id in form_ids]
        assets = [a for a in self.world.assets if a.id in asset_ids or a.kind == "stock_unit"]
        kb_docs = [d for d in self.world.kb_docs if d.id in kb_ids]
        settings = get_settings()
        manifest = ModelManifest(requirements=[
            _engine_requirement("stt", settings.manifest_stt_engine, True),
            _engine_requirement("llm", settings.manifest_llm_engine, False)])
        now = datetime.now(timezone.utc)
        worker = next(w for w in self.workers if w.id == worker_id)
        return Bundle(
            bundle_id="b-" + secrets.token_hex(5), worker=worker, issued_at=_iso(now),
            expires_at=_iso(now + timedelta(hours=BUNDLE_HOURS)), work_orders=wos, forms=forms, assets=assets,
            kb_docs=kb_docs, model_manifest=manifest, content_hash=content_hash(wos, forms, assets, kb_docs, manifest))

    def submit_completion(self, token: str, p: CompletionPayload) -> CompletionResult:
        self._gate()
        worker_id = self._worker_for(token)
        with self._lock:
            wo = self.work_orders.get(p.work_order_id)
            if wo is None or wo.worker_id != worker_id:
                raise SorError(404, "unknown_work_order", f"Work order {p.work_order_id} is not assigned to this worker.")
            prior = self.completions.get(p.operation_id)
            if prior is not None:  # idempotent retry (e.g. the response was lost): same answer, no second record
                return CompletionResult(operation_id=p.operation_id, work_order_id=wo.id, status="duplicate",
                                        server_version=prior["server_version"], received_at=prior["received_at"])
            injected = self.faults.conflict_next > 0
            if injected:
                self.faults.conflict_next -= 1
                wo.version += 1
                wo.description += " [Dispatch changed this job.]"
                self._save()
            if injected or p.base_version != wo.version:
                raise SorError(409, "version_conflict", "Dispatch changed this work order after you downloaded it.",
                               server_version=wo.version)
            if any(c["work_order_id"] == wo.id for c in self.completions.values()):
                raise SorError(409, "already_completed", "This work order was already completed.", server_version=wo.version)
            record = {"operation_id": p.operation_id, "work_order_id": wo.id, "worker_id": worker_id, "form_id": p.form_id,
                      "base_version": p.base_version, "server_version": wo.version, "received_at": now_iso(),
                      "values": {k: v.get("value") for k, v in p.values.items() if v.get("value") is not None},
                      "transcript": p.transcript, "photo_ids": p.photo_ids, "engines": {
                          "stt": p.stt_engine_id, "llm": p.llm_engine_id, "strategy": p.strategy_id}}
            self.completions[p.operation_id] = record
            wo.status = "completed"
            self._save()
            if self.faults.drop_response_next > 0:  # committed, but the device never hears back
                self.faults.drop_response_next -= 1
                raise SorError(504, "gateway_timeout", "No response from the system of record (injected fault).")
            return CompletionResult(operation_id=p.operation_id, work_order_id=wo.id, status="accepted",
                                    server_version=wo.version, received_at=record["received_at"])

    def upload_photo(self, token: str, photo_id: str, work_order_id: str, sha256: str, data: bytes) -> dict:
        self._gate()
        self._worker_for(token)
        if hashlib.sha256(data).hexdigest() != sha256:
            raise SorError(422, "checksum_mismatch", "The photo was corrupted in transit.")
        with self._lock:
            self._photos[photo_id] = {"work_order_id": work_order_id, "sha256": sha256, "size": len(data)}
        return {"photo_id": photo_id, "status": "stored"}

    # ---- dispatcher console -----------------------------------------------------------------------------------
    def state(self) -> SorState:
        with self._lock:
            return SorState(work_orders=[w.model_copy(deep=True) for w in self.work_orders.values()],
                            completions=[dict(c) for c in self.completions.values()], photos=len(self._photos),
                            faults=self.faults.model_copy())

    def bump(self, work_order_id: str, req: BumpRequest) -> WorkOrder:
        with self._lock:
            wo = self.work_orders.get(work_order_id)
            if wo is None:
                raise SorError(404, "unknown_work_order", f"No work order {work_order_id}.")
            wo.version += 1
            if req.title:
                wo.title = req.title
            wo.description += f" [Dispatch update v{wo.version}: {req.note}]" if req.note else f" [Dispatch update v{wo.version}]"
            self._save()
            return wo.model_copy(deep=True)

    def set_faults(self, faults: SorFaults) -> SorFaults:
        with self._lock:
            self.faults = faults.model_copy()
            return self.faults.model_copy()


_sor: SorService | None = None
_sor_lock = threading.Lock()


def get_sor() -> SorService:
    """Process-wide mock system of record (re-created if the data directory setting changes, e.g. in tests)."""
    global _sor
    path = get_settings().demo_dir / "sor.json"
    with _sor_lock:
        if _sor is None or _sor._persist != path:
            _sor = SorService(persist_path=path)
        return _sor


def reset_sor_singleton() -> None:
    global _sor
    with _sor_lock:
        _sor = None

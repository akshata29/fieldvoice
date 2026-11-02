"""Request/response models used by the REST API (the contract between frontend and backend)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from backend.schemas.engines import NO_LLM_ID, ORACLE_STT_ID, EngineInfo, StrategyInfo
from backend.schemas.eval import NoiseSpec, RunConfig
from backend.schemas.extraction import ExtractionResult, Scalar
from backend.schemas.forms import FormSchema
from backend.schemas.reference import Asset
from backend.schemas.system import ReadinessReport, ReadinessStatus
from backend.schemas.workorders import FormDraft, WorkOrder

DraftStatus = Literal["none", "draft", "approved", "synced", "conflict"]


# ---- auth / connectivity ------------------------------------------------------------------------
class LoginRequest(BaseModel):
    worker_id: str
    pin: str


class ConnectivityRequest(BaseModel):
    online: bool


# ---- work orders / knowledge base ---------------------------------------------------------------
class KbHit(BaseModel):
    doc_id: str
    title: str
    heading: str
    snippet: str
    score: float
    revision: str = "A"


class WorkOrderListItem(BaseModel):
    work_order: WorkOrder
    form_title: str
    draft_status: DraftStatus = "none"


class WorkOrderDetail(BaseModel):
    work_order: WorkOrder
    form: FormSchema
    assets: list[Asset]  # job assets + stock inventory (the closed world the pipeline resolves ids against)
    draft: FormDraft | None = None
    kb: list[KbHit] = Field(default_factory=list)


# ---- sync / mock system of record ---------------------------------------------------------------
class ResolveRequest(BaseModel):
    item_id: str
    action: Literal["keep_mine", "take_theirs"]


class SorFaults(BaseModel):
    fail_next: int = 0  # next N requests return 503 before doing any work
    latency_ms: int = 0  # added to every request
    drop_response_next: int = 0  # next N completions are committed but the response is lost (504) - tests idempotent retry
    conflict_next: int = 0  # next N completions are rejected with 409 as if dispatch changed the job


class BumpRequest(BaseModel):
    title: str | None = None
    note: str | None = None


class SorState(BaseModel):
    work_orders: list[WorkOrder]
    completions: list[dict[str, Any]]
    photos: int
    faults: SorFaults


# ---- engines / models ---------------------------------------------------------------------------
class EngineList(BaseModel):
    stt: list[EngineInfo]
    llm: list[EngineInfo]
    strategies: list[StrategyInfo]


class CatalogVariant(BaseModel):
    id: str
    device: str  # "cpu" | "gpu" | "npu"
    execution_provider: str
    size_mb: float | None = None
    cached: bool = False


class CatalogModel(BaseModel):
    alias: str
    task: str  # "chat-completion" | "automatic-speech-recognition" | "embeddings" | "vision-language-chat"
    publisher: str | None = None
    license: str | None = None
    input_modalities: list[str] = Field(default_factory=list)
    supports_tool_calling: bool | None = None
    variants: list[CatalogVariant] = Field(default_factory=list)


# ---- morning prep -------------------------------------------------------------------------------
class MorningStep(BaseModel):
    id: Literal["authenticate", "download_bundle", "sync_reference", "ensure_models", "readiness"]
    label: str
    status: ReadinessStatus = ReadinessStatus.PENDING
    detail: str = ""
    duration_ms: float | None = None


class MorningResult(BaseModel):
    steps: list[MorningStep]
    readiness: ReadinessReport | None = None
    ready_to_go_offline: bool = False


# ---- voice / extraction / lab -------------------------------------------------------------------
class SampleInfo(BaseModel):
    id: str
    form_id: str
    tags: list[str] = Field(default_factory=list)
    split: str = "dev"
    has_audio: bool = False
    spoken_text: str
    written_text: str
    expected: dict[str, Scalar] = Field(default_factory=dict)
    noise: NoiseSpec | None = None
    voice: str | None = None
    audio_url: str | None = None  # /api/v1/samples/{id}/audio


class ExtractRequest(BaseModel):
    """Provide exactly one of: ``transcript`` (text), ``sample_id`` (dataset case). For uploaded audio use the multipart route."""

    work_order_id: str | None = None  # resolves form + closed world from the local bundle
    form_id: str | None = None  # alternative to work_order_id (uses all known assets)
    transcript: str | None = None
    sample_id: str | None = None
    stt_engine_id: str = ORACLE_STT_ID
    llm_engine_id: str = NO_LLM_ID
    strategy_id: str = "hybrid"


class LabCompareRequest(BaseModel):
    work_order_id: str | None = None
    form_id: str | None = None
    sample_id: str | None = None
    transcript: str | None = None
    combos: list[RunConfig]


class LabCompareItem(BaseModel):
    config: RunConfig
    extraction: ExtractionResult | None = None
    field_correct: dict[str, bool] | None = None  # only when the sample has ground truth
    error: str | None = None


class LabCompareResult(BaseModel):
    expected: dict[str, Scalar] | None = None
    items: list[LabCompareItem]


# ---- evaluation ---------------------------------------------------------------------------------
class DatasetGenerateRequest(BaseModel):
    name: str = "synth-v1"
    n_cases: int = 240
    seed: int = 11
    with_audio: bool = True
    audio_limit: int | None = 120  # synthesize audio for at most N cases (TTS is the slow part)
    augment: bool = True  # add noise / muffling variants to audio cases

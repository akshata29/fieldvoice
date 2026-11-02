"""Pydantic v2 contracts shared by the whole backend and the frontend types. See docs/CONTRACT.md."""
from __future__ import annotations

from backend.schemas.engines import (  # noqa: F401
    NO_LLM_ID,
    ORACLE_STT_ID,
    STRATEGY_IDS,
    AvailabilityState,
    EngineInfo,
    EngineKind,
    JobState,
    JobStatus,
    StrategyInfo,
)
from backend.schemas.api import *  # noqa: F401,F403
from backend.schemas.eval import (  # noqa: F401
    CaseResult,
    ConfigMetrics,
    DecisionGates,
    DecisionReport,
    DecisionRow,
    EvalCase,
    EvalDatasetInfo,
    LatencyStats,
    NoiseSpec,
    ParetoPoint,
    RunConfig,
    RunRequest,
    RunSummary,
)
from backend.schemas.extraction import (  # noqa: F401
    Evidence,
    ExtractionResult,
    FieldSource,
    FieldStatus,
    FieldValue,
    Scalar,
    StageTiming,
)
from backend.schemas.forms import CodeOption, FieldSpec, FieldType, FormSchema  # noqa: F401
from backend.schemas.reference import Asset, KbDoc, KbSection, Worker, WorkerRecord  # noqa: F401
from backend.schemas.system import (  # noqa: F401
    ConnectivityState,
    FoundryStatus,
    HardwareInfo,
    ReadinessCheck,
    ReadinessReport,
    ReadinessStatus,
    SystemStatus,
)
from backend.schemas.workorders import (  # noqa: F401
    AuthSession,
    Bundle,
    BundleSummary,
    DemoWorld,
    FormDraft,
    ModelManifest,
    ModelRequirement,
    OutboxItem,
    OutboxState,
    PhotoRef,
    SyncSummary,
    WorkOrder,
)

"""Engine registry, strategies, and background job models."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

# Strategy ids (ablation ladder from "what the prototype does today" to the proposed hybrid).
STRATEGY_FREE_JSON = "free_json"  # one prompt with the whole form, unconstrained JSON, lenient parse (today's baseline)
STRATEGY_SCHEMA_CONSTRAINED = "schema_constrained"  # same prompt, JSON-schema constrained decoding
STRATEGY_ENUM_GRAMMAR = "enum_grammar"  # LLM only, tight grammar: enums + candidate-restricted ids, compact output
STRATEGY_HYBRID = "hybrid"  # normalize -> deterministic resolve -> LLM only for unresolved fields -> validate
STRATEGY_HYBRID_ALWAYS = "hybrid_always"  # like hybrid but always asks the LLM about unresolved fields (gate ablation)
STRATEGY_RULES_ONLY = "rules_only"  # deterministic stages only, no LLM

STRATEGY_IDS = [
    STRATEGY_FREE_JSON,
    STRATEGY_SCHEMA_CONSTRAINED,
    STRATEGY_ENUM_GRAMMAR,
    STRATEGY_HYBRID,
    STRATEGY_HYBRID_ALWAYS,
    STRATEGY_RULES_ONLY,
]

# Special engine ids
ORACLE_STT_ID = "oracle:stt:transcript"  # use the dataset's reference transcript instead of running ASR
NO_LLM_ID = "rules:llm:none"  # no LLM (rules_only strategy)


class EngineKind(str, Enum):
    STT = "stt"
    LLM = "llm"
    EMBEDDING = "embedding"


class AvailabilityState(str, Enum):
    READY = "ready"  # can run now (cached / installed)
    NEEDS_DOWNLOAD = "needs_download"  # model files not on disk yet
    UNAVAILABLE = "unavailable"  # SDK missing, access not granted, unsupported on this machine
    ERROR = "error"  # tried and failed (see reason)


class EngineInfo(BaseModel):
    id: str
    kind: EngineKind
    name: str
    provider: str  # "foundry" | "azure-embedded" | "azure-cloud" | "ort-genai" | "oracle" | "rules" | "mock"
    offline: bool = True  # False => needs the network at inference time (reference/ceiling engines only)
    supports_streaming: bool = False
    availability: AvailabilityState = AvailabilityState.UNAVAILABLE
    availability_reason: str | None = None
    alias: str | None = None
    variant_id: str | None = None
    device: str | None = None  # "cpu" | "gpu" | "npu"
    execution_provider: str | None = None
    size_mb: float | None = None
    loaded: bool = False
    tags: list[str] = Field(default_factory=list)


class StrategyInfo(BaseModel):
    id: str
    name: str
    description: str
    uses_llm: bool
    deterministic_stages: bool
    constrained: bool


class JobState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobStatus(BaseModel):
    id: str
    kind: str  # "prepare_engine" | "morning_sync" | "readiness" | "eval_run" | "dataset_build" | "lab_compare" | ...
    state: JobState = JobState.QUEUED
    progress: float = 0.0  # 0..1
    message: str = ""
    started_at: str | None = None
    finished_at: str | None = None
    result: Any | None = None
    error: str | None = None

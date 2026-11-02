"""Extraction results: what the voice-to-form pipeline produces."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

Scalar = str | float | bool | None


class FieldStatus(str, Enum):
    FILLED = "filled"  # confident enough to show as filled
    NEEDS_REVIEW = "needs_review"  # value proposed but the worker must confirm (low confidence / not in closed world)
    MISSING = "missing"  # nothing found; left empty on purpose (never guessed)
    CONFLICT = "conflict"  # contradictory evidence


class FieldSource(str, Enum):
    RULE = "rule"
    EMBEDDING = "embedding"
    LLM = "llm"
    USER = "user"
    PREFILL = "prefill"


class Evidence(BaseModel):
    """Character span in ``transcript_normalized`` supporting a value."""

    start: int
    end: int
    text: str


class FieldValue(BaseModel):
    key: str
    value: Scalar = None
    source: FieldSource | None = None
    confidence: float = 0.0
    status: FieldStatus = FieldStatus.MISSING
    evidence: Evidence | None = None
    note: str | None = None
    candidates: list[str] = Field(default_factory=list)  # alternatives offered to the reviewer


class StageTiming(BaseModel):
    stage: str  # "stt" | "normalize" | "resolve" | "llm" | "validate" | ...
    ms: float
    detail: dict[str, Any] = Field(default_factory=dict)


class ExtractionResult(BaseModel):
    transcript_raw: str = ""
    transcript_normalized: str = ""
    fields: dict[str, FieldValue] = Field(default_factory=dict)
    unresolved: list[str] = Field(default_factory=list)  # keys the deterministic stages could not fill
    timings: list[StageTiming] = Field(default_factory=list)
    total_ms: float = 0.0
    audio_ms: float | None = None
    stt_ms: float | None = None
    stt_engine_id: str | None = None
    llm_engine_id: str | None = None
    strategy_id: str = "hybrid"
    llm_prompt_tokens: int | None = None
    llm_output_tokens: int | None = None
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None

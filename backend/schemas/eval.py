"""Evaluation datasets, runs, metrics, and decision reports."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from backend.schemas.extraction import ExtractionResult, Scalar
from backend.schemas.system import HardwareInfo


class NoiseSpec(BaseModel):
    kind: Literal["none", "white", "pink", "wind", "engine", "crackle", "radio", "muffled"] = "none"
    snr_db: float | None = None
    reverb: bool = False


class EvalCase(BaseModel):
    """One synthetic (or recorded) utterance with ground truth."""

    id: str
    form_id: str
    form_version: int = 1
    job_asset_ids: list[str] = Field(default_factory=list)  # closed world in scope for the job (incl. inventory)
    spoken_text: str  # exactly what is said (numbers as words); TTS input; WER reference for audio
    written_text: str  # how a good ASR would write it (digits, punctuation); oracle transcript
    audio_path: str | None = None  # relative to the dataset dir; 16 kHz mono PCM16 WAV
    expected: dict[str, Scalar] = Field(default_factory=dict)  # field key -> expected normalized value; None = leave empty
    tags: list[str] = Field(default_factory=list)  # e.g. "digits", "grouped", "correction", "negation", "missing", "colloquial"
    split: Literal["dev", "heldout"] = "dev"  # heldout uses phrasing the lexicon/templates were not tuned on
    voice: str | None = None
    noise: NoiseSpec | None = None


class EvalDatasetInfo(BaseModel):
    id: str
    name: str
    created_at: str
    seed: int
    n_cases: int
    n_with_audio: int = 0
    form_ids: list[str] = Field(default_factory=list)
    tag_counts: dict[str, int] = Field(default_factory=dict)
    splits: dict[str, int] = Field(default_factory=dict)
    synthetic: bool = True


class RunConfig(BaseModel):
    """One cell of the evaluation matrix."""

    stt_engine_id: str  # engine id or ORACLE_STT_ID
    llm_engine_id: str  # engine id or NO_LLM_ID
    strategy_id: str

    @property
    def key(self) -> str:
        return f"{self.stt_engine_id}|{self.llm_engine_id}|{self.strategy_id}"


class RunRequest(BaseModel):
    dataset_id: str
    configs: list[RunConfig]
    limit: int | None = None  # first N cases (after filters)
    splits: list[str] | None = None  # e.g. ["heldout"]
    tags: list[str] | None = None  # keep cases having any of these tags
    repeats: int = 1  # repeat the whole case set to stabilize latency percentiles
    warmup: int = 1  # untimed warm-up cases per config
    confidence_threshold: float = 0.8  # fields at/above this confidence and status "filled" count as "confident"
    label: str | None = None


class LatencyStats(BaseModel):
    n: int = 0
    mean: float | None = None
    p50: float | None = None
    p95: float | None = None
    max: float | None = None


class ConfigMetrics(BaseModel):
    config_key: str
    config: RunConfig
    n_cases: int = 0
    n_errors: int = 0

    # speech
    wer: float | None = None  # raw WER vs spoken_text (None for oracle transcripts)
    wer_normalized: float | None = None  # WER after number/format normalization
    id_exact_match: float | None = None  # identifiers (ids/numbers) in the reference that appear correctly in the transcript
    rtf: float | None = None  # stt time / audio time (<1 is faster than real time)

    # extraction
    field_accuracy: float = 0.0  # micro-average over all (case, field) pairs, including "left empty" expectations
    id_field_accuracy: float | None = None  # accuracy on ENTITY_REF fields only
    accuracy_by_type: dict[str, float] = Field(default_factory=dict)
    accuracy_by_tag: dict[str, float] = Field(default_factory=dict)
    form_exact_match: float = 0.0
    silent_wrong_rate: float = 0.0  # confident, filled and wrong, as a share of confident fields
    hallucination_rate: float | None = None  # share of expected-empty fields that were filled
    review_rate: float = 0.0  # share of fields flagged for the worker
    safe_outcome_rate: float = 0.0  # correct OR flagged for review (never silently wrong)
    schema_valid_rate: float | None = None  # LLM output parsed and valid (None when no LLM)

    # cost
    latency_total: LatencyStats = Field(default_factory=LatencyStats)
    latency_stt: LatencyStats = Field(default_factory=LatencyStats)
    latency_extract: LatencyStats = Field(default_factory=LatencyStats)  # everything after STT
    latency_llm: LatencyStats = Field(default_factory=LatencyStats)
    llm_prompt_tokens_mean: float | None = None
    llm_output_tokens_mean: float | None = None
    cold_start_ms: float | None = None  # model load time(s) for this config
    peak_rss_mb: float | None = None
    model_size_mb: float | None = None  # on-disk size of the models used


class CaseResult(BaseModel):
    case_id: str
    config_key: str
    ok: bool = True
    error: str | None = None
    tags: list[str] = Field(default_factory=list)
    transcript_hyp: str = ""
    wer: float | None = None
    expected: dict[str, Scalar] = Field(default_factory=dict)
    field_correct: dict[str, bool] = Field(default_factory=dict)
    extraction: ExtractionResult | None = None


class RunSummary(BaseModel):
    run_id: str
    label: str | None = None
    created_at: str
    finished_at: str | None = None
    dataset_id: str
    status: Literal["running", "succeeded", "failed", "cancelled"] = "running"
    progress: float = 0.0
    hardware: HardwareInfo
    request: RunRequest
    configs: list[ConfigMetrics] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class DecisionGates(BaseModel):
    max_p95_ms: float = 5000.0  # end-of-speech -> proposed fields
    min_id_field_accuracy: float = 0.95
    max_silent_wrong: float = 0.02
    max_peak_rss_mb: float | None = None
    min_field_accuracy: float = 0.0


class DecisionRow(BaseModel):
    config_key: str
    passes: bool
    failed_gates: list[str] = Field(default_factory=list)  # gate codes: max_p95_ms, min_id_field_accuracy, max_silent_wrong, max_peak_rss_mb, min_field_accuracy, no_successful_cases
    score: float = 0.0  # higher is better; only meaningful among configs that pass
    rank: int | None = None


class ParetoPoint(BaseModel):
    config_key: str
    p95_ms: float | None
    field_accuracy: float
    silent_wrong_rate: float
    pareto_optimal: bool = False


class DecisionReport(BaseModel):
    run_id: str
    gates: DecisionGates
    rows: list[DecisionRow]
    pareto: list[ParetoPoint]

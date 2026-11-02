"""Voice-to-form service: engine readiness, STT + pipeline execution shared by REST, WebSocket and Lab."""
from __future__ import annotations

import logging
import tempfile
import time
import wave
from pathlib import Path

from fastapi import HTTPException

from backend.api.context import ExtractionContext
from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.core.strategies import get_strategy
from backend.core.timing import EventFn
from backend.engines.base import EngineError, LlmEngine, SttEngine, SttResult
from backend.engines.registry import get_registry
from backend.schemas.engines import NO_LLM_ID, ORACLE_STT_ID, AvailabilityState
from backend.schemas.extraction import ExtractionResult, StageTiming

log = logging.getLogger(__name__)
_pipeline = ExtractionPipeline()


def ensure_loaded(engine_id: str, kind: str) -> None:
    """Load a cached engine on first use; refuse (409) when it still needs a download."""
    reg = get_registry()
    try:
        info = reg.info(engine_id)
    except KeyError:
        raise HTTPException(404, detail=f"unknown {kind} engine {engine_id!r}") from None
    if info.loaded or engine_id in (ORACLE_STT_ID, NO_LLM_ID):
        return
    if info.availability != AvailabilityState.READY:
        raise HTTPException(409, detail={
            "code": "engine_not_ready",
            "message": f"{info.name}: {info.availability_reason or info.availability.value}. "
                       f"Prepare it on the Models page first.",
        })
    try:
        reg.prepare(engine_id)
    except EngineError as exc:
        raise HTTPException(500, detail=f"could not load {info.name}: {exc}") from exc


class LazyLlm(LlmEngine):
    """Loads the model on first use. Under ``hybrid`` most utterances are fully explained by the rules, so those never pay
    for (or hold in RAM) a model the gate does not call; the first utterance that needs it pays the load once."""

    def __init__(self, engine_id: str) -> None:
        self.engine_id = engine_id

    def info(self):
        return get_registry().info(self.engine_id)

    def ensure_ready(self, progress=None) -> float:
        return get_registry().prepare(self.engine_id, progress)

    def complete(self, system: str, user: str, **kwargs):  # type: ignore[override]
        ensure_loaded(self.engine_id, "LLM")
        return get_registry().get_llm(self.engine_id).complete(system, user, **kwargs)


def get_llm_for(strategy_id: str, llm_engine_id: str) -> LlmEngine | None:
    try:
        strategy = get_strategy(strategy_id)
    except KeyError:
        raise HTTPException(422, detail=f"unknown strategy {strategy_id!r}") from None
    if not strategy.uses_llm or llm_engine_id == NO_LLM_ID:
        if strategy.uses_llm and strategy_id != "hybrid" and strategy_id != "hybrid_always":
            raise HTTPException(422, detail=f"strategy {strategy_id} needs an LLM engine")
        return None
    if strategy_id == "hybrid":  # the gate decides per utterance whether the model is needed at all
        try:
            get_registry().info(llm_engine_id)
        except KeyError:
            raise HTTPException(404, detail=f"unknown LLM engine {llm_engine_id!r}") from None
        return LazyLlm(llm_engine_id)
    ensure_loaded(llm_engine_id, "LLM")  # strategies that always call the model fail fast when it is not ready
    return get_registry().get_llm(llm_engine_id)


def transcribe_wav(stt_engine_id: str, wav_path: Path) -> SttResult:
    if stt_engine_id == ORACLE_STT_ID:
        raise HTTPException(422, detail="oracle STT has no audio path; pick a real STT engine")
    ensure_loaded(stt_engine_id, "STT")
    engine: SttEngine = get_registry().get_stt(stt_engine_id)
    try:
        return engine.transcribe_file(wav_path)
    except EngineError as exc:
        raise HTTPException(500, detail=str(exc)) from exc


def run_extraction(ctx: ExtractionContext, transcript: str, strategy_id: str, llm_engine_id: str,
                   stt_engine_id: str | None = None, stt: SttResult | None = None,
                   on_event: EventFn | None = None) -> ExtractionResult:
    llm = get_llm_for(strategy_id, llm_engine_id)
    inp = PipelineInput(transcript=transcript, form=ctx.form, assets=ctx.assets, prefill=ctx.prefill)
    result = _pipeline.run(inp, strategy_id, llm, on_event)
    if stt is not None:
        result.timings.insert(0, StageTiming(stage="stt", ms=stt.stt_ms, detail={"audio_ms": stt.audio_ms}))
        result.total_ms += stt.stt_ms
        result.stt_ms, result.audio_ms, result.stt_engine_id = stt.stt_ms, stt.audio_ms, stt_engine_id
    return result


def write_wav(pcm16: bytes, sample_rate: int = 16000) -> Path:
    fd = tempfile.NamedTemporaryFile(prefix="fv_", suffix=".wav", delete=False)
    fd.close()
    with wave.open(fd.name, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16)
    return Path(fd.name)


def timed_ms(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000.0

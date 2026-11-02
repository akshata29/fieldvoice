"""The device probe, run against test doubles (no models)."""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest

from backend.engines.base import SttEngine, SttEvent, SttResult, SttStream
from backend.engines.registry import EngineRegistry, set_registry
from backend.engines.simple import ScriptedLlm
from backend.evalkit import bench
from backend.schemas.engines import AvailabilityState, EngineInfo, EngineKind
from backend.synth.augment import write_wav


class SteadyStt(SttEngine):
    def __init__(self) -> None:
        self.calls = 0

    def info(self) -> EngineInfo:
        return EngineInfo(id="mock:stt:steady", kind=EngineKind.STT, name="steady", provider="mock",
                          availability=AvailabilityState.READY)

    def ensure_ready(self, progress=None) -> float:
        return 12.0

    def transcribe_file(self, wav_path: Path) -> SttResult:
        self.calls += 1
        return SttResult(text="pole one two three", audio_ms=2000.0, stt_ms=500.0)


@pytest.fixture()
def registry():
    llm = ScriptedLlm(engine_id="mock:llm:scripted", reply='{"condition_found": "oil_leak"}')
    reg = EngineRegistry(foundry=False, azure=False)
    reg.register_stt("mock:stt:steady", SteadyStt())
    reg.register_llm("mock:llm:scripted", llm)
    set_registry(reg)
    yield reg, llm
    set_registry(None)


def test_stt_probe_reports_real_time_factor(registry, tmp_path: Path) -> None:
    clip = tmp_path / "clip.wav"
    write_wav(clip, np.zeros(32000, dtype=np.float32))
    p = bench.probe_stt("mock:stt:steady", clip, repeats=3)
    assert p.error is None and p.cold_start_ms == 12.0 and p.audio_ms == 2000.0
    assert p.series.runs_ms == [500.0] * 3 and p.rtf == pytest.approx(0.25)  # the warm-up call is not in the series
    assert p.transcript == "pole one two three"


def test_unknown_engines_are_reported_not_raised(registry, tmp_path: Path) -> None:
    assert "mock:stt:nope" in (bench.probe_stt("mock:stt:nope", tmp_path / "x.wav", 1).error or "")
    assert bench.probe_llm("mock:llm:nope", 1).error


def test_llm_probe_times_each_way_of_asking(registry) -> None:
    _, llm = registry
    p = bench.probe_llm("mock:llm:scripted", repeats=2)
    assert p.error is None
    assert [c.label for c in p.calls] == [
        "1 field, grammar", "1 field, json schema", "1 field, unconstrained",
        "3 fields, grammar", "3 fields, json schema", "3 fields, unconstrained",
        bench.PREFILL_SHORT, bench.PREFILL_LONG, bench.DECODE_ONE, bench.DECODE_MANY]
    formats = [c["response_format"] and c["response_format"]["type"] for c in llm.calls]
    assert {"lark_grammar", "json_schema", None} <= set(formats)
    assert all(len(c.series.runs_ms) == 2 for c in p.calls)  # warm-up + 2 timed calls each
    long_prompt = next(c for c in llm.calls if c["user"] == bench.SPEED_CALLS[bench.PREFILL_LONG][0])
    assert len(long_prompt["user"]) > 3 * len(bench.STATEMENT)  # the long prefill prompt really is long
    assert bench.SPEED_CALLS[bench.DECODE_ONE][0] == bench.SPEED_CALLS[bench.DECODE_MANY][0]  # same prompt, so only generation differs


def _speed_probe(**ms: float) -> bench.LlmProbe:
    """Prefill 20 ms per prompt token, generation 50 ms per token, 400 ms of session setup."""
    def call(label: str, p50: float, tokens_in: int, tokens_out: int) -> bench.LlmCall:
        return bench.LlmCall(label, bench.Series([p50, p50, p50]), prompt_tokens=tokens_in, output_tokens=tokens_out)

    return bench.LlmProbe("x", calls=[
        call(bench.PREFILL_SHORT, 400 + 20 * 100 + 50, 100, 1),
        call(bench.PREFILL_LONG, 400 + 20 * 400 + 50, 400, 1),
        call(bench.DECODE_ONE, 400 + 20 * 12 + 50, 12, ms.get("one_out", 1)),
        call(bench.DECODE_MANY, 400 + 20 * 18 + 50 * ms.get("many_out", 64), 18, ms.get("many_out", 64))])


def test_session_prompt_and_generation_costs_are_separated() -> None:
    p = _speed_probe()
    assert p.prefill_ms_per_token() == pytest.approx(20.0)
    assert p.decode_ms_per_token() == pytest.approx(50.0, rel=0.05)  # the 6 extra prompt tokens are priced and removed
    assert p.fixed_cost_ms == pytest.approx(450.0)
    assert bench.LlmProbe("y").prefill_ms_per_token() is None and bench.LlmProbe("y").fixed_cost_ms is None


def test_decode_speed_is_not_guessed_when_the_model_stops_early() -> None:
    assert _speed_probe(many_out=5).decode_ms_per_token() is None  # 4 extra tokens say nothing about generation speed


def test_render_is_readable_markdown(registry, tmp_path: Path) -> None:
    clip = tmp_path / "clip.wav"
    write_wav(clip, np.zeros(32000, dtype=np.float32))
    md = bench.render([bench.probe_stt("mock:stt:steady", clip, 2), bench.probe_stt("mock:stt:nope", clip, 1)],
                      [bench.probe_llm("mock:llm:scripted", 1)], "unit-test")
    assert "# Device probe - profile `unit-test`" in md and "| `mock:stt:steady` | 12 |" in md
    assert "RTF" in md and "## Language model `mock:llm:scripted`" in md and "1 field, grammar" in md


class FakeStream(SttStream):
    def __init__(self) -> None:
        self.pushed = 0

    def push(self, pcm16: bytes) -> None:
        self.pushed += 1

    def drain(self) -> list[SttEvent]:
        return [SttEvent(text="pole one")] if self.pushed >= 3 else []

    def finish(self) -> SttResult:
        time.sleep(0.05)
        return SttResult(text="pole one two three", audio_ms=500.0, stt_ms=50.0)


class StreamingStt(SteadyStt):
    def info(self) -> EngineInfo:
        return EngineInfo(id="mock:stt:live", kind=EngineKind.STT, name="live", provider="mock",
                          availability=AvailabilityState.READY, supports_streaming=True)

    def open_stream(self, sample_rate: int = 16000) -> SttStream:
        return FakeStream()


def test_live_probe_measures_first_words_and_the_wait_after_the_last(registry, tmp_path: Path) -> None:
    reg, _ = registry
    reg.register_stt("mock:stt:live", StreamingStt())
    clip = tmp_path / "clip.wav"
    write_wav(clip, np.zeros(8000, dtype=np.float32))  # half a second: five 100 ms chunks
    p = bench.probe_live("mock:stt:live", clip, repeats=2)
    assert p.error is None and p.note is None and p.transcript == "pole one two three"
    assert len(p.tail_ms.runs_ms) == 2 and all(t >= 45.0 for t in p.tail_ms.runs_ms)  # finish() takes 50 ms
    assert 290.0 <= p.first_text_ms.p50 < 1000.0  # the partial appears with the third chunk, 300 ms into the speech


def test_live_probe_says_when_an_engine_is_batch_only_or_missing(registry, tmp_path: Path) -> None:
    clip = tmp_path / "clip.wav"
    write_wav(clip, np.zeros(8000, dtype=np.float32))
    batch = bench.probe_live("mock:stt:steady", clip, repeats=1)
    assert batch.note and "batch engine" in batch.note and not batch.tail_ms.runs_ms
    assert bench.probe_live("mock:stt:nope", clip, repeats=1).error
    md = bench.render([], [], "unit-test", [batch])
    assert "## Live" in md and "batch engine" in md

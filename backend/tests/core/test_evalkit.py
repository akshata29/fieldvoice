"""Tests for metrics, decision gates and the evaluation runner (no models needed)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.config import get_settings
from backend.core import pipeline
from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.engines.base import LlmResult
from backend.engines.foundry_engines import FoundryLlmEngine
from backend.engines.registry import EngineRegistry
from backend.engines.simple import ScriptedLlm
from backend.evalkit import metrics, noguidance
from backend.evalkit.hardware import get_hardware_info
from backend.evalkit.report import decide, markdown_report
from backend.evalkit.runner import EvalRunner
from backend.evalkit.store import RunStore
from backend.schemas.eval import (
    CaseResult,
    ConfigMetrics,
    DecisionGates,
    EvalCase,
    EvalDatasetInfo,
    RunConfig,
    RunRequest,
    RunSummary,
)
from backend.schemas.extraction import ExtractionResult, FieldSource, FieldStatus, FieldValue
from backend.schemas.reference import Asset
from backend.schemas.workorders import DemoWorld
from backend.schemas.reference import WorkerRecord
from backend.tests.core.fixtures import transformer_form, world_assets


def test_wer_and_normalized_wer() -> None:
    assert metrics.wer("pole one two three", "pole one two three") == 0.0
    assert metrics.wer("pole one two three", "pole 123") > 0.5
    assert metrics.wer_normalized("pole one two three", "pole 123") == 0.0


def test_id_exact_match() -> None:
    assert metrics.id_exact_match("pole one two three unit four five six", "pole 1 2 3 unit 4 5 6") == 1.0
    assert metrics.id_exact_match("pole one two three unit four five six", "pole 1 2 3 unit 4 5 9") == 0.5
    assert metrics.id_exact_match("no numbers here", "anything") is None


def test_noguidance_runner_refuses_guided_requests_and_passes_plain_ones(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict | None] = []

    def real(self, system, user, *, response_format=None, max_tokens=200, temperature=0.0):
        seen.append(response_format)
        return LlmResult(text="{}", total_ms=1.0)

    monkeypatch.setattr(FoundryLlmEngine, "complete", real)  # restored (with our wrapper) when the test ends
    noguidance.install()
    for fmt in ({"type": "lark_grammar", "lark_grammar": "start: x"}, {"type": "json_schema", "json_schema": {}}):
        with pytest.raises(RuntimeError, match="Guidance is unavailable in this build"):
            FoundryLlmEngine.complete(None, "s", "u", response_format=fmt)  # type: ignore[arg-type]
    assert seen == []  # the real engine never saw a guided request
    assert FoundryLlmEngine.complete(None, "s", "u").text == "{}"  # type: ignore[arg-type]
    assert seen == [None]


def test_noguidance_tolerant_enums_accept_a_label_the_strict_matcher_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456."

    def condition_found():
        inp = PipelineInput(transcript=text, form=transformer_form(), assets=world_assets())
        return ExtractionPipeline().run(inp, "hybrid", ScriptedLlm(reply={"condition_found": "Oil leak"})).fields["condition_found"]

    assert condition_found().status == FieldStatus.MISSING  # strict: only the exact code counts
    monkeypatch.setattr(FoundryLlmEngine, "complete", FoundryLlmEngine.complete)
    monkeypatch.setattr(pipeline, "_coerce", pipeline._coerce)  # both restored when the test ends
    noguidance.install(tolerant_enums=True)
    f = condition_found()
    assert f.value == "oil_leak" and f.status == FieldStatus.NEEDS_REVIEW


def make_case(**kw) -> EvalCase:
    base = dict(
        id="c1", form_id="transformer_replacement", job_asset_ids=["123", "456"],
        spoken_text="I replaced the transformer at pole one two three and installed unit four five six",
        written_text="I replaced the transformer at pole 123 and installed unit 456.",
        expected={"work_performed": "transformer_replacement", "pole_id": "123", "removed_unit": None,
                  "replacement_unit": "456", "condition_found": None, "customer_notified": None,
                  "kva_rating": None, "notes": None},
        tags=["digits"],
    )
    base.update(kw)
    return EvalCase(**base)


def test_silent_wrong_counts_only_confident_wrong() -> None:
    form = transformer_form()
    case = make_case()
    ext = ExtractionResult(fields={
        "work_performed": FieldValue(key="work_performed", value="transformer_replacement", confidence=0.95,
                                     status=FieldStatus.FILLED, source=FieldSource.RULE),
        "pole_id": FieldValue(key="pole_id", value="456", confidence=0.95, status=FieldStatus.FILLED),  # confident + wrong
        "replacement_unit": FieldValue(key="replacement_unit", value="999", confidence=0.7,
                                       status=FieldStatus.NEEDS_REVIEW),  # wrong but flagged -> safe
        "condition_found": FieldValue(key="condition_found", value="oil_leak", confidence=0.9,
                                      status=FieldStatus.FILLED),  # hallucinated (expected empty), confident
    })
    sc = metrics.score_case(case, form, ext)
    assert sc.field_correct["work_performed"] and not sc.field_correct["pole_id"]
    assert sc.confident == 3 and sc.silent_wrong == 2
    assert sc.flagged == 1 and sc.hallucinated == 1
    assert sc.id_scored == 3  # pole, removed_unit, replacement_unit


def make_dataset(root: Path, n: int = 3, name: str = "tiny", with_audio: bool = False) -> None:
    d = root / "datasets" / name
    d.mkdir(parents=True)
    form = transformer_form()
    world = DemoWorld(seed=1, workers=[WorkerRecord(id="w1", name="W", role="lineman", crew="A", pin="1234")],
                      forms=[form], assets=world_assets(), kb_docs=[], work_orders=[])
    cases = [make_case(id=f"c{i}") for i in range(n)]
    n_audio = 0
    if with_audio:
        import wave

        (d / "audio").mkdir()
        with wave.open(str(d / "audio" / "c0.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 16000)  # one second of silence
        cases[0].audio_path = "audio/c0.wav"
        n_audio = 1
    (d / "world.json").write_text(world.model_dump_json(), encoding="utf-8")
    (d / "cases.jsonl").write_text("\n".join(c.model_dump_json() for c in cases), encoding="utf-8")
    info = EvalDatasetInfo(id=name, name=name, created_at="2026-01-01T00:00:00Z", seed=1, n_cases=n,
                           n_with_audio=n_audio, form_ids=[form.id], tag_counts={"digits": n}, splits={"dev": n})
    (d / "manifest.json").write_text(info.model_dump_json(), encoding="utf-8")


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FV_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    make_dataset(tmp_path)
    yield tmp_path
    get_settings.cache_clear()


def test_runner_rules_only_and_decision(data_dir: Path) -> None:
    reg = EngineRegistry(foundry=False, azure=False)
    reg.register_llm("mock:llm:scripted", ScriptedLlm(reply={}))
    runner = EvalRunner(registry=reg, store=RunStore(data_dir / "runs"))
    req = RunRequest(dataset_id="tiny", warmup=0, configs=[
        RunConfig(stt_engine_id="oracle:stt:transcript", llm_engine_id="rules:llm:none", strategy_id="rules_only"),
        RunConfig(stt_engine_id="oracle:stt:transcript", llm_engine_id="mock:llm:scripted", strategy_id="free_json"),
    ])
    summary = runner.run(req)
    assert summary.status == "succeeded", summary.notes
    rules, free = summary.configs
    assert rules.n_cases == 3 and rules.field_accuracy == 1.0 and rules.silent_wrong_rate == 0.0
    assert rules.id_field_accuracy == 1.0
    # the scripted LLM replies "{}" -> baseline fills nothing -> misses 3 of 8... accuracy < rules-only
    assert free.field_accuracy < rules.field_accuracy
    report = decide(summary, DecisionGates(max_p95_ms=5000))
    ranks = {r.config_key: r.rank for r in report.rows}
    assert ranks[rules.config_key] == 1
    md = markdown_report(summary, report)
    assert "rules_only" in md and "Silent-wrong" in md
    cases = RunStore(data_dir / "runs").load_cases(summary.run_id, only_failures=True)
    assert all(c.config_key == free.config_key for c in cases) and cases


def test_runner_reports_unavailable_engine(data_dir: Path) -> None:
    reg = EngineRegistry(foundry=False, azure=False)
    runner = EvalRunner(registry=reg, store=RunStore(data_dir / "runs"))
    req = RunRequest(dataset_id="tiny", warmup=0, configs=[
        RunConfig(stt_engine_id="oracle:stt:transcript", llm_engine_id="foundry:llm:nope:cpu", strategy_id="hybrid")])
    summary = runner.run(req)
    m = summary.configs[0]
    assert m.n_errors == m.n_cases == 3
    report = decide(summary)
    assert not report.rows[0].passes and report.rows[0].failed_gates == ["no_successful_cases"]
    assert "engine unavailable" in markdown_report(summary, report)


def _stored_run(store: RunStore, run_id: str, transcript: str, expected: dict | None = None) -> None:
    """A finished speech run as an earlier version of the code left it: transcripts were scored wrong then."""
    from backend.schemas.extraction import ExtractionResult

    stt_id = "mock:stt:fake"
    rules = RunConfig(stt_engine_id=stt_id, llm_engine_id="rules:llm:none", strategy_id="rules_only")
    llm = RunConfig(stt_engine_id=stt_id, llm_engine_id="mock:llm:scripted", strategy_id="hybrid")
    case = make_case()
    req = RunRequest(dataset_id="tiny", configs=[rules, llm], label="speech-sweep")
    hardware = get_hardware_info()
    hardware.device_profile = "source-box"
    store.save_summary(RunSummary(
        run_id=run_id, label="speech-sweep", created_at="2026-01-01T00:00:00Z", dataset_id="tiny", status="succeeded",
        hardware=hardware, request=req,
        configs=[ConfigMetrics(config_key=rules.key, config=rules, n_cases=3, cold_start_ms=1234.0,
                               peak_rss_mb=200.0, model_size_mb=150.0)]))
    store.append_cases(run_id, [
        CaseResult(case_id=f"c{i}", config_key=rules.key, transcript_hyp=transcript,
                   expected=expected if expected is not None else case.expected,
                   field_correct={"pole_id": False},
                   extraction=ExtractionResult(stt_ms=900.0, audio_ms=3000.0, stt_engine_id=stt_id))
        for i in range(3)])


def test_rescore_scores_stored_transcripts_with_current_code(data_dir: Path) -> None:
    store = RunStore(data_dir / "runs")
    _stored_run(store, "src-run", "I replaced the transformer at pole 1-2-3 and installed unit 4-5-6.")
    runner = EvalRunner(registry=EngineRegistry(foundry=False, azure=False), store=store)  # no speech engine at all
    summary = runner.rescore("src-run")
    assert summary.status == "succeeded", summary.notes
    assert summary.run_id != "src-run" and summary.label == "speech-sweep-rescored"
    assert summary.hardware.device_profile == "source-box"  # speech numbers keep the machine that produced them
    assert len(summary.configs) == 1 and summary.configs[0].config.strategy_id == "rules_only"
    assert any("Rescored from run src-run" in n for n in summary.notes)
    assert any("Skipped" in n and "hybrid" in n for n in summary.notes)  # the language-model config is not replayed
    m = summary.configs[0]
    assert m.field_accuracy == 1.0 and m.id_field_accuracy == 1.0  # hyphenated digits are read as one number
    assert m.latency_stt.p50 == 900.0 and m.rtf == pytest.approx(0.3)
    assert m.cold_start_ms == 1234.0 and m.model_size_mb == 150.0 and m.peak_rss_mb == pytest.approx(200.0, abs=5.0)
    cases = store.load_cases(summary.run_id)
    assert len(cases) == 3 and all(c.transcript_hyp.endswith("4-5-6.") for c in cases)
    assert store.load_summary("src-run").configs[0].field_accuracy == 0.0  # the source run is untouched


def test_rescore_refuses_transcripts_of_a_rebuilt_dataset(data_dir: Path) -> None:
    store = RunStore(data_dir / "runs")
    _stored_run(store, "stale-run", "pole 123", expected={"pole_id": "999"})
    runner = EvalRunner(registry=EngineRegistry(foundry=False, azure=False), store=store)
    with pytest.raises(ValueError, match="nothing to rescore"):
        runner.rescore("stale-run")
    with pytest.raises(FileNotFoundError):
        runner.rescore("no-such-run")


def test_pareto_marks_dominated_configs() -> None:
    from backend.evalkit.report import pareto_points
    from backend.schemas.eval import ConfigMetrics, LatencyStats

    def m(key: str, acc: float, p95: float) -> ConfigMetrics:
        return ConfigMetrics(config_key=key, config=RunConfig(stt_engine_id="a", llm_engine_id="b", strategy_id="c"),
                             n_cases=10, field_accuracy=acc, latency_total=LatencyStats(n=10, p95=p95))

    pts = {p.config_key: p for p in pareto_points([m("fast_ok", 0.9, 1000), m("slow_better", 0.95, 4000),
                                                   m("slow_worse", 0.85, 4500)])}
    assert pts["fast_ok"].pareto_optimal and pts["slow_better"].pareto_optimal and not pts["slow_worse"].pareto_optimal

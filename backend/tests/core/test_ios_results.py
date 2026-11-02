"""The iOS result summarizer (no device needed: uses hand-made result files)."""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.config import get_settings
from backend.evalkit.ios_results import SCHEMA, summarize
from backend.tests.core.test_evalkit import make_dataset

DEVICE = {"machine": "iPad12,1", "system": "Version 18.5", "physical_memory_mb": 3072.0, "processor_count": 6,
          "low_power_mode": False, "thermal_state_start": "nominal", "build": "release"}


def llm_results() -> dict:
    run = lambda i, total, out: {"case_id": f"prompt-{i}", "strategy": "hybrid", "repeat": 0, "prompt_tokens": 100,
                                 "output_tokens": 11, "ttft_ms": 400.0, "total_ms": total, "tokens_per_s": 10.0,
                                 "output": out, "thermal_state": "nominal"}
    return {"schema": SCHEMA, "created_at": "2026-01-01T00:00:00Z", "device": DEVICE,
            "runner": {"kind": "llm", "id": "ort-genai:phi-3.5-mini", "detail": "test"}, "load_ms": 5000.0,
            "footprint_mb": {"before_load": 80.0, "after_load": 2300.0, "peak": 2450.0},
            "runs": [run(0, 1800.0, '{"condition_found": "oil_leak"}'), run(1, 6200.0, "not json"),
                     {"case_id": "prompt-2", "strategy": "hybrid", "repeat": 0, "thermal_state": "serious",
                      "error": "out of memory"}],
            "notes": []}


def test_llm_summary_reports_validity_latency_and_gate() -> None:
    md = summarize(llm_results(), max_p95_ms=5000)
    assert "iPad12,1" in md and "peak 2450 MB" in md
    row = next(line for line in md.splitlines() if line.startswith("| hybrid"))
    cells = [c.strip() for c in row.strip("|").split("|")]
    assert cells[1:4] == ["3", "1", "1/2"]  # runs, errors, valid JSON among the successful runs
    assert "FAIL" in cells[-1]  # p95 above the gate
    assert "serious" in md  # throttling is surfaced


def test_debug_build_is_flagged() -> None:
    res = llm_results()
    res["device"] = {**DEVICE, "build": "debug"}
    assert "debug build" in summarize(res)


def test_stt_summary_scores_against_dataset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FV_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    try:
        make_dataset(tmp_path, n=2, name="synth-v1")
        res = {"schema": SCHEMA, "created_at": "x", "device": DEVICE,
               "runner": {"kind": "stt", "id": "apple:sfspeech:on-device", "detail": ""}, "load_ms": 100.0,
               "footprint_mb": {"before_load": 80.0, "after_load": 90.0, "peak": 120.0},
               "runs": [{"case_id": "c0", "audio_ms": 5000.0, "stt_ms": 900.0, "first_partial_ms": 300.0,
                         "transcript": "I replaced the transformer at pole 123 and installed unit 456",
                         "thermal_state": "nominal"},
                        {"case_id": "c1", "audio_ms": 5000.0, "stt_ms": 1100.0, "first_partial_ms": 350.0,
                         "transcript": "I replaced the transformer at pole 123 and installed unit 465",
                         "thermal_state": "nominal"}],
               "notes": []}
        md = summarize(res, "synth-v1")
        assert "RTF 0.20" in md and "Scored vs `synth-v1` (2 cases)" in md
        assert "identifier match 0.750" in md  # 3 of 4 identifiers right (unit 465 vs 456)
    finally:
        get_settings.cache_clear()


def test_wrong_schema_is_rejected() -> None:
    with pytest.raises(ValueError):
        summarize({"schema": "other"})

"""Core API tests: engines, samples, REST + WebSocket voice, lab, evaluation runs, jobs, morning prep.

No models and no network are needed: everything uses the oracle transcript and the deterministic strategies.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.api.jobs import JobBusy, JobContext, JobManager
from backend.api.main import create_app
from backend.config import get_settings
from backend.engines.base import SttEngine, SttResult
from backend.engines.registry import EngineRegistry, set_registry
from backend.schemas.engines import AvailabilityState, EngineInfo, EngineKind, JobState
from backend.tests.core.test_evalkit import make_dataset

ORACLE = "oracle:stt:transcript"
NO_LLM = "rules:llm:none"
EXPECTED = {"work_performed": "transformer_replacement", "pole_id": "123", "replacement_unit": "456"}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FV_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    make_dataset(tmp_path, n=4, name="synth-v1", with_audio=True)
    set_registry(EngineRegistry(foundry=False, azure=False))
    with TestClient(create_app()) as c:
        yield c
    set_registry(None)
    get_settings.cache_clear()


def wait_job(client: TestClient, job: dict, timeout: float = 30.0) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        cur = client.get(f"/api/v1/jobs/{job['id']}").json()
        if cur["state"] in ("succeeded", "failed", "cancelled"):
            return cur
        time.sleep(0.05)
    raise AssertionError(f"job {job['id']} did not finish: {cur}")


# ---- system / engines ---------------------------------------------------------------------------------------------
def test_status_and_engine_list(client: TestClient) -> None:
    st = client.get("/api/v1/system/status").json()
    assert st["connectivity"]["online"] in (True, False) and "hardware" in st and "foundry" in st
    eng = client.get("/api/v1/engines").json()
    assert ORACLE in [e["id"] for e in eng["stt"]] and NO_LLM in [e["id"] for e in eng["llm"]]
    assert {s["id"] for s in eng["strategies"]} == {
        "free_json", "schema_constrained", "enum_grammar", "hybrid", "hybrid_always", "rules_only"}


def test_unknown_engine_is_404(client: TestClient) -> None:
    assert client.post("/api/v1/engines/nope/prepare").status_code == 404
    assert client.post("/api/v1/engines/nope/unload").status_code == 404


def test_connectivity_switch(client: TestClient) -> None:
    assert client.post("/api/v1/system/connectivity", json={"online": False}).json()["online"] is False
    assert client.get("/api/v1/system/status").json()["connectivity"]["online"] is False
    assert client.post("/api/v1/system/connectivity", json={"online": True}).json()["online"] is True


# ---- samples ------------------------------------------------------------------------------------------------------
def test_samples_and_audio(client: TestClient) -> None:
    samples = client.get("/api/v1/samples").json()
    assert len(samples) == 4
    with_audio = [s for s in samples if s["has_audio"]]
    assert [s["id"] for s in with_audio] == ["c0"] and with_audio[0]["audio_url"] == "/api/v1/samples/c0/audio"
    r = client.get("/api/v1/samples/c0/audio")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav" and r.content[:4] == b"RIFF"
    assert client.get("/api/v1/samples/c1/audio").status_code == 404  # exists but has no audio
    assert client.get("/api/v1/samples/zzz/audio").status_code == 404
    assert client.get("/api/v1/samples", params={"with_audio": "true"}).json()[0]["id"] == "c0"


def test_samples_empty_without_dataset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FV_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    set_registry(EngineRegistry(foundry=False, azure=False))
    try:
        with TestClient(create_app()) as c:
            assert c.get("/api/v1/samples").json() == []
            assert c.get("/api/v1/eval/datasets").json() == []
    finally:
        set_registry(None)
        get_settings.cache_clear()


# ---- voice (REST) -------------------------------------------------------------------------------------------------
def _values(result: dict) -> dict:
    return {k: v["value"] for k, v in result["fields"].items()}


def test_extract_sample_rules_only(client: TestClient) -> None:
    r = client.post("/api/v1/voice/extract", json={
        "sample_id": "c1", "stt_engine_id": ORACLE, "llm_engine_id": NO_LLM, "strategy_id": "rules_only"})
    assert r.status_code == 200, r.text
    vals = _values(r.json())
    assert {k: vals[k] for k in EXPECTED} == EXPECTED
    assert r.json()["total_ms"] >= 0 and r.json()["timings"]


def test_extract_transcript_with_form_id(client: TestClient) -> None:
    r = client.post("/api/v1/voice/extract", json={
        "form_id": "transformer_replacement", "transcript": "Replaced the transformer at pole 123 with unit 456",
        "strategy_id": "hybrid"})
    assert r.status_code == 200, r.text
    assert _values(r.json())["pole_id"] == "123"


def test_extract_validation_errors(client: TestClient) -> None:
    assert client.post("/api/v1/voice/extract", json={"form_id": "transformer_replacement"}).status_code == 422
    assert client.post("/api/v1/voice/extract", json={"transcript": "x"}).status_code == 422
    r = client.post("/api/v1/voice/extract", json={"form_id": "transformer_replacement", "transcript": "x",
                                                   "strategy_id": "free_json", "llm_engine_id": NO_LLM})
    assert r.status_code == 422  # LLM strategies need an LLM engine
    r = client.post("/api/v1/voice/extract", json={"form_id": "transformer_replacement", "transcript": "x",
                                                   "strategy_id": "bogus"})
    assert r.status_code == 422
    assert client.post("/api/v1/voice/extract", json={"sample_id": "nope", "transcript": "x"}).status_code == 404


def test_extract_audio_rejects_non_wav(client: TestClient) -> None:
    r = client.post("/api/v1/voice/extract-audio", files={"audio": ("a.wav", b"not a wav", "audio/wav")},
                    data={"form_id": "transformer_replacement", "stt_engine_id": ORACLE})
    assert r.status_code == 415


# ---- voice (WebSocket) --------------------------------------------------------------------------------------------
def test_ws_play_sample_event_order(client: TestClient) -> None:
    with client.websocket_connect("/ws/voice") as ws:
        ws.send_json({"type": "start", "form_id": "transformer_replacement", "stt_engine_id": ORACLE,
                      "llm_engine_id": NO_LLM, "strategy_id": "rules_only", "sample_rate": 16000})
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "play_sample", "sample_id": "c1", "realtime": False})
        events = []
        while True:
            ev = ws.receive_json()
            events.append(ev)
            if ev["type"] in ("result", "error"):
                break
    kinds = [e["type"] for e in events]
    assert kinds[-1] == "result", events[-1]
    assert kinds.index("transcript") < kinds.index("fields") < kinds.index("result")
    assert "fields" in kinds and any(e.get("stage") == "normalize" for e in events if e["type"] == "stage")
    vals = {k: v["value"] for k, v in events[-1]["result"]["fields"].items()}
    assert {k: vals[k] for k in EXPECTED} == EXPECTED


class _NoLiveStt(SttEngine):
    """Claims streaming support but its live session cannot be opened (as Whisper's cannot in Foundry Local)."""

    def info(self) -> EngineInfo:
        return EngineInfo(id="mock:stt:nolive", kind=EngineKind.STT, name="no live", provider="mock",
                          supports_streaming=True, availability=AvailabilityState.READY, loaded=True)

    def ensure_ready(self, progress=None) -> float:
        return 0.0

    def transcribe_file(self, wav_path):
        return SttResult(text="I replaced the transformer at pole one two three.", audio_ms=1000.0, stt_ms=5.0)

    def open_stream(self, sample_rate: int = 16000):
        raise RuntimeError("unsupported model type 'whisper'")


def test_ws_falls_back_to_buffered_transcription_when_live_mode_is_unavailable(client: TestClient) -> None:
    from backend.engines.registry import get_registry

    get_registry().register_stt("mock:stt:nolive", _NoLiveStt())
    with client.websocket_connect("/ws/voice") as ws:
        ws.send_json({"type": "start", "form_id": "transformer_replacement", "stt_engine_id": "mock:stt:nolive",
                      "llm_engine_id": NO_LLM, "strategy_id": "rules_only", "sample_rate": 16000})
        assert ws.receive_json()["type"] == "ready"  # not an error: the session continues without live partials
        ws.send_bytes(b"\x00\x01" * 1600)
        ws.send_json({"type": "stop"})
        events = []
        while True:
            ev = ws.receive_json()
            events.append(ev)
            if ev["type"] in ("result", "error"):
                break
    assert events[-1]["type"] == "result", events[-1]
    assert [e["type"] for e in events].count("partial") == 0
    assert events[-1]["result"]["fields"]["pole_id"]["value"] == "123"
    assert events[-1]["result"]["stt_engine_id"] == "mock:stt:nolive"


def test_hybrid_loads_the_llm_only_when_the_gate_opens(client: TestClient) -> None:
    from backend.engines.base import LlmEngine, LlmResult
    from backend.engines.registry import get_registry

    class CountingLlm(LlmEngine):
        loads = 0

        def __init__(self) -> None:
            self.loaded = False

        def info(self) -> EngineInfo:
            return EngineInfo(id="mock:llm:counting", kind=EngineKind.LLM, name="counting", provider="mock",
                              availability=AvailabilityState.READY, loaded=self.loaded)

        def ensure_ready(self, progress=None) -> float:
            if not self.loaded:
                CountingLlm.loads += 1
                self.loaded = True
            return 1.0

        def complete(self, system, user, **kw):
            return LlmResult(text='{"condition_found": "oil_leak"}', total_ms=1.0, prompt_tokens=5, output_tokens=3)

    get_registry().register_llm("mock:llm:counting", CountingLlm())
    body = {"form_id": "transformer_replacement", "stt_engine_id": ORACLE, "llm_engine_id": "mock:llm:counting",
            "strategy_id": "hybrid"}
    explained = client.post("/api/v1/voice/extract", json={
        **body, "transcript": "I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456."})
    assert explained.status_code == 200 and CountingLlm.loads == 0  # nothing left to ask: the model is never loaded
    assert explained.json()["llm_engine_id"] == "mock:llm:counting" and explained.json()["error"] is None
    colloquial = client.post("/api/v1/voice/extract", json={
        **body, "transcript": "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456."})
    assert colloquial.status_code == 200 and CountingLlm.loads == 1
    assert colloquial.json()["fields"]["condition_found"]["value"] == "oil_leak"
    client.post("/api/v1/voice/extract", json={**body, "transcript": "Replaced the transformer at pole 123, weeping badly."})
    assert CountingLlm.loads == 1  # loaded once, reused
    assert client.post("/api/v1/voice/extract", json={**body, "llm_engine_id": "mock:llm:nope",
                                                       "transcript": "x"}).status_code == 404


def test_ws_errors_are_reported_not_fatal(client: TestClient) -> None:
    with client.websocket_connect("/ws/voice") as ws:
        ws.send_json({"type": "bogus"})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "stop"})  # nothing started: ignored
        ws.send_json({"type": "start", "form_id": "transformer_replacement", "stt_engine_id": ORACLE,
                      "strategy_id": "rules_only"})
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "stop"})
        assert ws.receive_json() == {"type": "error", "message": "no audio received"}


# ---- lab ----------------------------------------------------------------------------------------------------------
def test_lab_compare(client: TestClient) -> None:
    combos = [{"stt_engine_id": ORACLE, "llm_engine_id": NO_LLM, "strategy_id": "rules_only"},
              {"stt_engine_id": ORACLE, "llm_engine_id": NO_LLM, "strategy_id": "hybrid"},
              {"stt_engine_id": ORACLE, "llm_engine_id": "foundry:llm:missing:cpu", "strategy_id": "free_json"}]
    r = client.post("/api/v1/lab/compare", json={"sample_id": "c1", "combos": combos})
    assert r.status_code == 202, r.text
    done = wait_job(client, r.json())
    assert done["state"] == "succeeded", done
    items = done["result"]["items"]
    assert len(items) == 3 and done["result"]["expected"]["pole_id"] == "123"
    assert items[0]["field_correct"]["pole_id"] and not items[0]["error"]
    assert items[2]["error"] and items[2]["extraction"] is None  # a broken combo does not sink the whole comparison
    assert client.post("/api/v1/lab/compare", json={"sample_id": "c1", "combos": []}).status_code == 422


# ---- evaluation ---------------------------------------------------------------------------------------------------
def test_eval_run_end_to_end(client: TestClient) -> None:
    assert [d["id"] for d in client.get("/api/v1/eval/datasets").json()] == ["synth-v1"]
    assert len(client.get("/api/v1/eval/datasets/synth-v1/cases", params={"limit": 2}).json()) == 2
    assert client.get("/api/v1/eval/datasets/nope/cases").status_code == 404

    body = {"dataset_id": "synth-v1", "warmup": 0, "label": "api-test", "configs": [
        {"stt_engine_id": ORACLE, "llm_engine_id": NO_LLM, "strategy_id": "rules_only"},
        {"stt_engine_id": ORACLE, "llm_engine_id": NO_LLM, "strategy_id": "hybrid"}]}
    job = client.post("/api/v1/eval/runs", json=body)
    assert job.status_code == 202, job.text
    run_id = job.json()["result"]["run_id"]  # known immediately, before the run starts
    done = wait_job(client, job.json())
    assert done["state"] == "succeeded", done and done["result"]["run_id"] == run_id

    summary = client.get(f"/api/v1/eval/runs/{run_id}").json()
    assert summary["status"] == "succeeded" and len(summary["configs"]) == 2 and summary["label"] == "api-test"
    assert [r["run_id"] for r in client.get("/api/v1/eval/runs").json()] == [run_id]
    cases = client.get(f"/api/v1/eval/runs/{run_id}/cases", params={"limit": 3}).json()
    assert len(cases) == 3 and cases[0]["extraction"] is not None

    decision = client.get(f"/api/v1/eval/runs/{run_id}/decision", params={"max_p95_ms": 1000}).json()
    assert {r["config_key"] for r in decision["rows"]} == {c["config_key"] for c in summary["configs"]}
    assert decision["gates"]["max_p95_ms"] == 1000 and decision["pareto"]

    csv = client.get(f"/api/v1/eval/runs/{run_id}/export", params={"format": "csv"})
    assert csv.status_code == 200 and csv.text.splitlines()[0].startswith("config_key,stt,llm,strategy")
    assert len(csv.text.strip().splitlines()) == 3
    assert client.get(f"/api/v1/eval/runs/{run_id}/export", params={"format": "json"}).json()["run_id"] == run_id
    assert "Silent-wrong" in client.get(f"/api/v1/eval/runs/{run_id}/export", params={"format": "md"}).text
    assert client.get(f"/api/v1/eval/runs/{run_id}/export", params={"format": "xml"}).status_code == 422

    assert client.delete(f"/api/v1/eval/runs/{run_id}").status_code == 204
    assert client.get(f"/api/v1/eval/runs/{run_id}").status_code == 404


def test_eval_run_validation(client: TestClient) -> None:
    cfg = {"stt_engine_id": ORACLE, "llm_engine_id": NO_LLM, "strategy_id": "rules_only"}
    assert client.post("/api/v1/eval/runs", json={"dataset_id": "nope", "configs": [cfg]}).status_code == 404
    assert client.post("/api/v1/eval/runs", json={"dataset_id": "synth-v1", "configs": []}).status_code == 422


# ---- jobs ---------------------------------------------------------------------------------------------------------
def test_job_manager_exclusive_cancel_and_failure() -> None:
    jm = JobManager(workers=1)
    gate = threading.Event()

    def slow(ctx: JobContext):
        gate.wait(5)
        return {"ok": True}

    first = jm.submit("slow", slow, exclusive=True, initial_result={"run_id": "r1"})
    assert first.result == {"run_id": "r1"}
    with pytest.raises(JobBusy) as busy:
        jm.submit("slow", slow, exclusive=True)
    assert busy.value.existing.id == first.id
    queued = jm.submit("other", slow)  # single worker -> stays queued behind `first`
    assert jm.cancel(queued.id).state == JobState.CANCELLED
    gate.set()
    for _ in range(100):
        if jm.get(first.id).state == JobState.SUCCEEDED:
            break
        time.sleep(0.02)
    assert jm.get(first.id).state == JobState.SUCCEEDED and jm.get(first.id).result == {"ok": True}
    time.sleep(0.1)
    assert jm.get(queued.id).state == JobState.CANCELLED  # a cancelled queued job never starts

    def boom(ctx: JobContext):
        raise RuntimeError("nope")

    failed = jm.submit("boom", boom)
    for _ in range(100):
        if jm.get(failed.id).state == JobState.FAILED:
            break
        time.sleep(0.02)
    assert jm.get(failed.id).state == JobState.FAILED and "nope" in (jm.get(failed.id).error or "")
    assert jm.active("slow") is None


def test_jobs_endpoints_404(client: TestClient) -> None:
    assert client.get("/api/v1/jobs/unknown").status_code == 404
    assert client.post("/api/v1/jobs/unknown/cancel").status_code == 404


# ---- morning ------------------------------------------------------------------------------------------------------
def test_morning_stops_when_not_signed_in(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("backend.api.routers.morning.get_session", lambda: None)
    r = client.post("/api/v1/morning/start")
    assert r.status_code == 202
    done = wait_job(client, r.json())
    assert done["state"] == "succeeded"
    res = done["result"]
    assert res["ready_to_go_offline"] is False
    assert [s["id"] for s in res["steps"]] == ["authenticate", "download_bundle", "sync_reference", "ensure_models",
                                              "readiness"]
    assert res["steps"][0]["status"] == "fail" and "sign in" in res["steps"][0]["detail"]
    assert all(s["status"] == "pending" and s["detail"].startswith("skipped") for s in res["steps"][1:])

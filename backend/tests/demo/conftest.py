from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.api.main import create_app
from backend.config import get_settings
from backend.demo import kb
from backend.demo.connectivity import connectivity
from backend.demo.sor.service import reset_sor_singleton
from backend.demo.store import reset_store
from backend.engines.base import LlmEngine, SttEngine, SttResult
from backend.engines.registry import EngineRegistry, set_registry
from backend.engines.simple import ScriptedLlm
from backend.schemas.engines import AvailabilityState, EngineInfo, EngineKind

WORKER, PIN = "w-1001", "1234"
HEADLINE_WO = "WO-10231"


class FakeStt(SttEngine):
    """Stands in for the Foundry Whisper model so morning prep can 'download' and load it without a network."""

    def __init__(self, engine_id: str) -> None:
        self.engine_id = engine_id
        self.loaded = False

    def info(self) -> EngineInfo:
        return EngineInfo(id=self.engine_id, kind=EngineKind.STT, name="fake whisper", provider="mock",
                          availability=AvailabilityState.READY if self.loaded else AvailabilityState.NEEDS_DOWNLOAD,
                          loaded=self.loaded)

    def ensure_ready(self, progress=None) -> float:
        if progress:
            progress(0.5, "downloading")
        self.loaded = True
        return 5.0

    def transcribe_file(self, wav_path: Path) -> SttResult:
        return SttResult(text="", audio_ms=0, stt_ms=0)


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated data directory, fresh singletons, device online, mock engines registered under the manifest ids."""
    monkeypatch.setenv("FV_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    reset_store()
    reset_sor_singleton()
    kb._cache = None
    connectivity.set_online(True)
    settings = get_settings()
    reg = EngineRegistry(foundry=False, azure=False)
    reg.register_stt(settings.manifest_stt_engine, FakeStt(settings.manifest_stt_engine))
    llm: LlmEngine = ScriptedLlm(engine_id=settings.manifest_llm_engine, reply={})
    reg.register_llm(settings.manifest_llm_engine, llm)
    set_registry(reg)
    yield tmp_path
    set_registry(None)
    connectivity.set_online(True)
    reset_store()
    reset_sor_singleton()
    kb._cache = None
    get_settings.cache_clear()


@pytest.fixture()
def client(env):
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture()
def signed_in(client: TestClient) -> TestClient:
    r = client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN})
    assert r.status_code == 200, r.text
    return client


@pytest.fixture()
def with_bundle(signed_in: TestClient) -> TestClient:
    from backend.demo import bundle

    bundle.sync_bundle()
    return signed_in

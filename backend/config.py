"""Application settings. Env prefix ``FV_`` (optionally read from a ``.env`` file)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    """Runtime configuration. Nothing here is a secret default; Azure values come from the environment."""

    model_config = SettingsConfigDict(env_prefix="FV_", env_file=".env", extra="ignore")

    data_dir: Path = REPO_ROOT / "data"
    model_cache_dir: Path = REPO_ROOT / "data" / "models"
    device_profile: str = "dev-box"  # label stored with every eval run, e.g. "latitude-7220"

    foundry_app_name: str = "fieldvoice"
    # Registering Windows ML execution providers exposes GPU/NPU variants, but auto-selection can pick a
    # variant that fails to load, so CPU-only is the default and accelerators are opt-in per engine.
    foundry_register_eps: bool = False
    max_loaded_models: int = 3
    # Which patch prompt the hybrid pipeline sends to the language model (backend/core/prompts.py PATCH_PROMPTS). v4 asks
    # enum fields as {"mentioned", "value"}: far better recall on slang than letting the model answer null (docs/RESULTS.md);
    # v0 is the cautious original (abstains most of the time).
    patch_prompt: str = "v4"

    api_host: str = "127.0.0.1"
    api_port: int = 8010  # used by the scripts\*.bat launchers and the Vite dev proxy (FV_API_PORT); 8000 is often taken by Docker/WSL
    sor_url: str | None = None  # None => in-process mock system of record

    # Models the (mock) system of record lists in every morning bundle: what a worker's device must hold to go offline.
    manifest_stt_engine: str = "foundry:stt:whisper-base:cpu"
    manifest_llm_engine: str = "foundry:llm:qwen2.5-1.5b:cpu"  # a 0.5B model's suggestions are wrong more often than right (docs/RESULTS.md)

    # Optional Azure Speech (reference / comparison engines). Unset => engines report "unavailable".
    azure_speech_key: str | None = None
    azure_speech_region: str | None = None
    embedded_speech_model_path: Path | None = None
    embedded_speech_model_name: str = "Microsoft Speech Recognizer en-US FP Model V8"
    embedded_speech_model_license: str | None = None

    @property
    def datasets_dir(self) -> Path:
        return self.data_dir / "datasets"

    @property
    def runs_dir(self) -> Path:
        return self.data_dir / "runs"

    @property
    def demo_dir(self) -> Path:
        return self.data_dir / "demo"


@lru_cache
def get_settings() -> Settings:
    return Settings()

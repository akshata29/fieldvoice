"""Engines that need no model: oracle transcript, rules-only, and deterministic mocks for tests."""
from __future__ import annotations

import json
from pathlib import Path

from backend.engines.base import LlmEngine, LlmResult, ProgressFn, SttEngine, SttResult
from backend.schemas.engines import NO_LLM_ID, ORACLE_STT_ID, AvailabilityState, EngineInfo, EngineKind


class OracleStt(SttEngine):
    """Uses the dataset's reference transcript instead of running ASR (isolates extraction from ASR errors)."""

    def info(self) -> EngineInfo:
        return EngineInfo(
            id=ORACLE_STT_ID, kind=EngineKind.STT, name="Oracle transcript (no ASR)", provider="oracle",
            availability=AvailabilityState.READY, loaded=True, tags=["reference"],
        )

    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        return 0.0

    def transcribe_file(self, wav_path: Path) -> SttResult:
        raise RuntimeError("oracle transcripts come from the dataset, not from audio")


class NoLlm(LlmEngine):
    """Placeholder for strategies that never call an LLM (``rules_only``)."""

    def info(self) -> EngineInfo:
        return EngineInfo(
            id=NO_LLM_ID, kind=EngineKind.LLM, name="No LLM (rules only)", provider="rules",
            availability=AvailabilityState.READY, loaded=True, tags=["baseline"],
        )

    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        return 0.0

    def complete(self, system: str, user: str, **kwargs: object) -> LlmResult:  # type: ignore[override]
        raise RuntimeError("rules-only configuration must not call the LLM")


class ScriptedLlm(LlmEngine):
    """Deterministic test double: returns a canned JSON object (or a callable's result) and records the calls."""

    def __init__(self, engine_id: str = "mock:llm:scripted", reply: dict | str | None = None) -> None:
        self.engine_id = engine_id
        self.reply = reply
        self.calls: list[dict] = []

    def info(self) -> EngineInfo:
        return EngineInfo(
            id=self.engine_id, kind=EngineKind.LLM, name="Scripted LLM (test double)", provider="mock",
            availability=AvailabilityState.READY, loaded=True, tags=["mock"],
        )

    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        return 0.0

    def complete(self, system: str, user: str, *, response_format: dict | None = None, max_tokens: int = 200,
                 temperature: float = 0.0) -> LlmResult:
        self.calls.append({"system": system, "user": user, "response_format": response_format})
        reply = self.reply(system, user) if callable(self.reply) else self.reply
        text = reply if isinstance(reply, str) else json.dumps(reply or {})
        return LlmResult(text=text, total_ms=1.0, prompt_tokens=len(system.split()) + len(user.split()),
                         output_tokens=len(text.split()))

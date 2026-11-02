"""Foundry Local STT and LLM engines (thin wrappers over :mod:`backend.engines.foundry_runtime`)."""
from __future__ import annotations

import logging
import time
import wave
from pathlib import Path

from backend.engines.base import (
    EngineError,
    LlmEngine,
    LlmResult,
    ProgressFn,
    SerialLock,
    SttEngine,
    SttResult,
    SttStream,
)
from backend.engines.foundry_runtime import FoundryRuntime, VariantSpec, get_runtime
from backend.schemas.engines import AvailabilityState, EngineInfo, EngineKind

log = logging.getLogger(__name__)

STREAMING_ALIASES = ("nemotron",)  # Foundry's StreamingProcessor accepts Nemotron (and Moonshine); Whisper is file-only
REASONING_HINTS = ("deepseek-r1", "reasoning")


def _size_tier(size_mb: float | None) -> str | None:
    if size_mb is None:
        return None
    return "tier-s" if size_mb <= 900 else "tier-m" if size_mb <= 2000 else "tier-l" if size_mb <= 3200 else "tier-xl"


class _FoundryBase:
    def __init__(self, spec: VariantSpec, runtime: FoundryRuntime | None = None) -> None:
        self.spec = spec
        self.rt = runtime or get_runtime()
        self._lock = SerialLock()
        self._loaded_at: float | None = None

    def _ensure_loaded(self, progress: ProgressFn | None = None) -> float:
        """Download (if needed) and load. Returns the load time in ms (0.0 when it was already loaded)."""
        if self.rt.is_loaded(self.spec):
            return 0.0
        if not self.rt.is_cached(self.spec):
            if progress:
                progress(0.0, f"Downloading {self.spec.alias} ({self.spec.device})")
            self.rt.download(self.spec, lambda f: progress(0.9 * f, f"Downloading {self.spec.alias}") if progress else None)
        if progress:
            progress(0.92, f"Loading {self.spec.alias}")
        t0 = time.perf_counter()
        try:
            self.rt.load(self.spec)
        except Exception as exc:
            raise EngineError(f"failed to load {self.spec.id}: {exc}") from exc
        ms = (time.perf_counter() - t0) * 1000.0
        self._loaded_at = time.time()
        if progress:
            progress(1.0, f"{self.spec.alias} ready")
        return ms

    def unload(self) -> None:
        self.rt.unload(self.spec)

    def _availability(self) -> tuple[AvailabilityState, str | None]:
        if self.rt.is_cached(self.spec):
            return AvailabilityState.READY, None
        return AvailabilityState.NEEDS_DOWNLOAD, f"{self.spec.size_mb:.0f} MB download" if self.spec.size_mb else "download required"


class FoundrySttEngine(_FoundryBase, SttEngine):
    def info(self) -> EngineInfo:
        state, reason = self._availability()
        s = self.spec
        tags = [t for t in (_size_tier(s.size_mb),) if t]
        if s.alias.startswith(("nemotron", "parakeet")):
            tags.append("streaming-model")
        return EngineInfo(
            id=f"foundry:stt:{s.alias}:{s.device}", kind=EngineKind.STT, name=f"{s.alias} ({s.device})",
            provider="foundry", offline=True, supports_streaming=s.alias.startswith(STREAMING_ALIASES),
            availability=state, availability_reason=reason, alias=s.alias, variant_id=s.id, device=s.device,
            execution_provider=s.execution_provider, size_mb=s.size_mb, loaded=self.rt.is_loaded(s), tags=tags,
        )

    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        return self._ensure_loaded(progress)

    def transcribe_file(self, wav_path: Path) -> SttResult:
        self._ensure_loaded()
        with self._lock:
            try:
                return self.rt.transcribe(self.spec, wav_path)
            except Exception as exc:
                if "does not support audio processing" in str(exc):  # streaming-only models (Parakeet/Nemotron)
                    return self._transcribe_via_stream(wav_path)
                raise EngineError(f"transcription failed: {exc}") from exc

    def _transcribe_via_stream(self, wav_path: Path) -> SttResult:
        with wave.open(str(wav_path), "rb") as w:
            rate, pcm = w.getframerate(), w.readframes(w.getnframes())
        stream = self.rt.open_live(self.spec, rate)
        t0 = time.perf_counter()
        step = int(rate * 0.1) * 2
        try:
            for i in range(0, len(pcm), step):
                stream.push(pcm[i:i + step])
            res = stream.finish()
        finally:
            stream.close()
        res.stt_ms = (time.perf_counter() - t0) * 1000.0
        res.audio_ms = 1000.0 * (len(pcm) / 2) / rate
        return res

    def open_stream(self, sample_rate: int = 16000) -> SttStream:
        self._ensure_loaded()
        return self.rt.open_live(self.spec, sample_rate)


class FoundryLlmEngine(_FoundryBase, LlmEngine):
    def info(self) -> EngineInfo:
        state, reason = self._availability()
        s = self.spec
        tags = [t for t in (_size_tier(s.size_mb),) if t]
        if s.tool_calling:
            tags.append("tool-calling")
        if "image" in s.input_modalities:
            tags.append("vision")
        if "audio" in s.input_modalities:
            tags.append("audio-in")
        if any(h in s.alias for h in REASONING_HINTS):
            tags.append("reasoning")  # emits long thinking traces: poor fit for low-latency extraction
        return EngineInfo(
            id=f"foundry:llm:{s.alias}:{s.device}", kind=EngineKind.LLM, name=f"{s.alias} ({s.device})",
            provider="foundry", offline=True, availability=state, availability_reason=reason, alias=s.alias,
            variant_id=s.id, device=s.device, execution_provider=s.execution_provider, size_mb=s.size_mb,
            loaded=self.rt.is_loaded(s), tags=tags,
        )

    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        return self._ensure_loaded(progress)

    def complete(self, system: str, user: str, *, response_format: dict | None = None, max_tokens: int = 200,
                 temperature: float = 0.0) -> LlmResult:
        self._ensure_loaded()
        with self._lock:
            try:
                return self.rt.chat(self.spec, system, user, response_format, max_tokens, temperature)
            except Exception as exc:
                raise EngineError(f"chat completion failed: {exc}") from exc

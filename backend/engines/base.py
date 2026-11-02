"""Engine abstractions: speech-to-text engines and LLM engines the pipeline and the eval harness plug into."""
from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from backend.schemas.engines import EngineInfo

ProgressFn = Callable[[float, str], None]


@dataclass
class SttResult:
    text: str
    audio_ms: float = 0.0
    stt_ms: float = 0.0  # inference wall time (excludes one-off model load)
    segments: list[str] = field(default_factory=list)


@dataclass
class SttEvent:
    text: str  # interim text, or the delta for subword streamers
    final: bool = False
    t_ms: float = 0.0
    replace: bool = True  # True: replaces the previous partial; False: append (subword streamers)


class SttStream(ABC):
    """Push PCM16 mono audio, poll for interim events, finish to get the final transcript."""

    @abstractmethod
    def push(self, pcm16: bytes) -> None: ...

    @abstractmethod
    def drain(self) -> list[SttEvent]:
        """Interim events produced since the last call (non-blocking)."""

    @abstractmethod
    def finish(self) -> SttResult: ...

    def close(self) -> None:  # pragma: no cover - default no-op
        return None


class SttEngine(ABC):
    @abstractmethod
    def info(self) -> EngineInfo: ...

    @abstractmethod
    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        """Make the engine usable (download + load). Returns load time in ms (0 when already loaded)."""

    @abstractmethod
    def transcribe_file(self, wav_path: Path) -> SttResult: ...

    def open_stream(self, sample_rate: int = 16000) -> SttStream:
        raise NotImplementedError("engine does not support streaming")

    def unload(self) -> None:  # pragma: no cover - default no-op
        return None


@dataclass
class LlmResult:
    text: str
    total_ms: float = 0.0
    prompt_tokens: int | None = None
    output_tokens: int | None = None
    ttft_ms: float | None = None


class LlmEngine(ABC):
    @abstractmethod
    def info(self) -> EngineInfo: ...

    @abstractmethod
    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        """Download + load. Returns load time in ms (0 when already loaded)."""

    @abstractmethod
    def complete(
        self,
        system: str,
        user: str,
        *,
        response_format: dict | None = None,
        max_tokens: int = 200,
        temperature: float = 0.0,
    ) -> LlmResult:
        """Run one chat completion. ``response_format`` follows the Foundry/OpenAI shape, e.g.
        ``{"type": "lark_grammar", "lark_grammar": "..."}`` or ``{"type": "json_schema", "json_schema": {...}}``."""

    def unload(self) -> None:  # pragma: no cover - default no-op
        return None


class EngineError(RuntimeError):
    """Raised when an engine cannot run (missing SDK, model not available, load failure)."""


class SerialLock:
    """One inference at a time per engine (CPU contention would distort latency and risks native-session misuse)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()

    def __enter__(self) -> None:
        self._lock.acquire()

    def __exit__(self, *exc: object) -> None:
        self._lock.release()

"""Foundry Local runtime wrapper: initialization, catalog, and the session-level primitives the engines use.

Uses the supported ``ChatSession`` / ``AudioSession`` API (the OpenAI-style clients are deprecated and slated for
removal at the end of 2026) and builds OpenAI-format request JSON itself, which also lets us pass grammar objects
(`json_schema` as an object, `lark_grammar`) that the SDK's string-only client validator rejected in 2.2.1.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.config import get_settings
from backend.engines.base import EngineError, LlmResult, SttEvent, SttResult, SttStream
from backend.schemas.api import CatalogModel, CatalogVariant
from backend.schemas.system import FoundryStatus

log = logging.getLogger(__name__)

CHAT_TASKS = {"chat-completion", "coding", "vision-language-chat"}
STT_TASK = "automatic-speech-recognition"


@dataclass
class VariantSpec:
    alias: str
    task: str
    id: str
    device: str  # cpu | gpu | npu
    execution_provider: str
    size_mb: float | None
    publisher: str | None
    license: str | None
    input_modalities: list[str]
    tool_calling: bool | None
    variant: Any  # foundry_local_sdk IModel (a concrete variant)

    @property
    def key(self) -> str:
        return f"{self.alias}:{self.device}"


class FoundryRuntime:
    """Process-wide Foundry Local manager (lazy, thread-safe)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._mgr: Any = None
        self._error: str | None = None
        self._specs: list[VariantSpec] | None = None
        self._eps_registered = False

    # ---- lifecycle -------------------------------------------------------------------------------------------
    def ensure(self) -> None:
        with self._lock:
            if self._mgr is not None:
                return
            if self._error is not None:
                raise EngineError(self._error)
            try:
                from foundry_local_sdk import Configuration, FoundryLocalManager
            except Exception as exc:  # SDK not installed
                self._error = f"foundry-local-sdk is not installed ({exc})"
                raise EngineError(self._error) from exc
            settings = get_settings()
            try:
                settings.model_cache_dir.mkdir(parents=True, exist_ok=True)
                try:
                    FoundryLocalManager.initialize(
                        Configuration(app_name=settings.foundry_app_name, model_cache_dir=str(settings.model_cache_dir)))
                except Exception:
                    # already initialized elsewhere in this process: reuse the singleton
                    if getattr(FoundryLocalManager, "instance", None) is None:
                        raise
                self._mgr = FoundryLocalManager.instance
                if settings.foundry_register_eps:
                    self._mgr.download_and_register_eps()
                    self._eps_registered = True
            except Exception as exc:
                self._error = f"Foundry Local failed to initialize: {exc}"
                log.exception("foundry init failed")
                raise EngineError(self._error) from exc

    @property
    def available(self) -> bool:
        try:
            self.ensure()
            return True
        except EngineError:
            return False

    def status(self) -> FoundryStatus:
        version = None
        try:
            from importlib.metadata import version as _v
            version = _v("foundry-local-sdk")
        except Exception:
            pass
        try:
            self.ensure()
            return FoundryStatus(
                available=True, sdk_version=version, catalog_count=len({s.alias for s in self.specs()}),
                eps_registered=self._eps_registered, model_cache_dir=str(get_settings().model_cache_dir))
        except EngineError as exc:
            return FoundryStatus(available=False, sdk_version=version, error=str(exc),
                                 model_cache_dir=str(get_settings().model_cache_dir))

    # ---- catalog ---------------------------------------------------------------------------------------------
    def specs(self, refresh: bool = False) -> list[VariantSpec]:
        self.ensure()
        with self._lock:
            if self._specs is not None and not refresh:
                return self._specs
            specs: list[VariantSpec] = []
            for model in self._mgr.catalog.list_models():
                for v in model.variants or [model]:
                    info = v.info
                    rt = info.runtime
                    dev = getattr(getattr(rt, "device_type", None), "name", "CPU").lower()
                    mods = [m.strip() for m in str(info.input_modalities or "text").split(",") if m.strip()]
                    specs.append(VariantSpec(
                        alias=info.alias or model.alias, task=info.task or "", id=info.id, device=dev,
                        execution_provider=getattr(rt, "execution_provider", "") or "",
                        size_mb=float(info.file_size_mb) if info.file_size_mb else None,
                        publisher=info.publisher, license=info.license, input_modalities=mods,
                        tool_calling=info.supports_tool_calling, variant=v))
            self._specs = specs
            return specs

    def find(self, alias: str, device: str = "cpu") -> VariantSpec:
        for s in self.specs():
            if s.alias == alias and s.device == device:
                return s
        raise EngineError(f"model {alias!r} has no {device} variant in the catalog")

    def catalog(self) -> list[CatalogModel]:
        grouped: dict[str, CatalogModel] = {}
        for s in self.specs():
            cm = grouped.setdefault(s.alias, CatalogModel(
                alias=s.alias, task=s.task, publisher=s.publisher, license=s.license,
                input_modalities=s.input_modalities, supports_tool_calling=s.tool_calling))
            try:
                cached = bool(s.variant.is_cached)
            except Exception:
                cached = False
            cm.variants.append(CatalogVariant(id=s.id, device=s.device, execution_provider=s.execution_provider,
                                              size_mb=s.size_mb, cached=cached))
        return sorted(grouped.values(), key=lambda c: (c.task, c.alias))

    # ---- model lifecycle -------------------------------------------------------------------------------------
    @staticmethod
    def download(spec: VariantSpec, progress: Any | None = None) -> None:
        def cb(value: float) -> None:
            if progress:
                frac = value / 100.0 if value > 1.0 else value
                progress(max(0.0, min(1.0, frac)))

        spec.variant.download(cb)

    @staticmethod
    def is_cached(spec: VariantSpec) -> bool:
        try:
            return bool(spec.variant.is_cached)
        except Exception:
            return False

    @staticmethod
    def is_loaded(spec: VariantSpec) -> bool:
        try:
            return bool(spec.variant.is_loaded)
        except Exception:
            return False

    @staticmethod
    def load(spec: VariantSpec) -> None:
        spec.variant.load()

    @staticmethod
    def unload(spec: VariantSpec) -> None:
        try:
            spec.variant.unload()
        except Exception as exc:
            log.warning("unload %s failed: %s", spec.id, exc)

    # ---- inference primitives --------------------------------------------------------------------------------
    @staticmethod
    def chat(spec: VariantSpec, system: str, user: str, response_format: dict | None, max_tokens: int,
             temperature: float) -> LlmResult:
        from foundry_local_sdk.items import TextItem, TextItemType
        from foundry_local_sdk.request import Request
        from foundry_local_sdk.session import ChatSession

        body: dict[str, Any] = {
            "model": spec.id,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format:
            body["response_format"] = response_format
        t0 = time.perf_counter()
        with ChatSession(spec.variant) as session, Request() as request:
            request.add_item(TextItem(json.dumps(body), TextItemType.OPENAI_JSON))
            with session.process_request(request) as response:
                raw = response.get_item(0).text
                usage = response.get_usage()
        total_ms = (time.perf_counter() - t0) * 1000.0
        try:
            data = json.loads(raw)
            text = data["choices"][0]["message"].get("content") or ""
        except Exception:
            text = raw
        return LlmResult(text=text, total_ms=total_ms, prompt_tokens=usage.prompt_tokens,
                         output_tokens=usage.completion_tokens)

    @staticmethod
    def transcribe(spec: VariantSpec, wav_path: Path, language: str = "en") -> SttResult:
        from foundry_local_sdk.items import TextItem, TextItemType
        from foundry_local_sdk.request import Request
        from foundry_local_sdk.session import AudioSession

        body = {"model": spec.id, "filename": str(wav_path), "language": language, "temperature": 0.0}
        t0 = time.perf_counter()
        with AudioSession(spec.variant) as session, Request() as request:
            request.add_item(TextItem(json.dumps(body), TextItemType.OPENAI_JSON))
            with session.process_request(request) as response:
                raw = response.get_item(0).text
        stt_ms = (time.perf_counter() - t0) * 1000.0
        text = json.loads(raw).get("text", "")
        return SttResult(text=text.strip(), audio_ms=wav_duration_ms(wav_path), stt_ms=stt_ms)

    def open_live(self, spec: VariantSpec, sample_rate: int, language: str = "en") -> SttStream:
        return FoundryLiveStream(spec, sample_rate, language)


def wav_duration_ms(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return 1000.0 * w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


class FoundryLiveStream(SttStream):
    """Live transcription on the supported ``AudioSession`` API (push PCM16, poll interim text, finish)."""

    def __init__(self, spec: VariantSpec, sample_rate: int, language: str = "en") -> None:
        from foundry_local_sdk.item_queue import ItemQueue
        from foundry_local_sdk.items import AudioItem
        from foundry_local_sdk.request import Request
        from foundry_local_sdk.session import AudioSession
        from foundry_local_sdk.session_types import RequestOptions

        self._spec = spec
        self._t0 = time.perf_counter()
        self._lock = threading.Lock()
        self._events: list[SttEvent] = []
        self._pieces: list[str] = []  # committed text, in order
        self._current = ""  # evolving hypothesis for the in-progress segment
        self._final_text: str | None = None
        self._error: BaseException | None = None
        self._pushed_bytes = 0
        self._sample_rate = sample_rate
        self._queue = ItemQueue()
        self._session = AudioSession(spec.variant)
        self._session.set_streaming(True)
        self._request = Request()
        self._request.set_options(RequestOptions(additional_options={"language": language}))
        self._request.add_item(AudioItem.create_format_descriptor("pcm", sample_rate, 1))
        self._request.add_item(self._queue, transfer_ownership=False)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        from foundry_local_sdk.items import SpeechResultItem, SpeechSegmentItem, SpeechSegmentKind

        try:
            with self._session.process_streaming_request(self._request) as stream:
                for item in stream:
                    if isinstance(item, SpeechSegmentItem) and item.text:
                        self._on_segment(item.text, item.kind == SpeechSegmentKind.FINAL)
                with stream.final_response as final:
                    for it in final:
                        if isinstance(it, SpeechResultItem) and it.text:
                            self._final_text = it.text
                            break
        except BaseException as exc:  # noqa: BLE001
            self._error = exc
            log.warning("live transcription failed: %s", exc)

    def _on_segment(self, text: str, final: bool) -> None:
        t_ms = (time.perf_counter() - self._t0) * 1000.0
        with self._lock:
            if final:
                self._pieces.append(text)
                self._current = ""
            else:
                self._current = text
            shown = (" ".join(p.strip() for p in self._pieces) + " " + self._current.strip()).strip() \
                if not final else " ".join(p.strip() for p in self._pieces).strip()
            self._events.append(SttEvent(text=shown, final=False, t_ms=t_ms, replace=True))

    def push(self, pcm16: bytes) -> None:
        from foundry_local_sdk.items import BytesItem

        self._pushed_bytes += len(pcm16)
        self._queue.push(BytesItem(pcm16))

    def drain(self) -> list[SttEvent]:
        with self._lock:
            ev, self._events = self._events, []
            return ev

    def finish(self) -> SttResult:
        t0 = time.perf_counter()
        self._queue.mark_finished()
        self._thread.join(timeout=60)
        if self._error is not None and self._final_text is None and not self._pieces:
            raise EngineError(f"live transcription failed: {self._error}")
        with self._lock:
            text = self._final_text or " ".join(p.strip() for p in self._pieces).strip() or self._current.strip()
        audio_ms = 1000.0 * (self._pushed_bytes / 2) / float(self._sample_rate)
        return SttResult(text=text.strip(), audio_ms=audio_ms, stt_ms=(time.perf_counter() - t0) * 1000.0)

    def close(self) -> None:
        for obj in (self._request, self._queue, self._session):
            try:
                obj._close()
            except Exception:
                pass


_runtime = FoundryRuntime()


def get_runtime() -> FoundryRuntime:
    return _runtime

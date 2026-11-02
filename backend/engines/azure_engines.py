"""Azure Speech engines: embedded (on-device, limited access, Windows 11+) and cloud (reference only, not offline).

Both are written against the documented Speech SDK API and are UNTESTED in this repository: the embedded engine
needs limited-access approval (https://aka.ms/csgate-embedded-speech) and downloaded models + a license key; the cloud
engine needs a key and the network. Input must be 16 kHz mono PCM16 WAV (what the synthetic dataset produces).
"""
from __future__ import annotations

import logging
import platform
import threading
import time
from pathlib import Path

from backend.config import get_settings
from backend.engines.base import EngineError, ProgressFn, SerialLock, SttEngine, SttResult
from backend.engines.foundry_runtime import wav_duration_ms
from backend.schemas.engines import AvailabilityState, EngineInfo, EngineKind

log = logging.getLogger(__name__)


def _speechsdk():
    import azure.cognitiveservices.speech as speechsdk  # type: ignore

    return speechsdk


def _recognize_file(config, wav_path: Path) -> str:
    """Continuous recognition over a whole WAV file; returns the concatenated final text."""
    speechsdk = _speechsdk()
    audio = speechsdk.audio.AudioConfig(filename=str(wav_path))
    recognizer = speechsdk.SpeechRecognizer(speech_config=config, audio_config=audio)
    done = threading.Event()
    parts: list[str] = []
    errors: list[str] = []

    def on_recognized(evt) -> None:
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
            parts.append(evt.result.text)

    def on_canceled(evt) -> None:
        if evt.reason == speechsdk.CancellationReason.Error:
            errors.append(str(evt.error_details))
        done.set()

    recognizer.recognized.connect(on_recognized)
    recognizer.session_stopped.connect(lambda evt: done.set())
    recognizer.canceled.connect(on_canceled)
    recognizer.start_continuous_recognition()
    done.wait(timeout=120)
    recognizer.stop_continuous_recognition()
    if errors:
        raise EngineError("; ".join(errors))
    return " ".join(parts).strip()


class AzureEmbeddedStt(SttEngine):
    ENGINE_ID = "azure-embedded:stt:en-US"

    def __init__(self) -> None:
        self._config = None
        self._lock = SerialLock()

    def _reason_unavailable(self) -> str | None:
        s = get_settings()
        if platform.system() != "Windows":
            return "embedded speech is only configured for Windows 11+ in this project"
        try:
            _speechsdk()
        except Exception:
            return "azure-cognitiveservices-speech-embedded is not installed (see backend/requirements-optional.txt)"
        if not (s.embedded_speech_model_path and Path(s.embedded_speech_model_path).exists()):
            return "limited-access approval + FV_EMBEDDED_SPEECH_MODEL_PATH required (https://aka.ms/csgate-embedded-speech)"
        if not s.embedded_speech_model_license:
            return "FV_EMBEDDED_SPEECH_MODEL_LICENSE is not set"
        return None

    def info(self) -> EngineInfo:
        why = self._reason_unavailable()
        return EngineInfo(
            id=self.ENGINE_ID, kind=EngineKind.STT, name="Azure Speech embedded en-US (on-device)",
            provider="azure-embedded", offline=True,
            availability=AvailabilityState.UNAVAILABLE if why else AvailabilityState.READY,
            availability_reason=why, loaded=self._config is not None,
            tags=["windows-11-plus", "no-ios", "limited-access", "16khz-mono-pcm"],
        )

    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        why = self._reason_unavailable()
        if why:
            raise EngineError(why)
        if self._config is not None:
            return 0.0
        t0 = time.perf_counter()
        s = get_settings()
        speechsdk = _speechsdk()
        cfg = speechsdk.EmbeddedSpeechConfig.from_path(str(s.embedded_speech_model_path))
        cfg.set_speech_recognition_model(s.embedded_speech_model_name, s.embedded_speech_model_license)
        self._config = cfg
        return (time.perf_counter() - t0) * 1000.0

    def transcribe_file(self, wav_path: Path) -> SttResult:
        self.ensure_ready()
        with self._lock:
            t0 = time.perf_counter()
            text = _recognize_file(self._config, wav_path)
            return SttResult(text=text, audio_ms=wav_duration_ms(wav_path), stt_ms=(time.perf_counter() - t0) * 1000.0)

    def unload(self) -> None:
        self._config = None


class AzureCloudStt(SttEngine):
    ENGINE_ID = "azure-cloud:stt:default"

    def __init__(self) -> None:
        self._config = None
        self._lock = SerialLock()

    def _reason_unavailable(self) -> str | None:
        s = get_settings()
        try:
            _speechsdk()
        except Exception:
            return "azure-cognitiveservices-speech is not installed (see backend/requirements-optional.txt)"
        if not (s.azure_speech_key and s.azure_speech_region):
            return "FV_AZURE_SPEECH_KEY and FV_AZURE_SPEECH_REGION are not set"
        return None

    def info(self) -> EngineInfo:
        why = self._reason_unavailable()
        return EngineInfo(
            id=self.ENGINE_ID, kind=EngineKind.STT, name="Azure Speech cloud (reference ceiling)", provider="azure-cloud",
            offline=False, availability=AvailabilityState.UNAVAILABLE if why else AvailabilityState.READY,
            availability_reason=why, loaded=self._config is not None,
            tags=["reference", "needs-network", "excluded-from-offline-decisions"],
        )

    def ensure_ready(self, progress: ProgressFn | None = None) -> float:
        why = self._reason_unavailable()
        if why:
            raise EngineError(why)
        if self._config is None:
            s = get_settings()
            speechsdk = _speechsdk()
            cfg = speechsdk.SpeechConfig(subscription=s.azure_speech_key, region=s.azure_speech_region)
            cfg.speech_recognition_language = "en-US"
            self._config = cfg
        return 0.0

    def transcribe_file(self, wav_path: Path) -> SttResult:
        self.ensure_ready()
        with self._lock:
            t0 = time.perf_counter()
            text = _recognize_file(self._config, wav_path)
            return SttResult(text=text, audio_ms=wav_duration_ms(wav_path), stt_ms=(time.perf_counter() - t0) * 1000.0)

    def unload(self) -> None:
        self._config = None

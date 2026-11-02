"""Voice-to-form: REST extraction (text / sample / uploaded audio) and the live WebSocket session."""
from __future__ import annotations

import asyncio
import io
import json
import logging
import wave
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from backend.api.context import ExtractionContext, load_sample, resolve_context
from backend.api.voice_service import ensure_loaded, run_extraction, transcribe_wav, write_wav
from backend.engines.base import EngineError, SttResult, SttStream
from backend.engines.registry import get_registry
from backend.schemas.api import ExtractRequest
from backend.schemas.engines import NO_LLM_ID, ORACLE_STT_ID
from backend.schemas.extraction import ExtractionResult

log = logging.getLogger(__name__)
router = APIRouter(tags=["voice"])


# ---- REST ----------------------------------------------------------------------------------------------------
@router.post("/api/v1/voice/extract", response_model=ExtractionResult)
def extract(req: ExtractRequest) -> ExtractionResult:
    ctx = resolve_context(req.work_order_id, req.form_id, req.sample_id)
    stt: SttResult | None = None
    warnings: list[str] = []
    if ctx.sample is not None:
        audio = ctx.dataset.audio_path(ctx.sample) if ctx.dataset else None
        if req.stt_engine_id != ORACLE_STT_ID and audio is not None:
            stt = transcribe_wav(req.stt_engine_id, audio)
            transcript = stt.text
        else:
            transcript = ctx.sample.written_text
            if req.stt_engine_id != ORACLE_STT_ID:
                warnings.append("sample has no audio; the reference transcript was used instead of speech recognition")
    elif req.transcript is not None:
        transcript = req.transcript
    else:
        raise HTTPException(422, detail="provide transcript or sample_id (or upload audio)")
    result = run_extraction(ctx, transcript, req.strategy_id, req.llm_engine_id,
                            req.stt_engine_id if stt else None, stt)
    result.warnings.extend(warnings)
    return result


@router.post("/api/v1/voice/extract-audio", response_model=ExtractionResult)
async def extract_audio(
    audio: UploadFile = File(...),
    work_order_id: str | None = Form(None),
    form_id: str | None = Form(None),
    stt_engine_id: str = Form(...),
    llm_engine_id: str = Form(NO_LLM_ID),
    strategy_id: str = Form("hybrid"),
) -> ExtractionResult:
    data = await audio.read()
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2:
                raise HTTPException(415, detail="audio must be mono 16-bit PCM WAV")
            rate, pcm = w.getframerate(), w.readframes(w.getnframes())
    except wave.Error:
        raise HTTPException(415, detail="audio must be a PCM WAV file (16 kHz mono recommended)") from None

    def work() -> ExtractionResult:
        ctx = resolve_context(work_order_id, form_id, None)
        path = write_wav(pcm, rate)
        try:
            stt = transcribe_wav(stt_engine_id, path)
        finally:
            path.unlink(missing_ok=True)
        return run_extraction(ctx, stt.text, strategy_id, llm_engine_id, stt_engine_id, stt)

    return await run_in_threadpool(work)


# ---- WebSocket -----------------------------------------------------------------------------------------------
class VoiceSession:
    """One live capture: audio in, interim transcript + progressive field events out (CONTRACT.md section 7)."""

    CHUNK_MS = 100

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.loop = asyncio.get_running_loop()
        self.out: asyncio.Queue[dict | None] = asyncio.Queue()
        self.sender = asyncio.create_task(self._sender())
        self.cfg: dict = {}
        self.ctx: ExtractionContext | None = None
        self.stream: SttStream | None = None
        self.stt_engine_id = ORACLE_STT_ID
        self.rate = 16000
        self.buffer = bytearray()
        self.poller: asyncio.Task | None = None
        self.busy = False
        self._closed = False

    # -- plumbing
    async def _sender(self) -> None:
        while True:
            ev = await self.out.get()
            if ev is None:
                return
            try:
                await self.ws.send_json(ev)
            except Exception:
                return

    async def send(self, ev: dict) -> None:
        await self.out.put(ev)

    def send_threadsafe(self, ev: dict) -> None:
        self.loop.call_soon_threadsafe(self.out.put_nowait, ev)

    async def close(self) -> None:
        self._closed = True
        if self.poller:
            self.poller.cancel()
        if self.stream is not None:
            try:
                await run_in_threadpool(self.stream.close)
            except Exception:
                pass
            self.stream = None
        await self.out.put(None)
        try:
            await asyncio.wait_for(self.sender, timeout=2)
        except Exception:
            pass

    async def error(self, message: str) -> None:
        self.busy = False
        await self.send({"type": "error", "message": message})

    # -- main loop
    async def run(self) -> None:
        while True:
            msg = await self.ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("bytes") is not None:
                await self._on_audio(msg["bytes"])
            elif msg.get("text") is not None:
                try:
                    data = json.loads(msg["text"])
                except json.JSONDecodeError:
                    await self.error("invalid JSON message")
                    continue
                await self._on_message(data)

    async def _on_message(self, data: dict) -> None:
        kind = data.get("type")
        try:
            if kind == "start":
                await self._start(data)
            elif kind == "stop":
                await self._finalize()
            elif kind == "play_sample":
                await self._play_sample(data)
            elif kind == "cancel":
                await self._reset()
            else:
                await self.error(f"unknown message type {kind!r}")
        except HTTPException as exc:
            detail = exc.detail.get("message") if isinstance(exc.detail, dict) else exc.detail
            await self.error(str(detail))
        except EngineError as exc:
            await self.error(str(exc))
        except Exception as exc:
            log.exception("voice session error")
            await self.error(f"{type(exc).__name__}: {exc}")

    async def _reset(self) -> None:
        if self.poller:
            self.poller.cancel()
            self.poller = None
        if self.stream is not None:
            await run_in_threadpool(self.stream.close)
            self.stream = None
        self.buffer.clear()
        self.busy = False

    async def _start(self, data: dict) -> None:
        await self._reset()
        self.cfg = {
            "work_order_id": data.get("work_order_id"), "form_id": data.get("form_id"),
            "llm_engine_id": data.get("llm_engine_id") or NO_LLM_ID,
            "strategy_id": data.get("strategy_id") or "hybrid",
        }
        self.stt_engine_id = data.get("stt_engine_id") or ORACLE_STT_ID
        self.rate = int(data.get("sample_rate") or 16000)
        self.ctx = await run_in_threadpool(resolve_context, self.cfg["work_order_id"], self.cfg["form_id"], None)
        if self.stt_engine_id != ORACLE_STT_ID:
            await run_in_threadpool(ensure_loaded, self.stt_engine_id, "STT")
            engine = get_registry().get_stt(self.stt_engine_id)
            if engine.info().supports_streaming:
                try:
                    self.stream = await run_in_threadpool(engine.open_stream, self.rate)
                    self.poller = asyncio.create_task(self._poll())
                except Exception as exc:  # no live mode in this runtime: buffer the audio and transcribe at the end
                    log.warning("live streaming unavailable for %s (%s); using buffered transcription",
                                self.stt_engine_id, exc)
                    self.stream = None
        await self.send({"type": "ready"})

    async def _poll(self) -> None:
        last = ""
        while not self._closed and self.stream is not None:
            await asyncio.sleep(0.1)
            stream = self.stream
            if stream is None:
                return
            events = stream.drain()
            if events:
                text = events[-1].text
                if text != last:
                    last = text
                    await self.send({"type": "partial", "text": text, "t_ms": round(events[-1].t_ms, 1)})

    async def _on_audio(self, data: bytes) -> None:
        if self.stream is not None:
            await run_in_threadpool(self.stream.push, data)
        else:
            self.buffer.extend(data)

    async def _play_sample(self, data: dict) -> None:
        sample_id = data.get("sample_id")
        if not sample_id:
            await self.error("sample_id is required")
            return
        realtime = bool(data.get("realtime", True))
        if self.ctx is None:
            await self._start({"type": "start"} | {k: v for k, v in data.items() if k != "type"})
        ds, case = await run_in_threadpool(load_sample, sample_id)
        self.ctx = await run_in_threadpool(resolve_context, self.cfg.get("work_order_id"), self.cfg.get("form_id"),
                                           sample_id)
        audio = ds.audio_path(case)
        if self.stt_engine_id == ORACLE_STT_ID or audio is None:
            words = case.written_text.split()
            if realtime:
                for i in range(1, len(words) + 1):
                    await self.send({"type": "partial", "text": " ".join(words[:i]), "t_ms": i * 120.0})
                    await asyncio.sleep(0.12)
            await self._finalize(transcript_override=case.written_text)
            return
        with wave.open(str(audio), "rb") as w:
            rate, pcm = w.getframerate(), w.readframes(w.getnframes())
        if rate != self.rate and self.stream is not None:
            await self.error(f"sample rate {rate} differs from session rate {self.rate}")
            return
        step = int(rate * self.CHUNK_MS / 1000) * 2
        for i in range(0, len(pcm), step):
            await self._on_audio(pcm[i:i + step])
            if realtime:
                await asyncio.sleep(self.CHUNK_MS / 1000)
        await self._finalize()

    async def _finalize(self, transcript_override: str | None = None) -> None:
        if self.busy or self.ctx is None:
            return
        self.busy = True
        stt: SttResult | None = None
        if transcript_override is not None:
            text = transcript_override
            await self.send({"type": "transcript", "text": text, "final": True, "stt_ms": 0.0, "audio_ms": 0.0})
        else:
            if self.stream is not None:
                if self.poller:
                    self.poller.cancel()
                    self.poller = None
                stream, self.stream = self.stream, None
                try:
                    stt = await run_in_threadpool(stream.finish)
                finally:
                    await run_in_threadpool(stream.close)
            elif self.buffer and self.stt_engine_id != ORACLE_STT_ID:
                path: Path = write_wav(bytes(self.buffer), self.rate)
                self.buffer.clear()
                try:
                    stt = await run_in_threadpool(transcribe_wav, self.stt_engine_id, path)
                finally:
                    path.unlink(missing_ok=True)
            else:
                await self.error("no audio received")
                return
            text = stt.text
            await self.send({"type": "transcript", "text": text, "final": True, "stt_ms": round(stt.stt_ms, 1),
                             "audio_ms": round(stt.audio_ms, 1)})
            await self.send({"type": "stage", "stage": "stt", "ms": round(stt.stt_ms, 1)})
        ctx = self.ctx
        result = await run_in_threadpool(
            run_extraction, ctx, text, self.cfg["strategy_id"], self.cfg["llm_engine_id"],
            self.stt_engine_id if stt else None, stt, self.send_threadsafe)
        await self.send({"type": "result", "result": result.model_dump(mode="json")})
        self.busy = False


@router.websocket("/ws/voice")
async def voice_ws(ws: WebSocket) -> None:
    await ws.accept()
    session = VoiceSession(ws)
    try:
        await session.run()
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("voice websocket crashed")
    finally:
        await session.close()

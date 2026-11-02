"""Device probe: how fast are the speech and language engines on THIS machine? (about a minute per engine)

Run it first on a new device - a tablet, a laptop - before the full evaluation matrix, to see whether an engine is even
feasible and where its time goes:

    python -m backend.evalkit.bench --stt foundry:stt:whisper-base:cpu --llm foundry:llm:qwen2.5-0.5b:cpu
    python -m backend.evalkit.bench --stt foundry:stt:nemotron-speech-streaming-en-0.6b:cpu --live
    python -m backend.evalkit.bench --llm foundry:llm:qwen2.5-1.5b:cpu --llm foundry:llm:phi-3.5-mini:cpu --repeats 7 --json out.json

Speech: seconds of processing per second of audio (RTF; below 1 keeps up with the speaker) on one clip, repeated. With
``--live`` a streaming engine is also fed the clip in real time, like the microphone would: how long until the first words
appear, and how long the worker waits after the last word (the tail) - a batch engine's wait is its whole processing time.
Language: the extraction call the hybrid pipeline makes (a short statement, one or three fields) three ways - grammar
constrained, JSON-schema constrained and unconstrained - plus four controlled calls that split a call's cost into session
setup, one prompt token (the same one-token answer after a short and after a long prompt) and one generated token (a one-token
against a 64-token answer to the same prompt). Numbers are wall times of the real runtime; the model load is reported separately as the cold start.
"""
from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
import time
import wave
from dataclasses import asdict, dataclass, field
from pathlib import Path

from backend.config import get_settings
from backend.core.formpack import get_formpack
from backend.core.golden import golden_form
from backend.core.prompts import build_patch_prompt
from backend.engines.base import EngineError
from backend.engines.registry import get_registry
from backend.evalkit.hardware import get_hardware_info, process_rss_mb

log = logging.getLogger(__name__)

STATEMENT = "So I did a change-out on the can over at pole 123, the old unit was weeping badly. Unit 456 went in."
ONE_FIELD = ["condition_found"]
THREE_FIELDS = ["work_performed", "condition_found", "customer_notified"]
MIN_EXTRA_TOKENS = 8  # below this the decode-speed estimate is meaningless (the model stopped early)

# controlled calls that separate what a call costs: session setup, one prompt token, one generated token
PREFILL_SHORT, PREFILL_LONG = "prefill: short prompt, 1 token out", "prefill: long prompt, 1 token out"
DECODE_ONE, DECODE_MANY = "decode: 1 token out", "decode: 64 tokens out"
SPEED_SYSTEM = "You are a helpful assistant."
LONG_ANSWER = "Write a long paragraph about how electric utility crews restore power after a storm."
SPEED_CALLS = {  # label -> (user message, max tokens); the decode pair shares one prompt, so only generation differs
    PREFILL_SHORT: (STATEMENT, 1),
    PREFILL_LONG: (" ".join([STATEMENT] * 4), 1),
    DECODE_ONE: (LONG_ANSWER, 1),
    DECODE_MANY: (LONG_ANSWER, 64),
}


@dataclass
class Series:
    runs_ms: list[float] = field(default_factory=list)

    @property
    def p50(self) -> float:
        return statistics.median(self.runs_ms) if self.runs_ms else float("nan")

    @property
    def best(self) -> float:
        return min(self.runs_ms) if self.runs_ms else float("nan")

    @property
    def worst(self) -> float:
        return max(self.runs_ms) if self.runs_ms else float("nan")


@dataclass
class SttProbe:
    engine_id: str
    cold_start_ms: float = 0.0
    rss_mb: float = 0.0
    audio_ms: float = 0.0
    series: Series = field(default_factory=Series)
    transcript: str = ""
    error: str | None = None

    @property
    def rtf(self) -> float:
        return self.series.p50 / self.audio_ms if self.audio_ms else float("nan")


@dataclass
class LiveProbe:
    """A streaming engine fed the clip in real time: time to the first words, and the wait after the last word."""

    engine_id: str
    first_text_ms: Series = field(default_factory=Series)  # from the start of speech
    tail_ms: Series = field(default_factory=Series)  # from the end of speech to the final transcript
    transcript: str = ""
    note: str | None = None
    error: str | None = None


@dataclass
class LlmCall:
    label: str
    series: Series = field(default_factory=Series)
    prompt_tokens: int | None = None
    output_tokens: int | None = None
    error: str | None = None


@dataclass
class LlmProbe:
    engine_id: str
    cold_start_ms: float = 0.0
    rss_mb: float = 0.0
    calls: list[LlmCall] = field(default_factory=list)
    error: str | None = None

    def call(self, label: str) -> LlmCall | None:
        return next((c for c in self.calls if c.label == label), None)

    def _timed(self, label: str) -> LlmCall | None:
        c = self.call(label)
        return c if c is not None and c.series.runs_ms and c.error is None else None

    def prefill_ms_per_token(self) -> float | None:
        """What one more prompt token costs: the same one-token answer after a short and after a long prompt."""
        short, long_ = self._timed(PREFILL_SHORT), self._timed(PREFILL_LONG)
        if short is None or long_ is None:
            return None
        extra = (long_.prompt_tokens or 0) - (short.prompt_tokens or 0)
        return (long_.series.p50 - short.series.p50) / extra if extra > 0 else None

    def decode_ms_per_token(self) -> float | None:
        """Steady generation speed: a one-token answer against a long one to the same prompt (a prompt that differs
        slightly is priced at the measured prefill speed and removed)."""
        one, many = self._timed(DECODE_ONE), self._timed(DECODE_MANY)
        if one is None or many is None:
            return None
        extra_out = (many.output_tokens or 0) - (one.output_tokens or 0)
        if extra_out < MIN_EXTRA_TOKENS:
            return None  # the model stopped early: nothing to measure
        prefill = (self.prefill_ms_per_token() or 0.0) * ((many.prompt_tokens or 0) - (one.prompt_tokens or 0))
        return (many.series.p50 - one.series.p50 - prefill) / extra_out

    @property
    def fixed_cost_ms(self) -> float | None:
        """What a call costs however short the prompt: session setup (the short one-token call minus its prefill)."""
        short, per_token = self._timed(PREFILL_SHORT), self.prefill_ms_per_token()
        if short is None or per_token is None:
            return None
        return max(0.0, short.series.p50 - per_token * (short.prompt_tokens or 0))


def _default_clip() -> Path | None:
    p = get_settings().datasets_dir / "demo-script" / "audio" / "demo-01.wav"
    return p if p.exists() else None


def probe_stt(engine_id: str, clip: Path, repeats: int) -> SttProbe:
    out = SttProbe(engine_id)
    reg = get_registry()
    try:
        engine = reg.get_stt(engine_id)
        rss0 = process_rss_mb()
        out.cold_start_ms = engine.ensure_ready()
        out.rss_mb = max(0.0, process_rss_mb() - rss0)
        first = engine.transcribe_file(clip)  # the first call after a load is slower: keep it out of the series
        out.audio_ms = first.audio_ms
        for _ in range(repeats):
            res = engine.transcribe_file(clip)
            out.series.runs_ms.append(res.stt_ms)
            out.transcript = res.text
    except (EngineError, KeyError, RuntimeError) as exc:
        out.error = f"{type(exc).__name__}: {exc}"
    return out


LIVE_CHUNK_S = 0.1  # the microphone path pushes about this much audio at a time


def probe_live(engine_id: str, clip: Path, repeats: int) -> LiveProbe:
    out = LiveProbe(engine_id)
    reg = get_registry()
    try:
        engine = reg.get_stt(engine_id)
        if not engine.info().supports_streaming:
            out.note = "batch engine: the worker waits for the whole processing time above"
            return out
        engine.ensure_ready()
        with wave.open(str(clip), "rb") as w:
            rate, pcm = w.getframerate(), w.readframes(w.getnframes())
        step = int(rate * LIVE_CHUNK_S) * 2
        for rep in range(repeats + 1):  # the first pass warms the session: keep it out of the series
            stream = engine.open_stream(rate)
            first_ms: float | None = None
            t0 = time.perf_counter()
            try:
                for i in range(0, len(pcm), step):
                    stream.push(pcm[i:i + step])
                    time.sleep(max(0.0, t0 + min(i + step, len(pcm)) / 2 / rate - time.perf_counter()))
                    if first_ms is None and any(ev.text.strip() for ev in stream.drain()):
                        first_ms = (time.perf_counter() - t0) * 1000.0
                t_end = time.perf_counter()
                res = stream.finish()
                tail_ms = (time.perf_counter() - t_end) * 1000.0
            finally:
                stream.close()
            if rep:
                out.tail_ms.runs_ms.append(tail_ms)
                if first_ms is not None:
                    out.first_text_ms.runs_ms.append(first_ms)
                out.transcript = res.text
    except (EngineError, KeyError, RuntimeError) as exc:
        out.error = f"{type(exc).__name__}: {exc}"
    return out


def _llm_prompts() -> dict[str, tuple[str, str, dict | None, int]]:
    pack = get_formpack(golden_form())
    out: dict[str, tuple[str, str, dict | None, int]] = {}
    for name, keys in (("1 field", ONE_FIELD), ("3 fields", THREE_FIELDS)):
        system, user = build_patch_prompt(STATEMENT, pack, keys, {})
        max_tokens = min(220, 14 * len(keys) + 12)
        out[f"{name}, grammar"] = (system, user, {"type": "lark_grammar", "lark_grammar": pack.lark_grammar(keys)}, max_tokens)
        out[f"{name}, json schema"] = (system, user, {"type": "json_schema", "json_schema": pack.json_schema(keys)}, max_tokens)
        out[f"{name}, unconstrained"] = (system, user, None, max_tokens)
    for label, (user, max_tokens) in SPEED_CALLS.items():
        out[label] = (SPEED_SYSTEM, user, None, max_tokens)
    return out


def probe_llm(engine_id: str, repeats: int) -> LlmProbe:
    out = LlmProbe(engine_id)
    reg = get_registry()
    try:
        engine = reg.get_llm(engine_id)
        rss0 = process_rss_mb()
        out.cold_start_ms = engine.ensure_ready()
        out.rss_mb = max(0.0, process_rss_mb() - rss0)
    except (EngineError, KeyError, RuntimeError) as exc:
        out.error = f"{type(exc).__name__}: {exc}"
        return out
    for label, (system, user, fmt, max_tokens) in _llm_prompts().items():
        call = LlmCall(label)
        try:
            engine.complete(system, user, response_format=fmt, max_tokens=max_tokens, temperature=0.0)  # warm-up
            for _ in range(repeats):
                t0 = time.perf_counter()
                res = engine.complete(system, user, response_format=fmt, max_tokens=max_tokens, temperature=0.0)
                call.series.runs_ms.append(res.total_ms or (time.perf_counter() - t0) * 1000.0)
                call.prompt_tokens, call.output_tokens = res.prompt_tokens, res.output_tokens
        except Exception as exc:  # a runtime may reject one constraint type; keep probing the others
            call.error = f"{type(exc).__name__}: {exc}"
        out.calls.append(call)
    return out


def _f(v: float | None, digits: int = 0) -> str:
    return "-" if v is None or v != v else f"{v:.{digits}f}"


def render(stt: list[SttProbe], llm: list[LlmProbe], profile: str, live: list[LiveProbe] | None = None) -> str:
    hw = get_hardware_info()
    lines = [f"# Device probe - profile `{profile}`", "",
             f"- {hw.cpu_name} ({hw.physical_cores}C/{hw.logical_cores}T), {hw.ram_gb} GB RAM, {hw.os}"]
    lines += [f"- _{n}_" for n in hw.notes]
    if stt:
        lines += ["", "## Speech-to-text", "",
                  "| Engine | Cold start ms | Resident MB | Audio s | p50 ms | best ms | worst ms | RTF (p50) |",
                  "|---|---|---|---|---|---|---|---|"]
        for s in stt:
            if s.error:
                lines.append(f"| `{s.engine_id}` | {s.error} | | | | | | |")
                continue
            lines.append(f"| `{s.engine_id}` | {_f(s.cold_start_ms)} | {_f(s.rss_mb)} | {_f(s.audio_ms / 1000, 1)} | "
                         f"{_f(s.series.p50)} | {_f(s.series.best)} | {_f(s.series.worst)} | {_f(s.rtf, 2)} |")
        lines += ["", "_RTF below 1.0 keeps up with the speaker; the last transcript of each engine:_", ""]
        lines += [f"- `{s.engine_id}`: {s.transcript!r}" for s in stt if not s.error]
    if live:
        lines += ["", "## Live (the clip streamed in real time)", "",
                  "| Engine | First words after ms | Wait after the last word, p50 ms | best ms | worst ms |",
                  "|---|---|---|---|---|"]
        for p in live:
            if p.error:
                lines.append(f"| `{p.engine_id}` | {p.error} | | | |")
            elif p.note:
                lines.append(f"| `{p.engine_id}` | {p.note} | | | |")
            else:
                lines.append(f"| `{p.engine_id}` | {_f(p.first_text_ms.p50)} | {_f(p.tail_ms.p50)} | "
                             f"{_f(p.tail_ms.best)} | {_f(p.tail_ms.worst)} |")
        lines += ["", "_The wait after the last word is what the worker feels: a batch engine only starts when the "
                      "recording stops, so its wait is the whole p50 above._"]
    for p in llm:
        lines += ["", f"## Language model `{p.engine_id}`", ""]
        if p.error:
            lines.append(p.error)
            continue
        lines.append(f"Cold start {_f(p.cold_start_ms)} ms, about {_f(p.rss_mb)} MB resident.")
        fixed, prefill, per_tok = p.fixed_cost_ms, p.prefill_ms_per_token(), p.decode_ms_per_token()
        lines.append(f"Fixed cost per call (session setup): {_f(fixed)} ms; prompt: {_f(prefill, 1)} ms per token; "
                     f"generation: {_f(per_tok, 1)} ms per token{'' if not per_tok else f' ({1000 / per_tok:.0f} tokens/s)'}.")
        lines += ["", "| Call | p50 ms | best ms | worst ms | Tokens in/out |", "|---|---|---|---|---|"]
        for c in p.calls:
            if c.error:
                lines.append(f"| {c.label} | {c.error} | | | |")
            else:
                lines.append(f"| {c.label} | {_f(c.series.p50)} | {_f(c.series.best)} | {_f(c.series.worst)} | "
                             f"{c.prompt_tokens}/{c.output_tokens} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.WARNING)
    ap = argparse.ArgumentParser(prog="backend.evalkit.bench", description=__doc__.split("\n\n")[0])
    ap.add_argument("--stt", action="append", default=[], help="speech engine id; repeatable")
    ap.add_argument("--llm", action="append", default=[], help="language model engine id; repeatable")
    ap.add_argument("--clip", type=Path, help="WAV to transcribe (default: the demo-script headline clip)")
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--live", action="store_true",
                    help="also stream the clip to each --stt engine in real time (streaming engines only)")
    ap.add_argument("--json", type=Path, dest="json_out", help="also write the raw numbers here")
    a = ap.parse_args(argv)
    if not (a.stt or a.llm):
        sys.exit("give at least one --stt or --llm engine id (see: python -m backend.evalkit.cli engines)")
    clip = a.clip or _default_clip()
    if a.stt and clip is None:
        sys.exit("no clip: build the demo dataset (python -m backend.synth.demo_script) or pass --clip")
    stt = [probe_stt(e, clip, a.repeats) for e in a.stt]  # type: ignore[arg-type]
    live = [probe_live(e, clip, a.repeats) for e in a.stt] if a.live else []  # type: ignore[arg-type]
    llm = [probe_llm(e, a.repeats) for e in a.llm]
    profile = get_settings().device_profile
    print(render(stt, llm, profile, live))
    if a.json_out:
        a.json_out.write_text(json.dumps({"profile": profile, "hardware": get_hardware_info().model_dump(),
                                          "stt": [asdict(s) for s in stt], "live": [asdict(p) for p in live],
                                          "llm": [asdict(p) for p in llm]}, indent=1, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()

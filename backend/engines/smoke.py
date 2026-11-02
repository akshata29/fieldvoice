"""Live smoke test of the Foundry engines (downloads models into data/models on first run).

Usage (repo root):  .venv\\Scripts\\python.exe -m backend.engines.smoke [--stt whisper-base] [--llm qwen2.5-0.5b]
Not a unit test: it needs the network once to download, then runs fully offline.
"""
from __future__ import annotations

import argparse
import logging
import time
import wave
from pathlib import Path

from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.engines.registry import get_registry
from backend.tests.core.fixtures import transformer_form, world_assets

CANON = "I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456."


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    ap = argparse.ArgumentParser()
    ap.add_argument("--stt", default="whisper-base")
    ap.add_argument("--llm", default="qwen2.5-0.5b")
    ap.add_argument("--wav", default=None, help="optional 16 kHz mono wav to transcribe")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    reg = get_registry()
    if args.list:
        for i in reg.stt_infos() + reg.llm_infos():
            print(f"{i.availability.value:15} {i.id:60} {i.size_mb or ''}")
        return

    def prog(f: float, msg: str) -> None:
        print(f"  [{f * 100:5.1f}%] {msg}", flush=True)

    llm_id = f"foundry:llm:{args.llm}:cpu"
    stt_id = f"foundry:stt:{args.stt}:cpu"
    print("preparing", llm_id)
    print("  load_ms", round(reg.prepare(llm_id, prog), 1))
    llm = reg.get_llm(llm_id)
    inp = PipelineInput(transcript=CANON, form=transformer_form(), assets=world_assets())
    for strat in ("hybrid", "hybrid_always", "enum_grammar", "schema_constrained", "free_json"):
        res = ExtractionPipeline().run(inp, strat, llm)
        stages = ", ".join(f"{t.stage}={t.ms:.0f}ms" for t in res.timings)
        vals = {k: v.value for k, v in res.fields.items() if v.value is not None and k != "notes"}
        print(f"{strat:20} total={res.total_ms:7.0f}ms tokens(in/out)={res.llm_prompt_tokens}/{res.llm_output_tokens} "
              f"[{stages}] err={res.error}\n    {vals}")

    if args.wav:
        print("preparing", stt_id)
        print("  load_ms", round(reg.prepare(stt_id, prog), 1))
        stt = reg.get_stt(stt_id)
        t0 = time.perf_counter()
        out = stt.transcribe_file(Path(args.wav))
        print(f"ASR {out.stt_ms:.0f}ms audio={out.audio_ms:.0f}ms :: {out.text}")


if __name__ == "__main__":
    main()

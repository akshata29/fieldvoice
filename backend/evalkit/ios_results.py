"""Summarize results written by the iOS benchmark harness (ios-spike/) with the same metrics as the Windows runs.

    python -m backend.evalkit.ios_results results-llm-....json [--dataset synth-v1] [--max-p95-ms 5000]

LLM files: latency/tokens/footprint per strategy plus the valid-JSON rate. Speech files: RTF, first-partial latency and
(with ``--dataset``) normalized WER and identifier match computed by ``backend.evalkit.metrics`` - i.e. exactly the
code that scores the Windows engines, so the numbers are comparable.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from backend.core.prompts import parse_json_object
from backend.evalkit.dataset import DEFAULT_DATASET, load_dataset
from backend.evalkit.metrics import id_exact_match, percentiles, wer, wer_normalized

SCHEMA = "fieldvoice.ios-bench.v1"


def _fmt(v: float | None, digits: int = 0) -> str:
    return "-" if v is None else f"{v:.{digits}f}"


def _header(res: dict) -> list[str]:
    d, r, fp = res["device"], res["runner"], res["footprint_mb"]
    lines = [
        f"### {r['kind'].upper()} - `{r['id']}`",
        "",
        f"* Device: `{d['machine']}`, {d['system']}, {d['physical_memory_mb'] / 1024:.1f} GB RAM, "
        f"{d['processor_count']} cores, build **{d['build']}**, low-power mode {'ON' if d['low_power_mode'] else 'off'}, "
        f"thermal at start `{d['thermal_state_start']}`",
        f"* Runner: {r.get('detail', '')}",
        f"* Load/prepare: {_fmt(res.get('load_ms'))} ms; footprint {_fmt(fp['before_load'])} -> {_fmt(fp['after_load'])} MB "
        f"(peak {_fmt(fp['peak'])} MB)",
    ]
    if d["build"] != "release":
        lines.append("* **WARNING: debug build - timings are not meaningful.**")
    hot = sorted({r_["thermal_state"] for r_ in res["runs"] if r_["thermal_state"] not in ("nominal",)})
    if hot:
        lines.append(f"* Thermal states seen during the run: {', '.join(hot)} (results may be throttled)")
    lines += [f"* Note: {n}" for n in res.get("notes", [])]
    return lines + [""]


def summarize_llm(res: dict, max_p95_ms: float) -> str:
    by_strategy: dict[str, list[dict]] = defaultdict(list)
    for run in res["runs"]:
        by_strategy[run.get("strategy") or "?"].append(run)
    rows = ["| strategy | runs | errors | valid JSON | TTFT p50 | total p50 | total p95 | tok/s p50 | prompt tok | out tok | gate |",
            "|---|---|---|---|---|---|---|---|---|---|---|"]
    for strategy, runs in sorted(by_strategy.items()):
        ok = [r for r in runs if not r.get("error")]
        valid = sum(1 for r in ok if parse_json_object(r.get("output") or "") is not None)
        total = percentiles([r["total_ms"] for r in ok if r.get("total_ms") is not None])
        ttft = percentiles([r["ttft_ms"] for r in ok if r.get("ttft_ms") is not None])
        tps = percentiles([r["tokens_per_s"] for r in ok if r.get("tokens_per_s") is not None])
        ptok = [r["prompt_tokens"] for r in ok if r.get("prompt_tokens") is not None]
        otok = [r["output_tokens"] for r in ok if r.get("output_tokens") is not None]
        gate = "-" if total.p95 is None else ("PASS" if total.p95 <= max_p95_ms else f"FAIL (> {max_p95_ms:.0f} ms)")
        rows.append(
            f"| {strategy} | {len(runs)} | {len(runs) - len(ok)} | {valid}/{len(ok)} | {_fmt(ttft.p50)} | {_fmt(total.p50)} | "
            f"{_fmt(total.p95)} | {_fmt(tps.p50, 1)} | {_fmt(sum(ptok) / len(ptok) if ptok else None)} | "
            f"{_fmt(sum(otok) / len(otok) if otok else None)} | {gate} |")
    return "\n".join(_header(res) + rows) + "\n"


def summarize_stt(res: dict, dataset_id: str | None) -> str:
    ok = [r for r in res["runs"] if not r.get("error")]
    stt = percentiles([r["stt_ms"] for r in ok if r.get("stt_ms") is not None])
    first = percentiles([r["first_partial_ms"] for r in ok if r.get("first_partial_ms") is not None])
    audio = sum(r["audio_ms"] for r in ok if r.get("audio_ms"))
    rtf = sum(r["stt_ms"] for r in ok if r.get("stt_ms") is not None) / audio if audio else None
    lines = _header(res) + [
        f"* Cases: {len(res['runs'])} ({len(res['runs']) - len(ok)} errors); RTF {_fmt(rtf, 2)}; "
        f"latency p50/p95 {_fmt(stt.p50)}/{_fmt(stt.p95)} ms; first partial p50 {_fmt(first.p50)} ms"]
    if dataset_id:
        ds = load_dataset(dataset_id)
        refs = {c.id: c for c in ds.cases}
        raw, norm, ids = [], [], []
        for r in ok:
            case = refs.get(r["case_id"])
            if case is None:
                continue
            hyp = r.get("transcript") or ""
            raw.append(wer(case.spoken_text, hyp))
            norm.append(wer_normalized(case.spoken_text, hyp))
            m = id_exact_match(case.spoken_text, hyp)
            if m is not None:
                ids.append(m)
        if norm:
            lines.append(f"* Scored vs `{dataset_id}` ({len(norm)} cases): WER {sum(raw) / len(raw):.3f}, "
                         f"normalized WER {sum(norm) / len(norm):.3f}, identifier match "
                         f"{(sum(ids) / len(ids)) if ids else float('nan'):.3f}")
        else:
            lines.append(f"* No case ids matched dataset `{dataset_id}`; WER not computed.")
    return "\n".join(lines) + "\n"


def summarize(res: dict, dataset_id: str | None = None, max_p95_ms: float = 5000.0) -> str:
    if res.get("schema") != SCHEMA:
        raise ValueError(f"unsupported results schema {res.get('schema')!r} (expected {SCHEMA})")
    kind = res["runner"]["kind"]
    if kind == "llm":
        return summarize_llm(res, max_p95_ms)
    if kind == "stt":
        return summarize_stt(res, dataset_id)
    raise ValueError(f"unknown runner kind {kind!r}")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="backend.evalkit.ios_results")
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--dataset", default=None, help=f"score speech transcripts against this dataset (e.g. {DEFAULT_DATASET})")
    ap.add_argument("--max-p95-ms", type=float, default=5000.0)
    args = ap.parse_args(argv)
    for f in args.files:
        print(summarize(json.loads(f.read_text(encoding="utf-8")), args.dataset, args.max_p95_ms))


if __name__ == "__main__":
    main()

"""Evaluation CLI.

Examples (repo root, Windows):
  .venv\\Scripts\\python.exe -m backend.evalkit.cli engines
  .venv\\Scripts\\python.exe -m backend.evalkit.cli datasets
  .venv\\Scripts\\python.exe -m backend.evalkit.cli run --dataset synth-v1 --llm foundry:llm:qwen2.5-0.5b:cpu \\
      --strategy free_json --strategy hybrid --limit 60
  .venv\\Scripts\\python.exe -m backend.evalkit.cli run --dataset synth-v1 --stt foundry:stt:whisper-base:cpu \\
      --llm rules:llm:none --strategy rules_only
  .venv\\Scripts\\python.exe -m backend.evalkit.cli report <run_id>
  .venv\\Scripts\\python.exe -m backend.evalkit.cli rescore <run_id>   (after changing the rules: no audio re-run)
"""
from __future__ import annotations

import argparse
import itertools
import logging
import sys

from backend.core.strategies import STRATEGIES, get_strategy
from backend.engines.registry import get_registry
from backend.evalkit.dataset import DEFAULT_DATASET, list_datasets
from backend.evalkit.report import decide, markdown_report
from backend.evalkit.runner import EvalRunner
from backend.evalkit.store import RunStore
from backend.schemas.engines import NO_LLM_ID, ORACLE_STT_ID
from backend.schemas.eval import DecisionGates, RunConfig, RunRequest


def build_configs(stts: list[str], llms: list[str], strategies: list[str]) -> list[RunConfig]:
    configs: list[RunConfig] = []
    for stt, strat in itertools.product(stts, strategies):
        if not get_strategy(strat).uses_llm:
            configs.append(RunConfig(stt_engine_id=stt, llm_engine_id=NO_LLM_ID, strategy_id=strat))
            continue
        for llm in llms:
            if llm != NO_LLM_ID:
                configs.append(RunConfig(stt_engine_id=stt, llm_engine_id=llm, strategy_id=strat))
    return configs


def cmd_engines(_: argparse.Namespace) -> None:
    reg = get_registry()
    for info in reg.stt_infos() + reg.llm_infos():
        size = f"{info.size_mb:.0f} MB" if info.size_mb else ""
        print(f"{info.kind.value:4} {info.availability.value:15} {info.id:62} {size:>9}  {info.availability_reason or ''}")
    print("\nstrategies:", ", ".join(s.id for s in STRATEGIES))


def cmd_datasets(_: argparse.Namespace) -> None:
    for d in list_datasets():
        print(f"{d.id:20} cases={d.n_cases:4} audio={d.n_with_audio:4} forms={len(d.form_ids)} splits={d.splits}")


def cmd_run(a: argparse.Namespace) -> None:
    stts = a.stt or [ORACLE_STT_ID]
    llms = a.llm or [NO_LLM_ID]
    strategies = a.strategy or ["rules_only"]
    configs = build_configs(stts, llms, strategies)
    if not configs:
        sys.exit("no configurations: strategies that use an LLM need --llm")
    req = RunRequest(dataset_id=a.dataset, configs=configs, limit=a.limit, splits=a.split or None, tags=a.tag or None,
                     repeats=a.repeats, warmup=a.warmup, label=a.label)
    store = RunStore()
    runner = EvalRunner(store=store)

    def prog(frac: float, msg: str) -> None:
        print(f"[{frac * 100:5.1f}%] {msg}", flush=True)

    summary = runner.run(req, progress=prog)
    report = decide(summary, DecisionGates(max_p95_ms=a.max_p95_ms))
    md = markdown_report(summary, report)
    (store.root / summary.run_id / "report.md").write_text(md, encoding="utf-8")
    print("\n" + md)
    print(f"run id: {summary.run_id}  ({store.root / summary.run_id})")


def cmd_rescore(a: argparse.Namespace) -> None:
    store = RunStore()
    runner = EvalRunner(store=store)

    def prog(frac: float, msg: str) -> None:
        print(f"[{frac * 100:5.1f}%] {msg}", flush=True)

    try:
        summary = runner.rescore(a.run_id, label=a.label, progress=prog)
    except (FileNotFoundError, ValueError) as exc:
        sys.exit(f"cannot rescore {a.run_id}: {exc}")
    report = decide(summary, DecisionGates(max_p95_ms=a.max_p95_ms))
    md = markdown_report(summary, report)
    (store.root / summary.run_id / "report.md").write_text(md, encoding="utf-8")
    print("\n" + md)
    print(f"run id: {summary.run_id}  ({store.root / summary.run_id})  rescored from {a.run_id}")


def cmd_report(a: argparse.Namespace) -> None:
    store = RunStore()
    summary = store.load_summary(a.run_id)
    report = decide(summary, DecisionGates(max_p95_ms=a.max_p95_ms, min_id_field_accuracy=a.min_id_accuracy,
                                           max_silent_wrong=a.max_silent_wrong))
    print(markdown_report(summary, report))


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.WARNING)
    ap = argparse.ArgumentParser(prog="backend.evalkit.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("engines").set_defaults(fn=cmd_engines)
    sub.add_parser("datasets").set_defaults(fn=cmd_datasets)
    r = sub.add_parser("run")
    r.add_argument("--dataset", default=DEFAULT_DATASET)
    r.add_argument("--stt", action="append", help="STT engine id (default oracle transcript); repeatable")
    r.add_argument("--llm", action="append", help="LLM engine id; repeatable")
    r.add_argument("--strategy", action="append", help="strategy id; repeatable")
    r.add_argument("--limit", type=int)
    r.add_argument("--split", action="append")
    r.add_argument("--tag", action="append")
    r.add_argument("--repeats", type=int, default=1)
    r.add_argument("--warmup", type=int, default=1)
    r.add_argument("--label")
    r.add_argument("--max-p95-ms", type=float, default=5000.0)
    r.set_defaults(fn=cmd_run)
    rs = sub.add_parser("rescore", help="re-run extraction + scoring on a past run's stored transcripts (no audio)")
    rs.add_argument("run_id")
    rs.add_argument("--label")
    rs.add_argument("--max-p95-ms", type=float, default=5000.0)
    rs.set_defaults(fn=cmd_rescore)
    rep = sub.add_parser("report")
    rep.add_argument("run_id")
    rep.add_argument("--max-p95-ms", type=float, default=5000.0)
    rep.add_argument("--min-id-accuracy", type=float, default=0.95)
    rep.add_argument("--max-silent-wrong", type=float, default=0.02)
    rep.set_defaults(fn=cmd_report)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()

"""Run persistence: ``data/runs/<run_id>/{summary.json, cases.jsonl}``."""
from __future__ import annotations

import json
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from backend.config import get_settings
from backend.schemas.eval import CaseResult, RunSummary


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class RunStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or get_settings().runs_dir
        self._lock = threading.Lock()

    def new_run_id(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]

    def _dir(self, run_id: str) -> Path:
        return self.root / run_id

    def save_summary(self, summary: RunSummary) -> None:
        d = self._dir(summary.run_id)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "summary.json.tmp"
        with self._lock:
            tmp.write_text(summary.model_dump_json(indent=1), encoding="utf-8")
            tmp.replace(d / "summary.json")

    def load_summary(self, run_id: str) -> RunSummary:
        p = self._dir(run_id) / "summary.json"
        if not p.exists():
            raise FileNotFoundError(run_id)
        return RunSummary.model_validate_json(p.read_text(encoding="utf-8"))

    def list_summaries(self) -> list[RunSummary]:
        out: list[RunSummary] = []
        if not self.root.exists():
            return out
        for d in sorted(self.root.iterdir(), reverse=True):
            p = d / "summary.json"
            if p.exists():
                try:
                    out.append(RunSummary.model_validate_json(p.read_text(encoding="utf-8")))
                except Exception:
                    continue
        return out

    def append_cases(self, run_id: str, results: list[CaseResult]) -> None:
        d = self._dir(run_id)
        d.mkdir(parents=True, exist_ok=True)
        with self._lock, (d / "cases.jsonl").open("a", encoding="utf-8") as f:
            for r in results:
                f.write(r.model_dump_json() + "\n")

    def load_cases(self, run_id: str, config_key: str | None = None, only_failures: bool = False, offset: int = 0,
                   limit: int = 200) -> list[CaseResult]:
        p = self._dir(run_id) / "cases.jsonl"
        out: list[CaseResult] = []
        if not p.exists():
            return out
        skipped = 0
        for line in p.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = CaseResult.model_validate(json.loads(line))
            if config_key and r.config_key != config_key:
                continue
            if only_failures and r.ok and all(r.field_correct.values()):
                continue
            if skipped < offset:
                skipped += 1
                continue
            out.append(r)
            if len(out) >= limit:
                break
        return out

    def delete(self, run_id: str) -> None:
        shutil.rmtree(self._dir(run_id), ignore_errors=True)

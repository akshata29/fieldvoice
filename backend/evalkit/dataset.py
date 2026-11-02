"""Dataset access: list datasets, load world + cases from ``data/datasets/<id>/``."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from backend.config import get_settings
from backend.schemas.eval import EvalCase, EvalDatasetInfo
from backend.schemas.reference import Asset
from backend.schemas.workorders import DemoWorld

log = logging.getLogger(__name__)
DEFAULT_DATASET = "synth-v1"
DEMO_DATASET = "demo-script"  # hand-written lines for the demo technician's three jobs (backend/synth/demo_script.py)


@dataclass
class Dataset:
    info: EvalDatasetInfo
    world: DemoWorld
    cases: list[EvalCase]
    root: Path

    def form(self, form_id: str):
        for f in self.world.forms:
            if f.id == form_id:
                return f
        raise KeyError(f"form {form_id!r} not in dataset {self.info.id}")

    def assets_for(self, case: EvalCase) -> list[Asset]:
        wanted = {a.upper() for a in case.job_asset_ids}
        return [a for a in self.world.assets if a.id.upper() in wanted]

    def audio_path(self, case: EvalCase) -> Path | None:
        if not case.audio_path:
            return None
        p = self.root / case.audio_path
        return p if p.exists() else None


def dataset_dir(dataset_id: str) -> Path:
    return get_settings().datasets_dir / dataset_id


def list_datasets() -> list[EvalDatasetInfo]:
    out: list[EvalDatasetInfo] = []
    root = get_settings().datasets_dir
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        mf = d / "manifest.json"
        if d.is_dir() and mf.exists():
            try:
                out.append(EvalDatasetInfo.model_validate_json(mf.read_text(encoding="utf-8")))
            except Exception as exc:
                log.warning("bad dataset manifest %s: %s", mf, exc)
    return out


_cache: dict[str, tuple[float, Dataset]] = {}


def load_dataset(dataset_id: str) -> Dataset:
    root = dataset_dir(dataset_id)
    mf = root / "manifest.json"
    if not mf.exists():
        raise FileNotFoundError(f"dataset {dataset_id!r} not found at {root}")
    mtime = mf.stat().st_mtime
    hit = _cache.get(dataset_id)
    if hit is not None and hit[0] == mtime:
        return hit[1]
    info = EvalDatasetInfo.model_validate_json(mf.read_text(encoding="utf-8"))
    world = DemoWorld.model_validate_json((root / "world.json").read_text(encoding="utf-8"))
    cases = [EvalCase.model_validate(json.loads(line))
             for line in (root / "cases.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    ds = Dataset(info=info, world=world, cases=cases, root=root)
    if len(_cache) >= 4:
        _cache.pop(next(iter(_cache)))
    _cache[dataset_id] = (mtime, ds)
    return ds


def sample_datasets() -> list[Dataset]:
    """The datasets the UI can play samples from: the scripted demo lines first, then the generated set."""
    out: list[Dataset] = []
    for name in (DEMO_DATASET, DEFAULT_DATASET):
        try:
            out.append(load_dataset(name))
        except FileNotFoundError:
            continue
    return out


def find_sample(sample_id: str) -> tuple[Dataset, EvalCase] | None:
    for ds in sample_datasets():
        for c in ds.cases:
            if c.id == sample_id:
                return ds, c
    return None

"""Resolve the form, closed world and (optionally) a dataset sample for an extraction request."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from fastapi import HTTPException

from backend.evalkit.dataset import DEFAULT_DATASET, Dataset, find_sample, load_dataset, sample_datasets
from backend.schemas.eval import EvalCase
from backend.schemas.extraction import Scalar
from backend.schemas.forms import FormSchema
from backend.schemas.reference import Asset

log = logging.getLogger(__name__)


@dataclass
class ExtractionContext:
    form: FormSchema
    assets: list[Asset]
    prefill: dict[str, Scalar] = field(default_factory=dict)
    work_order_id: str | None = None
    sample: EvalCase | None = None
    dataset: Dataset | None = None


def _bundle():
    try:
        from backend.demo import bundle as demo_bundle

        return demo_bundle
    except Exception as exc:  # systems package not available
        log.debug("demo bundle unavailable: %s", exc)
        return None


def load_sample(sample_id: str) -> tuple[Dataset, EvalCase]:
    found = find_sample(sample_id)
    if found is not None:
        return found
    if not sample_datasets():
        raise HTTPException(404, detail=f"dataset {DEFAULT_DATASET!r} not generated yet (Results > Datasets)")
    raise HTTPException(404, detail=f"sample {sample_id!r} not found")


def resolve_context(work_order_id: str | None = None, form_id: str | None = None,
                    sample_id: str | None = None) -> ExtractionContext:
    sample: EvalCase | None = None
    ds: Dataset | None = None
    if sample_id:
        ds, sample = load_sample(sample_id)

    if work_order_id:
        mod = _bundle()
        b = mod.get_bundle() if mod else None
        if b is None:
            raise HTTPException(409, detail={"code": "no_bundle", "message": "No bundle downloaded yet (Morning)."})
        wo = next((w for w in b.work_orders if w.id == work_order_id), None)
        if wo is None:
            raise HTTPException(404, detail=f"work order {work_order_id!r} not in the local bundle")
        form = next((f for f in b.forms if f.id == wo.form_id and f.version == wo.form_version), None) \
            or next((f for f in b.forms if f.id == wo.form_id), None)
        if form is None:
            raise HTTPException(404, detail=f"form {wo.form_id!r} not in the local bundle")
        assets = list(mod.job_assets(work_order_id))
        if sample is not None and ds is not None:
            # canned utterances refer to the sample's own assets: add them so the demo resolves cleanly
            known = {(a.kind, a.id) for a in assets}
            assets += [a for a in ds.assets_for(sample) if (a.kind, a.id) not in known]
        return ExtractionContext(form=form, assets=assets, prefill=dict(wo.prefill), work_order_id=work_order_id,
                                 sample=sample, dataset=ds)

    if sample is not None and ds is not None:
        return ExtractionContext(form=ds.form(sample.form_id), assets=ds.assets_for(sample), sample=sample, dataset=ds)

    if form_id:
        mod = _bundle()
        b = mod.get_bundle() if mod else None
        if b is not None:
            form = next((f for f in b.forms if f.id == form_id), None)
            if form is not None:
                return ExtractionContext(form=form, assets=list(b.assets))
        try:
            ds = load_dataset(DEFAULT_DATASET)
            return ExtractionContext(form=ds.form(form_id), assets=list(ds.world.assets), dataset=ds)
        except (FileNotFoundError, KeyError):
            pass
        raise HTTPException(404, detail=f"form {form_id!r} not found")
    raise HTTPException(422, detail="provide work_order_id, form_id or sample_id")

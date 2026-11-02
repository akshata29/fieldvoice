"""Lab: run the same utterance through several engine/strategy combinations and compare."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from backend.api.context import resolve_context
from backend.api.jobs import JobContext, job_manager
from backend.api.voice_service import run_extraction, transcribe_wav
from backend.evalkit.metrics import score_case
from backend.schemas.api import LabCompareItem, LabCompareRequest, LabCompareResult
from backend.schemas.engines import ORACLE_STT_ID, JobStatus
from backend.schemas.eval import EvalCase

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/lab", tags=["lab"])


@router.post("/compare", response_model=JobStatus, status_code=202)
def compare(req: LabCompareRequest) -> JobStatus:
    if not req.combos:
        raise HTTPException(422, detail="no combinations selected")
    if not (req.sample_id or req.transcript):
        raise HTTPException(422, detail="provide sample_id or transcript")

    def work(ctx: JobContext) -> LabCompareResult:
        c = resolve_context(req.work_order_id, req.form_id, req.sample_id)
        expected = dict(c.sample.expected) if c.sample else None
        if expected is not None:
            for key, value in c.prefill.items():  # dispatch filled these: what is on the form is right unless speech differs
                if expected.get(key) is None:
                    expected[key] = value
        out = LabCompareResult(expected=expected, items=[])
        total = len(req.combos)
        for i, combo in enumerate(req.combos):
            ctx.report(i / total, f"{combo.key}")
            item = LabCompareItem(config=combo)
            try:
                stt = None
                if c.sample is not None:
                    audio = c.dataset.audio_path(c.sample) if c.dataset else None
                    if combo.stt_engine_id != ORACLE_STT_ID and audio is not None:
                        stt = transcribe_wav(combo.stt_engine_id, audio)
                        transcript = stt.text
                    else:
                        transcript = c.sample.written_text
                else:
                    transcript = req.transcript or ""
                item.extraction = run_extraction(c, transcript, combo.strategy_id, combo.llm_engine_id,
                                                 combo.stt_engine_id if stt else None, stt)
                if expected is not None and item.extraction is not None:
                    pseudo = EvalCase(id="lab", form_id=c.form.id, spoken_text="", written_text="", expected=expected)
                    item.field_correct = score_case(pseudo, c.form, item.extraction).field_correct
            except HTTPException as exc:
                item.error = exc.detail["message"] if isinstance(exc.detail, dict) else str(exc.detail)
            except Exception as exc:
                log.exception("lab combo failed")
                item.error = f"{type(exc).__name__}: {exc}"
            out.items.append(item)
            ctx.set_result(out)
        ctx.report(1.0, "done")
        return out

    return job_manager.submit("lab_compare", work)

"""Evaluation: datasets, runs, decision reports, exports."""
from __future__ import annotations

import csv
import io
import logging

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response

from backend.api.jobs import JobBusy, JobCancelled, JobContext, job_manager
from backend.evalkit.dataset import list_datasets, load_dataset
from backend.evalkit.report import decide, markdown_report
from backend.evalkit.runner import EvalRunner
from backend.evalkit.store import RunStore
from backend.schemas.api import DatasetGenerateRequest
from backend.schemas.engines import JobStatus
from backend.schemas.eval import (
    CaseResult,
    DecisionGates,
    DecisionReport,
    EvalCase,
    EvalDatasetInfo,
    RunRequest,
    RunSummary,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/eval", tags=["eval"])


# ---- datasets -------------------------------------------------------------------------------------------------
@router.get("/datasets", response_model=list[EvalDatasetInfo])
def datasets() -> list[EvalDatasetInfo]:
    return list_datasets()


@router.get("/datasets/{dataset_id}/cases", response_model=list[EvalCase])
def dataset_cases(dataset_id: str, offset: int = 0, limit: int = 100, tag: str | None = None,
                  split: str | None = None) -> list[EvalCase]:
    try:
        ds = load_dataset(dataset_id)
    except FileNotFoundError:
        raise HTTPException(404, detail=f"dataset {dataset_id!r} not found") from None
    cases = [c for c in ds.cases if (not tag or tag in c.tags) and (not split or c.split == split)]
    return cases[offset: offset + limit]


@router.post("/datasets/generate", response_model=JobStatus, status_code=202)
def generate_dataset(req: DatasetGenerateRequest) -> JobStatus:
    try:
        from backend.synth.build_dataset import build_dataset
    except Exception as exc:
        raise HTTPException(501, detail=f"synthetic data generator unavailable: {exc}") from exc

    def work(ctx: JobContext) -> EvalDatasetInfo:
        return build_dataset(req.name, req.n_cases, req.seed, req.with_audio, req.audio_limit, req.augment,
                             progress=lambda f, m: ctx.report(f, m))

    return job_manager.submit("dataset_build", work)


# ---- runs -----------------------------------------------------------------------------------------------------
def _store() -> RunStore:
    return RunStore()


@router.post("/runs", response_model=JobStatus, status_code=202)
def start_run(req: RunRequest) -> JobStatus:
    try:
        load_dataset(req.dataset_id)
    except FileNotFoundError:
        raise HTTPException(404, detail=f"dataset {req.dataset_id!r} not found") from None
    if not req.configs:
        raise HTTPException(422, detail="no configurations selected")
    store = _store()
    run_id = store.new_run_id()

    def work(ctx: JobContext) -> dict:
        summary = EvalRunner(store=store).run(req, run_id=run_id, progress=ctx.report, cancelled=ctx.cancelled)
        if summary.status == "cancelled":
            raise JobCancelled()
        if summary.status == "failed":
            raise RuntimeError("; ".join(summary.notes[-1:]) or "run failed")
        return {"run_id": run_id}

    try:
        return job_manager.submit("eval_run", work, exclusive=True, initial_result={"run_id": run_id})
    except JobBusy as busy:
        raise HTTPException(409, detail={"code": "run_in_progress", "message": str(busy),
                                         "job_id": busy.existing.id}) from None


@router.get("/runs", response_model=list[RunSummary])
def list_runs() -> list[RunSummary]:
    return _store().list_summaries()


@router.get("/runs/{run_id}", response_model=RunSummary)
def get_run(run_id: str) -> RunSummary:
    try:
        return _store().load_summary(run_id)
    except FileNotFoundError:
        raise HTTPException(404, detail="run not found") from None


@router.get("/runs/{run_id}/cases", response_model=list[CaseResult])
def run_cases(run_id: str, config_key: str | None = None, only_failures: bool = False, offset: int = 0,
              limit: int = 100) -> list[CaseResult]:
    get_run(run_id)
    return _store().load_cases(run_id, config_key, only_failures, offset, limit)


@router.get("/runs/{run_id}/decision", response_model=DecisionReport)
def run_decision(run_id: str, max_p95_ms: float = 5000.0, min_id_field_accuracy: float = 0.95,
                 max_silent_wrong: float = 0.02, max_peak_rss_mb: float | None = None,
                 min_field_accuracy: float = 0.0) -> DecisionReport:
    summary = get_run(run_id)
    gates = DecisionGates(max_p95_ms=max_p95_ms, min_id_field_accuracy=min_id_field_accuracy,
                          max_silent_wrong=max_silent_wrong, max_peak_rss_mb=max_peak_rss_mb,
                          min_field_accuracy=min_field_accuracy)
    return decide(summary, gates)


_CSV_COLUMNS = [
    "config_key", "stt", "llm", "strategy", "n_cases", "n_errors", "field_accuracy", "id_field_accuracy",
    "silent_wrong_rate", "hallucination_rate", "review_rate", "safe_outcome_rate", "schema_valid_rate", "wer",
    "wer_normalized", "id_exact_match", "rtf", "total_p50_ms", "total_p95_ms", "stt_p95_ms", "extract_p95_ms",
    "llm_p95_ms", "prompt_tokens_mean", "output_tokens_mean", "cold_start_ms", "peak_rss_mb", "model_size_mb",
]


@router.get("/runs/{run_id}/export")
def export_run(run_id: str, format: str = Query("csv", pattern="^(csv|json|md)$")) -> Response:
    summary = get_run(run_id)
    if format == "json":
        return JSONResponse(summary.model_dump(mode="json"),
                            headers={"Content-Disposition": f'attachment; filename="{run_id}.json"'})
    if format == "md":
        md = markdown_report(summary, decide(summary))
        return Response(md, media_type="text/markdown",
                        headers={"Content-Disposition": f'attachment; filename="{run_id}.md"'})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(_CSV_COLUMNS)
    for m in summary.configs:
        w.writerow([
            m.config_key, m.config.stt_engine_id, m.config.llm_engine_id, m.config.strategy_id, m.n_cases, m.n_errors,
            m.field_accuracy, m.id_field_accuracy, m.silent_wrong_rate, m.hallucination_rate, m.review_rate,
            m.safe_outcome_rate, m.schema_valid_rate, m.wer, m.wer_normalized, m.id_exact_match, m.rtf,
            m.latency_total.p50, m.latency_total.p95, m.latency_stt.p95, m.latency_extract.p95, m.latency_llm.p95,
            m.llm_prompt_tokens_mean, m.llm_output_tokens_mean, m.cold_start_ms, m.peak_rss_mb, m.model_size_mb])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{run_id}.csv"'})


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str) -> Response:
    _store().delete(run_id)
    return Response(status_code=204)

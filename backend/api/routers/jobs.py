"""Background jobs."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.api.jobs import job_manager
from backend.schemas.engines import JobStatus

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])


@router.get("", response_model=list[JobStatus])
def list_jobs() -> list[JobStatus]:
    return job_manager.list()


@router.get("/{job_id}", response_model=JobStatus)
def get_job(job_id: str) -> JobStatus:
    try:
        return job_manager.get(job_id)
    except KeyError:
        raise HTTPException(404, detail="job not found") from None


@router.post("/{job_id}/cancel", response_model=JobStatus)
def cancel_job(job_id: str) -> JobStatus:
    try:
        return job_manager.cancel(job_id)
    except KeyError:
        raise HTTPException(404, detail="job not found") from None

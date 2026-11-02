"""The downloaded work package."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.api.jobs import JobBusy, JobContext, job_manager
from backend.demo import auth, bundle
from backend.demo.connectivity import connectivity
from backend.schemas.engines import JobStatus
from backend.schemas.workorders import BundleSummary

router = APIRouter(prefix="/api/v1/bundle", tags=["bundle"])


@router.get("", response_model=BundleSummary | None)
def get_bundle() -> BundleSummary | None:
    b = bundle.get_bundle()
    return bundle.summarize(b) if b else None


@router.post("/sync", response_model=JobStatus, status_code=202)
def sync() -> JobStatus:
    connectivity.require_online()  # fail fast with 503 instead of starting a job that cannot succeed
    if auth.current_session() is None:
        raise auth.AuthError(401, "unauthenticated", "Sign in before downloading today's work.")

    def work(ctx: JobContext) -> BundleSummary:
        return bundle.sync_bundle(ctx.report)

    try:
        return job_manager.submit("bundle_sync", work, exclusive=True)
    except JobBusy as busy:
        raise HTTPException(409, detail={"code": "sync_in_progress", "message": str(busy), "job_id": busy.existing.id}) from None

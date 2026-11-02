"""Morning prep (connected): verify session -> download work package -> compile reference data -> models -> readiness."""
from __future__ import annotations

import logging
import time
from collections.abc import Callable

from fastapi import APIRouter, HTTPException

from backend.api.compat import get_bundle, get_connectivity, get_session
from backend.api.jobs import JobBusy, JobCancelled, JobContext, job_manager
from backend.core.formpack import get_formpack
from backend.demo.readiness import run_readiness
from backend.engines.registry import get_registry
from backend.schemas.api import MorningResult, MorningStep
from backend.schemas.engines import AvailabilityState, JobStatus
from backend.schemas.system import ReadinessReport, ReadinessStatus

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/morning", tags=["morning"])

_STEPS = [
    ("authenticate", "Verify worker session"),
    ("download_bundle", "Download today's work package"),
    ("sync_reference", "Compile forms and index the knowledge base"),
    ("ensure_models", "Make sure the AI models are on the device"),
    ("readiness", "Offline-readiness self-test"),
]
# share of the overall progress bar given to each step (model downloads dominate on a cold device)
_WEIGHTS = {"authenticate": 0.02, "download_bundle": 0.18, "sync_reference": 0.08, "ensure_models": 0.60,
            "readiness": 0.12}
Report = Callable[[float, str], None]


class _Run:
    def __init__(self, ctx: JobContext) -> None:
        self.ctx = ctx
        self.result = MorningResult(steps=[MorningStep(id=i, label=l) for i, l in _STEPS])  # type: ignore[arg-type]
        self._base = 0.0

    def publish(self) -> None:
        self.ctx.set_result(self.result.model_copy(deep=True))

    def step(self, step_id: str, fn: Callable[[Report], tuple[ReadinessStatus, str]]) -> MorningStep:
        if self.ctx.cancelled():
            raise JobCancelled()
        st = next(s for s in self.result.steps if s.id == step_id)
        weight = _WEIGHTS[step_id]
        lo, hi = self._base, self._base + weight
        self._base = hi

        def report(frac: float, msg: str = "") -> None:
            st.detail = msg or st.detail
            self.ctx.report(lo + (hi - lo) * max(0.0, min(1.0, frac)), f"{st.label}: {msg}" if msg else st.label)
            self.publish()

        st.status = ReadinessStatus.RUNNING
        self.ctx.report(lo, st.label)
        self.publish()
        t0 = time.perf_counter()
        try:
            st.status, st.detail = fn(report)
        except JobCancelled:
            raise
        except Exception as exc:
            log.exception("morning step %s failed", step_id)
            st.status, st.detail = ReadinessStatus.FAIL, f"{type(exc).__name__}: {exc}"
        st.duration_ms = (time.perf_counter() - t0) * 1000.0
        self.ctx.report(hi, st.label)
        self.publish()
        return st

    def skip_remaining(self, reason: str) -> None:
        for s in self.result.steps:
            if s.status == ReadinessStatus.PENDING:
                s.detail = f"skipped - {reason}"


# ---- steps ------------------------------------------------------------------------------------------------------
def _authenticate(report: Report) -> tuple[ReadinessStatus, str]:
    s = get_session()
    if s is None:
        return ReadinessStatus.FAIL, "no worker signed in - sign in first"
    return ReadinessStatus.PASS, f"{s.worker.name} ({s.mode}); offline unlock valid until {s.offline_grant_expires_at}"


def _download_bundle(report: Report) -> tuple[ReadinessStatus, str]:
    existing = get_bundle()
    if not get_connectivity().online:
        if existing is not None:
            return ReadinessStatus.WARN, (f"offline - keeping the package already on the device "
                                          f"(issued {existing.issued_at})")
        return ReadinessStatus.FAIL, "offline and no work package on the device - reconnect to download today's work"
    from backend.demo.bundle import sync_bundle

    try:
        s = sync_bundle(report)
    except Exception as exc:
        if existing is not None:
            return ReadinessStatus.WARN, f"download failed ({exc}); keeping the package issued {existing.issued_at}"
        raise
    return ReadinessStatus.PASS, (f"{s.n_work_orders} work orders, {s.n_forms} forms, {s.n_assets} assets, "
                                  f"{s.n_kb_docs} KB documents")


def _sync_reference(report: Report) -> tuple[ReadinessStatus, str]:
    bundle = get_bundle()
    if bundle is None:
        return ReadinessStatus.FAIL, "no work package to compile"
    t0 = time.perf_counter()
    n = max(1, len(bundle.forms))
    for i, form in enumerate(bundle.forms):
        get_formpack(form)
        report((i + 1) / n * 0.7, f"compiled {form.id}")
    detail = f"{len(bundle.forms)} form packs compiled, {len(bundle.assets)} assets in the closed world"
    status = ReadinessStatus.PASS
    if bundle.kb_docs:
        try:
            from backend.demo.kb import search

            search("transformer", None, 3)  # builds the local index if it is lazy
            detail += f", {len(bundle.kb_docs)} KB documents indexed"
        except Exception as exc:
            status, detail = ReadinessStatus.WARN, detail + f"; KB index unavailable ({exc})"
    report(1.0, f"{(time.perf_counter() - t0) * 1000:.0f} ms")
    return status, detail


def _ensure_models(report: Report) -> tuple[ReadinessStatus, str]:
    bundle = get_bundle()
    if bundle is None:
        return ReadinessStatus.FAIL, "no work package, so the model manifest is unknown"
    reqs = bundle.model_manifest.requirements
    if not reqs:
        return ReadinessStatus.WARN, "the package lists no models - rules-only extraction will be used"
    reg = get_registry()
    online = get_connectivity().online
    ready: list[str] = []
    missing_required: list[str] = []
    missing_optional: list[str] = []
    for i, r in enumerate(reqs):
        lo, hi = i / len(reqs), (i + 1) / len(reqs)

        def sub(frac: float, msg: str = "", lo: float = lo, hi: float = hi, alias: str = r.alias) -> None:
            report(lo + (hi - lo) * frac, f"{alias}: {msg}" if msg else alias)

        bucket = missing_required if r.required else missing_optional
        try:
            info = reg.info(r.engine_id)
        except KeyError:
            bucket.append(f"{r.alias} (not available in this build)")
            continue
        on_device = info.availability == AvailabilityState.READY or info.loaded
        if not on_device and not online:
            bucket.append(f"{r.alias} (not on device, and offline)")
            continue
        if info.availability in (AvailabilityState.UNAVAILABLE, AvailabilityState.ERROR) and not info.loaded:
            bucket.append(f"{r.alias} ({info.availability_reason or info.availability.value})")
            continue
        try:
            ms = reg.prepare(r.engine_id, sub)
            ready.append(f"{r.alias} ({'loaded' if on_device else 'downloaded'}, {ms:.0f} ms)")
        except JobCancelled:
            raise
        except Exception as exc:
            bucket.append(f"{r.alias} ({exc})")
    detail = "; ".join(ready) if ready else "no model could be prepared"
    if missing_required:
        return ReadinessStatus.FAIL, detail + " | missing: " + ", ".join(missing_required)
    if missing_optional:
        return ReadinessStatus.WARN, detail + " | optional missing: " + ", ".join(missing_optional)
    return ReadinessStatus.PASS, detail


# ---- route ------------------------------------------------------------------------------------------------------
@router.post("/start", response_model=JobStatus, status_code=202)
def start_morning() -> JobStatus:
    def work(ctx: JobContext) -> MorningResult:
        run = _Run(ctx)
        run.publish()
        if run.step("authenticate", _authenticate).status == ReadinessStatus.FAIL:
            run.skip_remaining("not signed in")
            return run.result
        if run.step("download_bundle", _download_bundle).status == ReadinessStatus.FAIL:
            run.skip_remaining("no work package")
            return run.result
        run.step("sync_reference", _sync_reference)
        run.step("ensure_models", _ensure_models)

        def readiness_step(report: Report) -> tuple[ReadinessStatus, str]:
            def update(checks) -> None:
                run.result.readiness = ReadinessReport(overall=ReadinessStatus.RUNNING, checks=list(checks))
                report(len(checks) / 8.0, checks[-1].label)

            rep = run_readiness(update)
            run.result.readiness = rep
            failing = [c.label for c in rep.checks if c.status == ReadinessStatus.FAIL]
            warns = [c.label for c in rep.checks if c.status == ReadinessStatus.WARN]
            detail = f"{sum(c.status == ReadinessStatus.PASS for c in rep.checks)}/{len(rep.checks)} checks passed"
            if failing:
                detail += "; failing: " + ", ".join(failing)
            elif warns:
                detail += "; warnings: " + ", ".join(warns)
            return rep.overall, detail

        run.step("readiness", readiness_step)
        rep = run.result.readiness
        run.result.ready_to_go_offline = (
            rep is not None and rep.overall != ReadinessStatus.FAIL
            and all(s.status in (ReadinessStatus.PASS, ReadinessStatus.WARN) for s in run.result.steps))
        run.ctx.report(1.0, "ready to go offline" if run.result.ready_to_go_offline else "needs attention")
        return run.result

    try:
        return job_manager.submit("morning_sync", work, exclusive=True)
    except JobBusy as busy:
        raise HTTPException(409, detail={"code": "morning_in_progress", "message": str(busy),
                                         "job_id": busy.existing.id}) from None

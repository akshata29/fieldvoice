"""System status, connectivity switch, hardware, readiness."""
from __future__ import annotations

from fastapi import APIRouter

from backend.api.compat import connectivity_state, get_bundle_summary, get_connectivity, get_session
from backend.api.jobs import JobContext, job_manager
from backend.demo.readiness import last_report, run_readiness
from backend.engines.foundry_runtime import get_runtime
from backend.evalkit.hardware import get_hardware_info
from backend.schemas.api import ConnectivityRequest
from backend.schemas.engines import JobStatus
from backend.schemas.system import ConnectivityState, HardwareInfo, ReadinessReport, SystemStatus

router = APIRouter(prefix="/api/v1", tags=["system"])


@router.get("/system/status", response_model=SystemStatus)
def system_status() -> SystemStatus:
    return SystemStatus(
        connectivity=connectivity_state(), session=get_session(), bundle=get_bundle_summary(),
        readiness=last_report(), hardware=get_hardware_info(), foundry=get_runtime().status())


@router.post("/system/connectivity", response_model=ConnectivityState)
def set_connectivity(req: ConnectivityRequest) -> ConnectivityState:
    get_connectivity().set_online(req.online)
    return connectivity_state()


@router.get("/system/hardware", response_model=HardwareInfo)
def hardware() -> HardwareInfo:
    return get_hardware_info()


@router.get("/readiness", response_model=ReadinessReport | None)
def get_readiness() -> ReadinessReport | None:
    return last_report()


@router.post("/readiness/run", response_model=JobStatus, status_code=202)
def start_readiness() -> JobStatus:
    def work(ctx: JobContext) -> ReadinessReport:
        ctx(0.05, "Running offline-readiness checks")

        def update(checks):
            ctx.set_result(ReadinessReport(overall="running", checks=list(checks)))  # type: ignore[arg-type]

        return run_readiness(update)

    return job_manager.submit("readiness", work)

"""Dispatcher console: the *remote* world. Always reachable, regardless of the device's connectivity switch."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from backend.demo.sor.service import SorError, get_sor
from backend.demo.store import reset_store
from backend.schemas.api import BumpRequest, SorFaults, SorState
from backend.schemas.workorders import WorkOrder

router = APIRouter(prefix="/api/v1/sor", tags=["dispatcher"])


@router.get("/state", response_model=SorState)
def state() -> SorState:
    return get_sor().state()


@router.post("/workorders/{work_order_id}/bump", response_model=WorkOrder)
def bump(work_order_id: str, req: BumpRequest | None = None) -> WorkOrder:
    try:
        return get_sor().bump(work_order_id, req or BumpRequest())
    except SorError as exc:
        raise HTTPException(exc.status, detail=exc.detail()) from None


@router.post("/faults", response_model=SorFaults)
def set_faults(faults: SorFaults) -> SorFaults:
    return get_sor().set_faults(faults)


@router.post("/reset", status_code=204)
def reset(device: bool = False) -> Response:
    """Reset the remote system to its initial state. ``?device=true`` also wipes this device's local store (a clean demo run)."""
    get_sor().reset()
    if device:
        from backend.config import get_settings
        from backend.demo.connectivity import connectivity
        from backend.demo.readiness import clear_report

        reset_store()
        clear_report()
        connectivity.set_online(True)  # a clean take starts connected, like the morning
        for name in ("app.db", "app.db-wal", "app.db-shm"):
            (get_settings().demo_dir / name).unlink(missing_ok=True)
    return Response(status_code=204)

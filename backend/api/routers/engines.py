"""Engines, models and the Foundry catalog."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from backend.api.compat import get_bundle
from backend.api.jobs import JobContext, job_manager
from backend.engines.base import EngineError
from backend.engines.foundry_runtime import get_runtime
from backend.engines.registry import get_registry
from backend.schemas.api import CatalogModel, EngineList
from backend.schemas.engines import EngineInfo, JobStatus

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/engines", tags=["engines"])


@router.get("", response_model=EngineList)
def list_engines() -> EngineList:
    """All engines; the ones the downloaded work package asks this device to hold come first (tagged ``in-work-package``),
    so a UI that picks "the first ready engine" picks what morning prep prepared."""
    engines = get_registry().list_engines()
    bundle = get_bundle()
    wanted = {r.engine_id for r in bundle.model_manifest.requirements} if bundle else set()
    if wanted:
        for group in (engines.stt, engines.llm):
            for e in group:
                if e.id in wanted and "in-work-package" not in e.tags:
                    e.tags = [*e.tags, "in-work-package"]
            group.sort(key=lambda e: e.id not in wanted)  # stable: manifest engines first, order otherwise unchanged
    return engines


@router.get("/catalog", response_model=list[CatalogModel])
def catalog() -> list[CatalogModel]:
    try:
        return get_runtime().catalog()
    except EngineError as exc:
        raise HTTPException(503, detail=str(exc)) from exc


@router.post("/{engine_id}/prepare", response_model=JobStatus, status_code=202)
def prepare_engine(engine_id: str) -> JobStatus:
    reg = get_registry()
    try:
        reg.info(engine_id)
    except KeyError:
        raise HTTPException(404, detail=f"unknown engine {engine_id!r}") from None

    def work(ctx: JobContext) -> EngineInfo:
        ms = reg.prepare(engine_id, lambda f, m: ctx(f, m))
        info = reg.info(engine_id)
        ctx(1.0, f"{info.name} ready (load {ms:.0f} ms)")
        return info

    return job_manager.submit("prepare_engine", work)


@router.post("/{engine_id}/unload", response_model=EngineInfo)
def unload_engine(engine_id: str) -> EngineInfo:
    reg = get_registry()
    try:
        reg.unload(engine_id)
        return reg.info(engine_id)
    except KeyError:
        raise HTTPException(404, detail=f"unknown engine {engine_id!r}") from None

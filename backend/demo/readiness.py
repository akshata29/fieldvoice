"""Offline-readiness check: proves the device can work a full day without the network."""
from __future__ import annotations

import logging
import shutil
import time
from collections.abc import Callable

from backend.api.compat import get_bundle, get_session, now_iso
from backend.config import get_settings
from backend.core.formpack import get_formpack
from backend.core.golden import GOLDEN_EXPECTED, GOLDEN_TRANSCRIPT, golden_assets, golden_form
from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.engines.registry import get_registry
from backend.schemas.engines import AvailabilityState
from backend.schemas.system import ReadinessCheck, ReadinessReport, ReadinessStatus

log = logging.getLogger(__name__)
MIN_FREE_DISK_GB = 2.0
SELF_TEST_BUDGET_MS = 5000.0

_last: ReadinessReport | None = None


def last_report() -> ReadinessReport | None:
    global _last
    if _last is None:
        p = get_settings().demo_dir / "readiness.json"
        if p.exists():
            try:
                _last = ReadinessReport.model_validate_json(p.read_text(encoding="utf-8"))
            except Exception:
                pass
    return _last


def _save(report: ReadinessReport) -> None:
    global _last
    _last = report
    d = get_settings().demo_dir
    d.mkdir(parents=True, exist_ok=True)
    (d / "readiness.json").write_text(report.model_dump_json(indent=1), encoding="utf-8")


def clear_report() -> None:
    """Forget the last report (a device reset: nothing has been checked on a device that has nothing on it)."""
    global _last
    _last = None
    (get_settings().demo_dir / "readiness.json").unlink(missing_ok=True)


def _check(checks: list[ReadinessCheck], cid: str, label: str, fn: Callable[[], tuple[ReadinessStatus, str]],
           on_update: Callable[[list[ReadinessCheck]], None] | None) -> None:
    chk = ReadinessCheck(id=cid, label=label, status=ReadinessStatus.RUNNING)
    checks.append(chk)
    if on_update:
        on_update(checks)
    t0 = time.perf_counter()
    try:
        chk.status, chk.detail = fn()
    except Exception as exc:
        chk.status, chk.detail = ReadinessStatus.FAIL, f"{type(exc).__name__}: {exc}"
    chk.duration_ms = (time.perf_counter() - t0) * 1000.0
    if on_update:
        on_update(checks)


def run_readiness(on_update: Callable[[list[ReadinessCheck]], None] | None = None,
                  require_session: bool = True) -> ReadinessReport:
    checks: list[ReadinessCheck] = []
    reg = get_registry()
    bundle = get_bundle()

    def auth() -> tuple[ReadinessStatus, str]:
        s = get_session()
        if s is None:
            return (ReadinessStatus.FAIL if require_session else ReadinessStatus.WARN), "no worker signed in"
        return ReadinessStatus.PASS, f"{s.worker.name}; offline grant until {s.offline_grant_expires_at}"

    def bundle_check() -> tuple[ReadinessStatus, str]:
        if bundle is None:
            return ReadinessStatus.FAIL, "no bundle downloaded"
        if bundle.expires_at < now_iso():
            return ReadinessStatus.FAIL, f"bundle expired at {bundle.expires_at}"
        return ReadinessStatus.PASS, f"{len(bundle.work_orders)} work orders, {len(bundle.assets)} assets"

    def forms() -> tuple[ReadinessStatus, str]:
        if bundle is None:
            return ReadinessStatus.WARN, "no bundle to compile forms from"
        t0 = time.perf_counter()
        for f in bundle.forms:
            get_formpack(f)
        missing = [w.id for w in bundle.work_orders if not any(f.id == w.form_id for f in bundle.forms)]
        if missing:
            return ReadinessStatus.FAIL, f"work orders without a form: {', '.join(missing)}"
        return ReadinessStatus.PASS, f"{len(bundle.forms)} form packs compiled in {(time.perf_counter() - t0) * 1000:.0f} ms"

    def kb() -> tuple[ReadinessStatus, str]:
        if bundle is None or not bundle.kb_docs:
            return ReadinessStatus.WARN, "no knowledge-base documents"
        from backend.demo.kb import search

        hits = search("safety", None, 3)
        return ReadinessStatus.PASS, f"{len(bundle.kb_docs)} documents indexed ({len(hits)} test hits)"

    def storage() -> tuple[ReadinessStatus, str]:
        d = get_settings().data_dir
        d.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(d).free / 1024 ** 3
        probe = d / ".write_probe"
        probe.write_text("ok")
        probe.unlink()
        if free < MIN_FREE_DISK_GB:
            return ReadinessStatus.WARN, f"only {free:.1f} GB free"
        return ReadinessStatus.PASS, f"writable, {free:.0f} GB free"

    required = []
    if bundle is not None:
        required = [r for r in bundle.model_manifest.requirements]

    def models_cached() -> tuple[ReadinessStatus, str]:
        if not required:
            return ReadinessStatus.WARN, "bundle lists no model requirements (rules-only fallback)"
        missing_req, missing_opt = [], []
        for r in required:
            try:
                info = reg.info(r.engine_id)
                ok = info.availability == AvailabilityState.READY or info.loaded
            except KeyError:
                ok = False
            if not ok:
                (missing_req if r.required else missing_opt).append(r.engine_id)
        if missing_req:
            return ReadinessStatus.FAIL, "not on device: " + ", ".join(missing_req)
        if missing_opt:
            return ReadinessStatus.WARN, "optional not on device: " + ", ".join(missing_opt)
        return ReadinessStatus.PASS, f"{len(required)} model assets present"

    def models_load() -> tuple[ReadinessStatus, str]:
        loaded, failed = [], []
        for r in required:
            try:
                ms = reg.prepare(r.engine_id)
                loaded.append(f"{r.alias} ({ms:.0f} ms)")
            except Exception as exc:
                failed.append(f"{r.alias}: {exc}")
        if failed:
            return (ReadinessStatus.FAIL if any(r.required for r in required) else ReadinessStatus.WARN), "; ".join(failed)
        return ReadinessStatus.PASS, ", ".join(loaded) if loaded else "nothing to load"

    def self_test() -> tuple[ReadinessStatus, str]:
        llm = None
        llm_id = next((r.engine_id for r in required if r.role == "llm"), None)
        if llm_id:
            try:
                llm = reg.get_llm(llm_id)
            except KeyError:
                llm = None
        res = ExtractionPipeline().run(
            PipelineInput(transcript=GOLDEN_TRANSCRIPT, form=golden_form(), assets=golden_assets()),
            "hybrid", llm if llm and reg.info(llm_id).loaded else None)  # type: ignore[arg-type]
        wrong = [k for k, v in GOLDEN_EXPECTED.items() if res.fields[k].value != v]
        if res.error or wrong:
            return ReadinessStatus.FAIL, f"golden utterance wrong fields: {wrong or res.error}"
        detail = f"golden utterance correct in {res.total_ms:.0f} ms"
        if llm is not None:
            # also exercise the LLM once with a colloquial phrase so a broken model/grammar is caught before going offline
            t0 = time.perf_counter()
            res2 = ExtractionPipeline().run(
                PipelineInput(transcript="Replaced the transformer at pole 123, the old unit was weeping badly, "
                                         "installed unit 456.", form=golden_form(), assets=golden_assets()),
                "hybrid", llm)
            ms = (time.perf_counter() - t0) * 1000.0
            if res2.error:
                return ReadinessStatus.FAIL, f"LLM stage failed: {res2.error}"
            detail += f"; LLM stage ok in {ms:.0f} ms"
            if ms > SELF_TEST_BUDGET_MS:
                return ReadinessStatus.WARN, detail + f" (over the {SELF_TEST_BUDGET_MS:.0f} ms budget)"
        return ReadinessStatus.PASS, detail

    _check(checks, "auth", "Worker signed in", auth, on_update)
    _check(checks, "bundle", "Work package downloaded", bundle_check, on_update)
    _check(checks, "forms", "Forms compiled", forms, on_update)
    _check(checks, "kb", "Knowledge base searchable offline", kb, on_update)
    _check(checks, "storage", "Local storage writable", storage, on_update)
    _check(checks, "models_cached", "AI models present on device", models_cached, on_update)
    _check(checks, "models_load", "AI models load", models_load, on_update)
    _check(checks, "self_test", "Self-test (golden utterance)", self_test, on_update)

    statuses = {c.status for c in checks}
    overall = ReadinessStatus.FAIL if ReadinessStatus.FAIL in statuses else \
        ReadinessStatus.WARN if ReadinessStatus.WARN in statuses else ReadinessStatus.PASS
    report = ReadinessReport(overall=overall, checks=checks, generated_at=now_iso())
    _save(report)
    return report


def models_requirements_ids() -> list[str]:
    b = get_bundle()
    return [r.engine_id for r in b.model_manifest.requirements] if b else []

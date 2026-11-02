"""Evaluation runner: executes a matrix of (STT engine x LLM engine x strategy) over a dataset and aggregates metrics."""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import psutil

from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.core.strategies import get_strategy
from backend.engines.base import EngineError, ProgressFn, SttResult
from backend.engines.registry import EngineRegistry, get_registry
from backend.evalkit.dataset import Dataset, load_dataset
from backend.evalkit.hardware import get_hardware_info, process_rss_mb
from backend.evalkit.metrics import (
    CaseRecord,
    CaseScore,
    aggregate,
    id_exact_match,
    score_case,
    to_case_result,
    wer,
    wer_normalized,
)
from backend.evalkit.store import RunStore, now_iso
from backend.schemas.engines import NO_LLM_ID, ORACLE_STT_ID
from backend.schemas.eval import EvalCase, RunConfig, RunRequest, RunSummary
from backend.schemas.extraction import StageTiming
from backend.schemas.system import HardwareInfo

log = logging.getLogger(__name__)


class RunCancelled(Exception):
    pass


@dataclass
class Replay:
    """Speech results to reuse instead of transcribing again (see ``EvalRunner.rescore``)."""

    stt_cache: dict[tuple[str, str], SttResult]
    stt_stats: dict[str, dict[str, float]]
    hardware: HardwareInfo | None = None
    notes: list[str] = field(default_factory=list)


class RssSampler:
    """Samples this process' resident memory while engines load and run (delta over the starting point)."""

    def __init__(self, interval: float = 0.05) -> None:
        self.interval = interval
        self.base_mb = 0.0
        self.peak_mb = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._proc = psutil.Process()

    def __enter__(self) -> RssSampler:
        self.base_mb = self.peak_mb = self._proc.memory_info().rss / 1024 ** 2

        def loop() -> None:
            while not self._stop.is_set():
                self.peak_mb = max(self.peak_mb, self._proc.memory_info().rss / 1024 ** 2)
                time.sleep(self.interval)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
        self.peak_mb = max(self.peak_mb, self._proc.memory_info().rss / 1024 ** 2)

    @property
    def delta_mb(self) -> float:
        return max(0.0, self.peak_mb - self.base_mb)


class EvalRunner:
    def __init__(self, registry: EngineRegistry | None = None, store: RunStore | None = None,
                 pipeline: ExtractionPipeline | None = None) -> None:
        self.reg = registry or get_registry()
        self.store = store or RunStore()
        self.pipeline = pipeline or ExtractionPipeline()

    # ------------------------------------------------------------------------------------------------------------
    @staticmethod
    def select_cases(ds: Dataset, req: RunRequest) -> list[EvalCase]:
        cases = ds.cases
        if req.splits:
            cases = [c for c in cases if c.split in req.splits]
        if req.tags:
            cases = [c for c in cases if set(c.tags) & set(req.tags)]
        if req.limit:
            cases = cases[: req.limit]
        return cases

    def run(self, req: RunRequest, run_id: str | None = None, progress: ProgressFn | None = None,
            cancelled: Callable[[], bool] = lambda: False, replay: Replay | None = None) -> RunSummary:
        ds = load_dataset(req.dataset_id)
        cases = self.select_cases(ds, req)
        run_id = run_id or self.store.new_run_id()
        summary = RunSummary(
            run_id=run_id, label=req.label, created_at=now_iso(), dataset_id=req.dataset_id, status="running",
            hardware=(replay.hardware if replay and replay.hardware else None) or get_hardware_info(), request=req,
            notes=["Peak RAM is the estimated resident footprint of the models (delta over the process baseline), "
                   "STT and LLM phases summed.",
                   "Latency excludes one-off model load (reported as cold start)."],
        )
        if replay:
            summary.notes.extend(replay.notes)
        if summary.hardware.notes:
            summary.notes.extend(summary.hardware.notes)
        self.store.save_summary(summary)

        last_save = [0.0]

        def report(frac: float, msg: str) -> None:
            summary.progress = max(0.0, min(1.0, frac))
            if progress:
                progress(summary.progress, msg)
            now = time.monotonic()
            if now - last_save[0] > 1.5:  # keep the on-disk summary fresh for pollers
                last_save[0] = now
                self.store.save_summary(summary)

        try:
            replayed = {stt for stt, _ in replay.stt_cache} if replay else set()
            stt_ids = sorted({c.stt_engine_id for c in req.configs if c.stt_engine_id != ORACLE_STT_ID} - replayed)
            n_audio = sum(1 for c in cases if ds.audio_path(c))
            units = max(1, len(stt_ids) * n_audio + len(req.configs) * len(cases) * max(1, req.repeats))
            done = 0

            # ---- phase A: speech-to-text once per engine -------------------------------------------------------
            stt_cache: dict[tuple[str, str], object] = dict(replay.stt_cache) if replay else {}
            stt_stats: dict[str, dict[str, float]] = dict(replay.stt_stats) if replay else {}
            stt_errors: dict[str, str] = {}
            for stt_id in stt_ids:
                if cancelled():
                    raise RunCancelled()
                self.reg.unload_all()
                try:
                    with RssSampler() as rs:
                        load_ms = self.reg.prepare(stt_id, lambda f, m: report(done / units, m))
                        engine = self.reg.get_stt(stt_id)
                        info = engine.info()
                        first = next((ds.audio_path(c) for c in cases if ds.audio_path(c)), None)
                        if first is not None:
                            engine.transcribe_file(first)  # warm-up
                        for c in cases:
                            if cancelled():
                                raise RunCancelled()
                            p = ds.audio_path(c)
                            if p is None:
                                continue
                            stt_cache[(stt_id, c.id)] = engine.transcribe_file(p)
                            done += 1
                            report(done / units, f"{info.name}: transcribed {c.id}")
                    stt_stats[stt_id] = {"load_ms": load_ms, "peak_mb": rs.delta_mb, "size_mb": info.size_mb or 0.0}
                except RunCancelled:
                    raise
                except Exception as exc:  # engine unavailable: configs using it are reported as failed
                    log.warning("STT engine %s failed: %s", stt_id, exc)
                    stt_errors[stt_id] = str(exc)
                    done += n_audio
                finally:
                    try:
                        self.reg.unload(stt_id)
                    except Exception:
                        pass

            # ---- phase B: extraction per config ----------------------------------------------------------------
            for cfg in req.configs:
                if cancelled():
                    raise RunCancelled()
                metrics, case_results = self._run_config(
                    ds, cases, cfg, req, stt_cache, stt_stats, stt_errors, cancelled,
                    lambda n, _cfg=cfg: report((done + n) / units, f"{_cfg.key}"))
                done += len(cases) * max(1, req.repeats)
                summary.configs.append(metrics)
                self.store.append_cases(run_id, case_results)
                self.store.save_summary(summary)
                report(done / units, f"finished {cfg.key}")

            summary.status = "succeeded"
        except RunCancelled:
            summary.status = "cancelled"
        except Exception as exc:
            log.exception("run failed")
            summary.status = "failed"
            summary.notes.append(f"run failed: {exc}")
        finally:
            self.reg.unload_all()
            summary.finished_at = now_iso()
            summary.progress = 1.0 if summary.status == "succeeded" else summary.progress
            self.store.save_summary(summary)
        return summary

    def rescore(self, source_run_id: str, label: str | None = None, run_id: str | None = None,
                progress: ProgressFn | None = None, cancelled: Callable[[], bool] = lambda: False) -> RunSummary:
        """Run extraction and scoring again on the transcripts a past run stored (no audio, no speech engine).

        Use it after changing the normalizer, resolver or lexicon: the speech engines' words are fixed, so the
        comparison takes seconds instead of the hour the audio took. Speech timings, cold start and memory are carried
        over from the source run. Configurations that call a language model are skipped (re-run those).
        """
        src = self.store.load_summary(source_run_id)
        ds = load_dataset(src.dataset_id)
        by_id = {c.id: c for c in ds.cases}
        cache: dict[tuple[str, str], SttResult] = {}
        stats: dict[str, dict[str, float]] = {}
        metrics_by_key = {m.config_key: m for m in src.configs}
        configs: list[RunConfig] = []
        notes = [f"Rescored from run {src.run_id}: transcripts and speech timings are the stored ones; "
                 "extraction and scoring ran again with the current code."]
        for cfg in src.request.configs:
            if get_strategy(cfg.strategy_id).uses_llm:
                notes.append(f"Skipped {cfg.key}: it calls a language model, re-run it instead.")
                continue
            if cfg.stt_engine_id != ORACLE_STT_ID:
                kept = 0
                for r in self.store.load_cases(src.run_id, config_key=cfg.key, limit=10 ** 9):
                    case = by_id.get(r.case_id)
                    if case is None or case.expected != r.expected:
                        continue  # the dataset was rebuilt since: this transcript no longer matches its reference
                    ext = r.extraction
                    cache[(cfg.stt_engine_id, r.case_id)] = SttResult(
                        text=r.transcript_hyp, audio_ms=(ext.audio_ms if ext else None) or 0.0,
                        stt_ms=(ext.stt_ms if ext else None) or 0.0)
                    kept += 1
                if not kept:
                    notes.append(f"Skipped {cfg.key}: no stored transcripts match the current dataset.")
                    continue
                m = metrics_by_key.get(cfg.key)
                stats[cfg.stt_engine_id] = {"load_ms": (m.cold_start_ms if m else None) or 0.0,
                                            "peak_mb": (m.peak_rss_mb if m else None) or 0.0,
                                            "size_mb": (m.model_size_mb if m else None) or 0.0}
            configs.append(cfg)
        if not configs:
            raise ValueError(f"nothing to rescore in run {source_run_id}: " + " ".join(notes[1:]))
        req = src.request.model_copy(update={"configs": configs, "repeats": 1, "warmup": 0,
                                             "label": label or f"{src.label or src.run_id}-rescored"})
        return self.run(req, run_id=run_id, progress=progress, cancelled=cancelled,
                        replay=Replay(stt_cache=cache, stt_stats=stats, hardware=src.hardware, notes=notes))

    # ------------------------------------------------------------------------------------------------------------
    def _run_config(self, ds: Dataset, cases: list[EvalCase], cfg: RunConfig, req: RunRequest,
                    stt_cache: dict, stt_stats: dict, stt_errors: dict, cancelled: Callable[[], bool],
                    tick: Callable[[int], None]):
        strategy = get_strategy(cfg.strategy_id)
        real_stt = cfg.stt_engine_id != ORACLE_STT_ID
        uses_llm = strategy.uses_llm and cfg.llm_engine_id != NO_LLM_ID
        records: list[CaseRecord] = []
        cold = stt_stats.get(cfg.stt_engine_id, {}).get("load_ms", 0.0) if real_stt else 0.0
        size = stt_stats.get(cfg.stt_engine_id, {}).get("size_mb", 0.0) if real_stt else 0.0
        stt_peak = stt_stats.get(cfg.stt_engine_id, {}).get("peak_mb", 0.0) if real_stt else 0.0
        llm_peak = 0.0
        llm = None
        error: str | None = stt_errors.get(cfg.stt_engine_id) if real_stt else None

        self.reg.unload_all()
        if error is None and strategy.uses_llm and cfg.llm_engine_id == NO_LLM_ID and cfg.strategy_id != "rules_only":
            error = f"strategy {cfg.strategy_id} needs an LLM engine"
        try:
            with RssSampler() as rs:
                if error is None and uses_llm:
                    try:
                        cold += self.reg.prepare(cfg.llm_engine_id)
                        llm = self.reg.get_llm(cfg.llm_engine_id)
                        size += llm.info().size_mb or 0.0
                    except Exception as exc:
                        error = f"LLM engine unavailable: {exc}"
                if error is None:
                    self._warmup(ds, cases, cfg, req, llm, stt_cache)
                    n = 0
                    for rep in range(max(1, req.repeats)):
                        for case in cases:
                            if cancelled():
                                raise RunCancelled()
                            rec = self._run_case(ds, case, cfg, req, llm, stt_cache, rep, real_stt)
                            if rec is not None:
                                records.append(rec)
                            n += 1
                            if n % 5 == 0:
                                tick(n)
                llm_peak = rs.delta_mb
        finally:
            self.reg.unload_all()

        if error is not None:
            log.warning("config %s skipped: %s", cfg.key, error)
            m = aggregate(cfg, [], cold_start_ms=None, peak_rss_mb=None, model_size_mb=None)
            m.n_cases, m.n_errors = len(cases), len(cases)
            return m, []
        metrics = aggregate(cfg, records, cold_start_ms=cold or None, peak_rss_mb=(stt_peak + llm_peak) or None,
                            model_size_mb=size or None)
        return metrics, [to_case_result(cfg, r) for r in records if r.repeat == 0]

    def _warmup(self, ds: Dataset, cases: list[EvalCase], cfg: RunConfig, req: RunRequest, llm, stt_cache: dict) -> None:
        for case in cases[: max(0, req.warmup)]:
            try:
                self._run_case(ds, case, cfg, req, llm, stt_cache, repeat=0, real_stt=cfg.stt_engine_id != ORACLE_STT_ID)
            except RunCancelled:
                raise
            except Exception:
                pass

    def _run_case(self, ds: Dataset, case: EvalCase, cfg: RunConfig, req: RunRequest, llm, stt_cache: dict, repeat: int,
                  real_stt: bool) -> CaseRecord | None:
        stt_ms = audio_ms = None
        if real_stt:
            res = stt_cache.get((cfg.stt_engine_id, case.id))
            if res is None:
                return None  # no audio for this case
            transcript = res.text  # type: ignore[attr-defined]
            stt_ms, audio_ms = res.stt_ms, res.audio_ms  # type: ignore[attr-defined]
        else:
            transcript = case.written_text
        form = ds.form(case.form_id)
        inp = PipelineInput(transcript=transcript, form=form, assets=ds.assets_for(case))
        ext = self.pipeline.run(inp, cfg.strategy_id, llm)
        if real_stt and stt_ms is not None:
            ext.timings.insert(0, StageTiming(stage="stt", ms=stt_ms, detail={"audio_ms": audio_ms}))
            ext.total_ms += stt_ms
            ext.stt_ms, ext.audio_ms, ext.stt_engine_id = stt_ms, audio_ms, cfg.stt_engine_id
        sc: CaseScore = score_case(case, form, ext, req.confidence_threshold)
        return CaseRecord(
            case=case, score=sc, ext=ext, hyp=transcript, stt_ms=stt_ms, audio_ms=audio_ms,
            wer_raw=wer(case.spoken_text, transcript) if real_stt else None,
            wer_norm=wer_normalized(case.spoken_text, transcript) if real_stt else None,
            id_match=id_exact_match(case.spoken_text, transcript) if real_stt else None,
            ok=ext.error is None, repeat=repeat,
        )

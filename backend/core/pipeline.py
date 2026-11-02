"""Voice-to-form extraction pipeline.

Stages (hybrid): normalize -> resolve (closed world, lexicon) -> [LLM on what is left, only if unexplained words
remain] -> validate. Baseline strategies skip the deterministic stages so the harness can show what each one buys.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from backend.config import get_settings
from backend.core.formpack import FormPack, get_formpack
from backend.core.normalize import normalize
from backend.core.prompts import PRESENCE_PROMPTS, build_baseline_prompt, build_patch_prompt, parse_json_object
from backend.core.resolver import FILLED_THRESHOLD, ResolveOutcome, resolve
from backend.core.timing import EventFn, StageTimer
from backend.core.validate import validate
from backend.core.world import ClosedWorld
from backend.engines.base import LlmEngine, LlmResult
from backend.schemas.engines import (
    STRATEGY_ENUM_GRAMMAR,
    STRATEGY_FREE_JSON,
    STRATEGY_HYBRID,
    STRATEGY_HYBRID_ALWAYS,
    STRATEGY_RULES_ONLY,
    STRATEGY_SCHEMA_CONSTRAINED,
)
from backend.schemas.extraction import (
    ExtractionResult,
    FieldSource,
    FieldStatus,
    FieldValue,
    Scalar,
)
from backend.schemas.forms import FieldSpec, FieldType, FormSchema
from backend.schemas.reference import Asset

log = logging.getLogger(__name__)

LLM_SUGGESTION_CONFIDENCE = 0.7  # hybrid: model suggestions are shown for confirmation, never as settled facts
UNVERIFIED_LLM_CONFIDENCE = 0.9  # baselines: values are accepted as-is (this is what makes them risky)


@dataclass
class PipelineInput:
    transcript: str
    form: FormSchema
    assets: list[Asset] = field(default_factory=list)
    prefill: dict[str, Scalar] = field(default_factory=dict)


class ExtractionPipeline:
    def run(
        self,
        inp: PipelineInput,
        strategy_id: str,
        llm: LlmEngine | None = None,
        on_event: EventFn | None = None,
    ) -> ExtractionResult:
        timer = StageTimer(on_event)
        res = ExtractionResult(strategy_id=strategy_id, transcript_raw=inp.transcript)
        if llm is not None:
            res.llm_engine_id = llm.info().id
        pack = get_formpack(inp.form)
        world = ClosedWorld.from_assets(inp.assets)
        try:
            if strategy_id in (STRATEGY_FREE_JSON, STRATEGY_SCHEMA_CONSTRAINED):
                self._baseline(inp, pack, strategy_id, llm, timer, res)
            elif strategy_id == STRATEGY_ENUM_GRAMMAR:
                self._enum_grammar(inp, pack, llm, timer, res)
            elif strategy_id in (STRATEGY_HYBRID, STRATEGY_HYBRID_ALWAYS, STRATEGY_RULES_ONLY):
                self._hybrid(inp, pack, world, strategy_id, llm, timer, res)
            else:
                raise ValueError(f"unknown strategy {strategy_id!r}")
        except Exception as exc:  # the pipeline never raises to the UI; it reports and leaves fields empty
            log.exception("extraction failed")
            res.error = f"{type(exc).__name__}: {exc}"
        for spec in inp.form.fields:
            res.fields.setdefault(spec.key, FieldValue(key=spec.key))
        res.timings = timer.timings
        res.total_ms = timer.total_ms
        timer.emit({"type": "fields", "stage": "validate", "fields": {k: v.model_dump(mode="json") for k, v in res.fields.items()},
                    "unresolved": res.unresolved})
        return res

    # ---- strategies ------------------------------------------------------------------------------------------
    def _hybrid(self, inp: PipelineInput, pack: FormPack, world: ClosedWorld, strategy_id: str,
                llm: LlmEngine | None, timer: StageTimer, res: ExtractionResult) -> None:
        with timer.stage("normalize"):
            norm = normalize(inp.transcript, set(pack.id_trigger_words))
        res.transcript_normalized = norm.text
        with timer.stage("resolve") as detail:
            out = resolve(norm, pack, world, inp.prefill)
            detail["residual"] = len(out.residual)
        res.fields = out.fields
        res.unresolved = list(out.unresolved)
        timer.emit({"type": "fields", "stage": "resolve",
                    "fields": {k: v.model_dump(mode="json") for k, v in res.fields.items()},
                    "unresolved": res.unresolved})

        stems = {t.stem for t in norm.tokens if t.kind == "word"}
        keys = self._llm_keys(pack, out, always=strategy_id == STRATEGY_HYBRID_ALWAYS, stems=stems)
        if strategy_id != STRATEGY_RULES_ONLY and llm is not None and keys:
            cands = {k: out.candidates.get(k, []) for k in keys if pack.form.field(k).type == FieldType.ENTITY_REF}
            with timer.stage("llm") as detail:
                detail.update(self._llm_patch(norm.text, pack, keys, cands, llm, res, FieldSource.LLM,
                                              LLM_SUGGESTION_CONFIDENCE, status_override=FieldStatus.NEEDS_REVIEW,
                                              guard_absence=True, variant=get_settings().patch_prompt))
                detail["fields_asked"] = len(keys)
            res.unresolved = [k for k in res.unresolved if res.fields[k].status == FieldStatus.MISSING]
            timer.emit({"type": "fields", "stage": "llm",
                        "fields": {k: v.model_dump(mode="json") for k, v in res.fields.items()},
                        "unresolved": res.unresolved})
        with timer.stage("validate"):
            res.warnings.extend(validate(res.fields, inp.form, world))

    def _enum_grammar(self, inp: PipelineInput, pack: FormPack, llm: LlmEngine | None, timer: StageTimer,
                      res: ExtractionResult) -> None:
        if llm is None:
            raise ValueError("strategy requires an LLM engine")
        with timer.stage("normalize"):
            norm = normalize(inp.transcript, set(pack.id_trigger_words))
        res.transcript_normalized = norm.text
        keys = [f.key for f in pack.form.fields if f.type != FieldType.TEXT]
        heard = [t.value or t.text for t in norm.tokens if t.kind in ("num", "id") and "." not in (t.value or t.text)]
        cands = {k: list(dict.fromkeys(h.upper() for h in heard)) for k in keys
                 if pack.form.field(k).type == FieldType.ENTITY_REF}
        res.fields = {f.key: FieldValue(key=f.key) for f in pack.form.fields}
        with timer.stage("llm") as detail:
            detail.update(self._llm_patch(norm.text, pack, keys, cands, llm, res, FieldSource.LLM,
                                          UNVERIFIED_LLM_CONFIDENCE, status_override=None))
            detail["fields_asked"] = len(keys)
        for spec in pack.form.fields:
            if spec.type == FieldType.TEXT and spec.fill_from_transcript and norm.clean:
                res.fields[spec.key] = FieldValue(key=spec.key, value=norm.clean[: spec.max_length or 400],
                                                  source=FieldSource.RULE, confidence=0.9, status=FieldStatus.FILLED)

    def _baseline(self, inp: PipelineInput, pack: FormPack, strategy_id: str, llm: LlmEngine | None,
                  timer: StageTimer, res: ExtractionResult) -> None:
        if llm is None:
            raise ValueError("strategy requires an LLM engine")
        system, user = build_baseline_prompt(inp.transcript, pack)
        fmt = {"type": "json_schema", "json_schema": pack.json_schema()} if strategy_id == STRATEGY_SCHEMA_CONSTRAINED else None
        with timer.stage("llm") as detail:
            result = self._complete(llm, system, user, [fmt] if fmt else [None], max_tokens=260)
            self._account(result, res)
            obj = parse_json_object(result.text)
            detail.update({"valid": obj is not None, "prompt_tokens": result.prompt_tokens,
                           "output_tokens": result.output_tokens, "fields_asked": len(pack.form.keys)})
        res.transcript_normalized = inp.transcript
        res.fields = {f.key: FieldValue(key=f.key) for f in pack.form.fields}
        if obj is None:
            res.warnings.append("LLM output was not valid JSON")
            return
        for spec in pack.form.fields:
            if spec.key in obj and obj[spec.key] is not None:
                fv = _coerce(spec, obj[spec.key], loose=True)
                if fv is not None:
                    fv.source, fv.confidence, fv.status = FieldSource.LLM, UNVERIFIED_LLM_CONFIDENCE, FieldStatus.FILLED
                    res.fields[spec.key] = fv

    # ---- LLM helpers -----------------------------------------------------------------------------------------
    @staticmethod
    def _llm_keys(pack: FormPack, out: ResolveOutcome, always: bool, stems: set[str] | None = None) -> list[str]:
        keys: list[str] = []
        for key in out.unresolved:
            spec = pack.form.field(key)
            if spec.type == FieldType.ENUM:
                if out.residual or always:
                    keys.append(key)
            elif spec.type == FieldType.BOOLEAN:
                topic = pack.topic_stems.get(key)
                if (out.residual or always) and (not topic or stems is None or topic & stems):
                    keys.append(key)  # only when the statement touches the field's topic at all
            elif spec.type == FieldType.ENTITY_REF:
                if out.candidates.get(key) and (out.residual or always or _has_free_candidates(out)):
                    keys.append(key)
        return keys

    def _llm_patch(self, statement: str, pack: FormPack, keys: list[str], cands: dict[str, list[str]], llm: LlmEngine,
                   res: ExtractionResult, source: FieldSource, confidence: float,
                   status_override: FieldStatus | None, guard_absence: bool = False,
                   variant: str = "v0") -> dict[str, Any]:
        presence = variant in PRESENCE_PROMPTS
        system, user = build_patch_prompt(statement, pack, keys, cands, variant=variant)
        formats: list[dict | None] = [
            {"type": "lark_grammar", "lark_grammar": pack.lark_grammar(keys, cands, presence=presence)},
            {"type": "json_schema", "json_schema": pack.json_schema(keys, presence=presence)},
            None,
        ]
        max_tokens = min(220, (22 if presence else 14) * len(keys) + 12)
        result = self._complete(llm, system, user, formats, max_tokens=max_tokens)
        self._account(result, res)
        obj = parse_json_object(result.text)
        detail = {"valid": obj is not None, "prompt_tokens": result.prompt_tokens, "output_tokens": result.output_tokens,
                  "llm_ms": round(result.total_ms, 2)}
        if obj is None:
            res.warnings.append("LLM output was not valid JSON")
            return detail
        for key in keys:
            spec = pack.form.field(key)
            raw = obj.get(key)
            if presence and spec.type == FieldType.ENUM and isinstance(raw, dict):
                # {"mentioned": true, "value": "oil_leak"}; a value for a field the statement does not mention is dropped
                raw = raw.get("value") if raw.get("mentioned") is True else None
            if raw is None:
                continue
            fv = _coerce(spec, raw, loose=False, candidates=cands.get(key))
            if fv is None:
                continue
            if guard_absence and fv.value == pack.none_code.get(key) and not pack.absence_supported(statement):
                continue  # "none" with nothing said about it is the model's way of shrugging, not a finding
            fv.source, fv.confidence = source, confidence
            fv.status = status_override or (FieldStatus.FILLED if confidence >= FILLED_THRESHOLD else FieldStatus.NEEDS_REVIEW)
            if status_override == FieldStatus.NEEDS_REVIEW:
                fv.note = "AI suggestion - please confirm"
            res.fields[key] = fv
        return detail

    @staticmethod
    def _complete(llm: LlmEngine, system: str, user: str, formats: list[dict | None], max_tokens: int) -> LlmResult:
        last: Exception | None = None
        for fmt in formats:
            try:
                return llm.complete(system, user, response_format=fmt, max_tokens=max_tokens, temperature=0.0)
            except Exception as exc:  # grammar rejected by the runtime -> try the next, looser format
                last = exc
                log.warning("LLM call failed with %s format: %s", (fmt or {}).get("type", "none"), exc)
        raise RuntimeError(f"LLM call failed: {last}")

    @staticmethod
    def _account(result: LlmResult, res: ExtractionResult) -> None:
        res.llm_prompt_tokens = (res.llm_prompt_tokens or 0) + (result.prompt_tokens or 0)
        res.llm_output_tokens = (res.llm_output_tokens or 0) + (result.output_tokens or 0)


def _has_free_candidates(out: ResolveOutcome) -> bool:
    used = {str(f.value).upper() for f in out.fields.values() if f.source == FieldSource.RULE and f.value is not None}
    return any(c not in used for c in out.all_candidates)


def _coerce(spec: FieldSpec, raw: Any, loose: bool, candidates: list[str] | None = None) -> FieldValue | None:
    """Convert an LLM value into a FieldValue; returns None when it is not acceptable for the field."""
    try:
        if spec.type == FieldType.ENUM:
            codes = {o.code for o in spec.options}
            s = str(raw).strip()
            if s in codes:
                return FieldValue(key=spec.key, value=s)
            if loose:  # baseline tolerance: match by label / case-insensitive code
                low = s.lower().replace(" ", "_")
                for o in spec.options:
                    if low == o.code.lower() or s.lower() == o.label.lower():
                        return FieldValue(key=spec.key, value=o.code)
            return None
        if spec.type == FieldType.ENTITY_REF:
            s = str(raw).strip().upper()
            if not s:
                return None
            if candidates is not None and s not in {c.upper() for c in candidates}:
                return None
            return FieldValue(key=spec.key, value=s)
        if spec.type == FieldType.NUMBER:
            return FieldValue(key=spec.key, value=float(raw))
        if spec.type == FieldType.BOOLEAN:
            if isinstance(raw, bool):
                return FieldValue(key=spec.key, value=raw)
            s = str(raw).strip().lower()
            if s in ("true", "yes"):
                return FieldValue(key=spec.key, value=True)
            if s in ("false", "no"):
                return FieldValue(key=spec.key, value=False)
            return None
        s = str(raw).strip()
        return FieldValue(key=spec.key, value=s[: spec.max_length or 400]) if s else None
    except (TypeError, ValueError):
        return None


def timed(fn, *args, **kwargs) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn(*args, **kwargs)
    return out, (time.perf_counter() - t0) * 1000.0

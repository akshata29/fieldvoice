"""Metrics: speech (WER, identifier match) and extraction (field accuracy, silent-wrong rate, review burden, latency)."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import numpy as np

from backend.core.normalize import normalize
from backend.schemas.eval import CaseResult, ConfigMetrics, EvalCase, LatencyStats, RunConfig
from backend.schemas.extraction import ExtractionResult, FieldStatus, Scalar
from backend.schemas.forms import FieldSpec, FieldType, FormSchema

_WORD = re.compile(r"[a-z0-9']+")


# ---- speech ---------------------------------------------------------------------------------------------------
def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def edit_distance(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[-1]


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = _words(reference), _words(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def wer_normalized(reference_spoken: str, hypothesis: str) -> float:
    """WER after number/format normalization, so "pole 1 2 3" vs "pole 123" vs "pole one two three" are not errors."""
    return wer(normalize(reference_spoken).text, normalize(hypothesis).text)


def id_exact_match(reference_spoken: str, hypothesis: str) -> float | None:
    """Share of identifiers/numbers in the reference that appear (as multiset) in the normalized hypothesis."""
    ref = Counter(t.value for t in normalize(reference_spoken).tokens if t.kind in ("num", "id") and t.value)
    if not ref:
        return None
    hyp = Counter(t.value for t in normalize(hypothesis).tokens if t.kind in ("num", "id") and t.value)
    hit = sum(min(c, hyp.get(k, 0)) for k, c in ref.items())
    return hit / sum(ref.values())


# ---- extraction -----------------------------------------------------------------------------------------------
def _norm(spec: FieldSpec, v: Scalar) -> Scalar:
    if v is None:
        return None
    if spec.type == FieldType.ENTITY_REF:
        return str(v).strip().upper()
    if spec.type == FieldType.NUMBER:
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
    if spec.type == FieldType.BOOLEAN:
        return v if isinstance(v, bool) else str(v).strip().lower() in ("true", "yes", "1")
    return str(v).strip()


def values_equal(spec: FieldSpec, expected: Scalar, got: Scalar) -> bool:
    e, g = _norm(spec, expected), _norm(spec, got)
    if e is None or g is None:
        return e is None and g is None
    if spec.type == FieldType.NUMBER:
        return abs(float(e) - float(g)) <= max(1e-6, 1e-4 * abs(float(e)))
    if spec.type == FieldType.TEXT:
        a, b = set(_words(str(e))), set(_words(str(g)))
        return bool(a) and len(a & b) / len(a | b) >= 0.6
    return e == g


@dataclass
class CaseScore:
    field_correct: dict[str, bool] = field(default_factory=dict)
    types: dict[str, str] = field(default_factory=dict)
    scored: int = 0
    correct: int = 0
    confident: int = 0
    silent_wrong: int = 0
    flagged: int = 0
    safe: int = 0
    expected_empty: int = 0
    hallucinated: int = 0
    id_scored: int = 0
    id_correct: int = 0
    by_type: dict[str, list[int]] = field(default_factory=lambda: defaultdict(lambda: [0, 0]))  # type -> [correct, scored]


def score_case(case: EvalCase, form: FormSchema, ext: ExtractionResult | None, tau: float = 0.8) -> CaseScore:
    sc = CaseScore()
    for spec in form.fields:
        expected = case.expected.get(spec.key)
        if spec.type == FieldType.TEXT and expected is None:
            continue  # free text is only scored when ground truth exists
        fv = ext.fields.get(spec.key) if ext else None
        status = fv.status if fv else FieldStatus.MISSING
        got = _norm(spec, fv.value) if fv and status != FieldStatus.MISSING else None
        ok = values_equal(spec, expected, got)
        confident = got is not None and status == FieldStatus.FILLED and (fv.confidence >= tau if fv else False)
        flagged = status in (FieldStatus.NEEDS_REVIEW, FieldStatus.CONFLICT)
        sc.field_correct[spec.key] = ok
        sc.types[spec.key] = spec.type.value
        sc.scored += 1
        sc.correct += int(ok)
        sc.confident += int(confident)
        sc.silent_wrong += int(confident and not ok)
        sc.flagged += int(flagged)
        sc.safe += int(ok or flagged)
        if _norm(spec, expected) is None:
            sc.expected_empty += 1
            sc.hallucinated += int(got is not None)
        if spec.type == FieldType.ENTITY_REF:
            sc.id_scored += 1
            sc.id_correct += int(ok)
        t = sc.by_type[spec.type.value]
        t[0] += int(ok)
        t[1] += 1
    return sc


def percentiles(values: list[float]) -> LatencyStats:
    if not values:
        return LatencyStats()
    a = np.asarray(values, dtype=float)
    return LatencyStats(n=len(a), mean=float(a.mean()), p50=float(np.percentile(a, 50)),
                        p95=float(np.percentile(a, 95)), max=float(a.max()))


@dataclass
class CaseRecord:
    """Everything the aggregator needs about one executed case (kept separate from the persisted CaseResult)."""

    case: EvalCase
    score: CaseScore
    ext: ExtractionResult | None
    hyp: str
    stt_ms: float | None
    audio_ms: float | None
    wer_raw: float | None
    wer_norm: float | None
    id_match: float | None
    ok: bool
    repeat: int = 0


def aggregate(config: RunConfig, records: list[CaseRecord], *, cold_start_ms: float | None, peak_rss_mb: float | None,
              model_size_mb: float | None) -> ConfigMetrics:
    first = [r for r in records if r.repeat == 0]
    m = ConfigMetrics(config_key=config.key, config=config, n_cases=len(first), n_errors=sum(1 for r in first if not r.ok))
    tot = defaultdict(int)
    by_type: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    tag_acc: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    form_exact = 0
    for r in first:
        s = r.score
        for k in ("scored", "correct", "confident", "silent_wrong", "flagged", "safe", "expected_empty", "hallucinated",
                  "id_scored", "id_correct"):
            tot[k] += getattr(s, k)
        for t, (c, n) in s.by_type.items():
            by_type[t][0] += c
            by_type[t][1] += n
        form_exact += int(s.scored > 0 and s.correct == s.scored)
        for tag in r.case.tags:
            tag_acc[tag][0] += s.correct
            tag_acc[tag][1] += s.scored
    m.field_accuracy = tot["correct"] / tot["scored"] if tot["scored"] else 0.0
    m.id_field_accuracy = tot["id_correct"] / tot["id_scored"] if tot["id_scored"] else None
    m.accuracy_by_type = {t: c / n for t, (c, n) in by_type.items() if n}
    m.accuracy_by_tag = {t: c / n for t, (c, n) in tag_acc.items() if n}
    m.form_exact_match = form_exact / len(first) if first else 0.0
    m.silent_wrong_rate = tot["silent_wrong"] / tot["confident"] if tot["confident"] else 0.0
    m.hallucination_rate = tot["hallucinated"] / tot["expected_empty"] if tot["expected_empty"] else None
    m.review_rate = tot["flagged"] / tot["scored"] if tot["scored"] else 0.0
    m.safe_outcome_rate = tot["safe"] / tot["scored"] if tot["scored"] else 0.0

    raw = [r.wer_raw for r in first if r.wer_raw is not None]
    norm = [r.wer_norm for r in first if r.wer_norm is not None]
    ids = [r.id_match for r in first if r.id_match is not None]
    m.wer = float(np.mean(raw)) if raw else None
    m.wer_normalized = float(np.mean(norm)) if norm else None
    m.id_exact_match = float(np.mean(ids)) if ids else None
    stt_ms = sum(r.stt_ms or 0.0 for r in first)
    audio_ms = sum(r.audio_ms or 0.0 for r in first if r.stt_ms is not None)
    m.rtf = stt_ms / audio_ms if audio_ms else None

    ok = [r for r in records if r.ok and r.ext is not None]
    m.latency_stt = percentiles([r.stt_ms for r in ok if r.stt_ms is not None])
    m.latency_extract = percentiles([r.ext.total_ms - (r.stt_ms or 0.0) for r in ok])  # type: ignore[union-attr]
    m.latency_total = percentiles([r.ext.total_ms for r in ok])  # type: ignore[union-attr]  # includes STT when real
    llm_ms: list[float] = []
    prompt_t: list[float] = []
    out_t: list[float] = []
    valid = n_llm = 0
    for r in ok:
        ext = r.ext
        assert ext is not None
        for t in ext.timings:
            if t.stage == "llm":
                llm_ms.append(t.ms)
                n_llm += 1
                valid += int(bool(t.detail.get("valid", True)))
        if ext.llm_prompt_tokens is not None:
            prompt_t.append(ext.llm_prompt_tokens)
        if ext.llm_output_tokens is not None:
            out_t.append(ext.llm_output_tokens)
    m.latency_llm = percentiles(llm_ms)
    m.llm_prompt_tokens_mean = float(np.mean(prompt_t)) if prompt_t else None
    m.llm_output_tokens_mean = float(np.mean(out_t)) if out_t else None
    m.schema_valid_rate = valid / n_llm if n_llm else None
    m.cold_start_ms = cold_start_ms
    m.peak_rss_mb = peak_rss_mb
    m.model_size_mb = model_size_mb
    return m


def to_case_result(config: RunConfig, rec: CaseRecord) -> CaseResult:
    return CaseResult(
        case_id=rec.case.id, config_key=config.key, ok=rec.ok, error=rec.ext.error if rec.ext else "no result",
        tags=rec.case.tags, transcript_hyp=rec.hyp, wer=rec.wer_norm, expected=rec.case.expected,
        field_correct=rec.score.field_correct, extraction=rec.ext,
    )

"""Deterministic resolution of form fields from a normalized transcript.

Closed-world entity resolution (ids are validated against the job's assets and the truck inventory), enum matching
against the form's lexicon with negation handling, number/boolean matching by unit and label triggers, spoken
corrections ("pole 123, sorry, 132"). Everything here is microseconds; the LLM only sees what is left.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from backend.core.formpack import (
    CORRECTION_CUES,
    NEGATORS,
    STOP_STEMS,
    FormPack,
    PhraseMatch,
    find_phrase,
    is_negated,
)
from backend.core.normalize import NormalizedText
from backend.core.world import ClosedWorld
from backend.schemas.extraction import FieldSource, FieldStatus, FieldValue, Scalar
from backend.schemas.forms import FieldSpec, FieldType

log = logging.getLogger(__name__)

FILLED_THRESHOLD = 0.8


@dataclass
class IdCandidate:
    idx: int  # token index
    value: str  # canonical id (upper-case)
    decimal: bool = False
    negated: bool = False
    superseded: bool = False
    claimed_by: str | None = None  # NUMBER field key that consumed it
    scores: dict[str, float] = field(default_factory=dict)
    trigger_span: dict[str, tuple[int, int]] = field(default_factory=dict)


@dataclass
class ResolveOutcome:
    fields: dict[str, FieldValue]
    unresolved: list[str]  # MISSING enum/boolean/entity/number fields (LLM-eligible)
    candidates: dict[str, list[str]]  # entity field key -> ids heard in the transcript (for constrained decoding)
    all_candidates: list[str]
    residual: list[str]  # content words nothing explained
    covered: set[int] = field(default_factory=set)


def _status_for(conf: float) -> FieldStatus:
    return FieldStatus.FILLED if conf >= FILLED_THRESHOLD else FieldStatus.NEEDS_REVIEW


def resolve(
    norm: NormalizedText,
    pack: FormPack,
    world: ClosedWorld,
    prefill: dict[str, Scalar] | None = None,
) -> ResolveOutcome:
    return _Resolver(norm, pack, world, prefill or {}).run()


class _Resolver:
    def __init__(self, norm: NormalizedText, pack: FormPack, world: ClosedWorld, prefill: dict[str, Scalar]) -> None:
        self.n = norm
        self.t = norm.tokens
        self.pack = pack
        self.form = pack.form
        self.world = world
        self.prefill = prefill
        self.fields: dict[str, FieldValue] = {f.key: FieldValue(key=f.key) for f in pack.form.fields}
        self.covered: set[int] = set()
        self.cands: list[IdCandidate] = []

    # ------------------------------------------------------------------------------------------------------------
    def run(self) -> ResolveOutcome:
        self._extract_candidates()
        self._resolve_numbers()
        self._resolve_entities()
        self._resolve_enums()
        self._resolve_booleans()
        self._resolve_text()
        self._apply_prefill()
        unresolved = [
            f.key for f in self.form.fields
            if f.type != FieldType.TEXT and self.fields[f.key].status == FieldStatus.MISSING
        ]
        heard = [c.value for c in self.cands if not c.negated and not c.superseded and not c.decimal and c.claimed_by is None]
        heard = list(dict.fromkeys(heard))
        # an id already assigned to one entity field is not a candidate for another (pole 123 is not "the old unit")
        used = {str(self.fields[f.key].value).upper() for f in self.form.fields
                if f.type == FieldType.ENTITY_REF and self.fields[f.key].value is not None}
        free = [h for h in heard if h not in used]
        cand_by_field: dict[str, list[str]] = {}
        for f in self.form.fields:
            if f.type == FieldType.ENTITY_REF:
                cand_by_field[f.key] = free if self.fields[f.key].status == FieldStatus.MISSING else list(heard)
        residual = [
            tok.text for i, tok in enumerate(self.t)
            if tok.kind == "word" and i not in self.covered and tok.stem not in self.pack.structural_stems
            and tok.stem not in STOP_STEMS and len(tok.text) > 2
        ]
        return ResolveOutcome(self.fields, unresolved, cand_by_field, list(heard), residual, self.covered)

    # ---- candidates -------------------------------------------------------------------------------------------
    def _extract_candidates(self) -> None:
        for i, tok in enumerate(self.t):
            if tok.kind not in ("num", "id"):
                continue
            val = (tok.value or tok.text).upper()
            c = IdCandidate(idx=i, value=val, decimal="." in val)
            prev = self._prev_word(i)
            if prev in NEGATORS:
                c.negated = True
            self.cands.append(c)

    def _prev_word(self, i: int) -> str:
        j = i - 1
        while j >= 0 and self.t[j].kind == "punct" and self.t[j].text not in ".!?;":
            j -= 1
        if j >= 0 and self.t[j].kind == "word":
            return self.t[j].text
        return ""

    # ---- numbers ----------------------------------------------------------------------------------------------
    def _resolve_numbers(self) -> None:
        for spec in self.form.fields:
            if spec.type != FieldType.NUMBER:
                continue
            best: tuple[float, IdCandidate, tuple[int, int]] | None = None
            for c in self.cands:
                if c.negated or c.claimed_by:
                    continue
                score = 0.0
                span = (c.idx, c.idx)
                for ph in self.pack.unit_patterns.get(spec.key, []):
                    for m in find_phrase(self.t, ph, max_gap=0, lo=c.idx + 1, hi=min(len(self.t) - 1, c.idx + 3)):
                        if m.first - c.idx <= 2:
                            score = max(score, 0.9)
                            span = (c.idx, m.last)
                for ph in self.pack.label_patterns.get(spec.key, []):
                    for m in find_phrase(self.t, ph, max_gap=1, lo=max(0, c.idx - 5), hi=c.idx - 1):
                        if c.idx - m.last <= 3:
                            score = max(score, 0.85)
                            span = (min(span[0], m.first), max(span[1], c.idx))
                if score > 0 and (best is None or score > best[0]):
                    best = (score, c, span)
            if best is None:
                continue
            score, c, span = best
            try:
                value = float(c.value)
            except ValueError:
                continue
            c.claimed_by = spec.key
            self.covered.update(range(span[0], span[1] + 1))
            conf = 0.92 if score >= 0.9 else 0.85
            note = None
            if (spec.min_value is not None and value < spec.min_value) or (
                    spec.max_value is not None and value > spec.max_value):
                conf, note = 0.5, f"outside expected range {spec.min_value}-{spec.max_value}"
            self.fields[spec.key] = FieldValue(
                key=spec.key, value=value, source=FieldSource.RULE, confidence=conf, status=_status_for(conf),
                evidence=self.n.evidence(span[0], span[1]), note=note,
            )

    # ---- entities ---------------------------------------------------------------------------------------------
    def _trigger_score(self, c: IdCandidate, spec: FieldSpec) -> tuple[float, tuple[int, int] | None]:
        lo, hi = self.n.sentence_bounds(c.idx)
        best, span = 0.0, None
        for ph in self.pack.role_patterns.get(spec.key, []):
            for m in find_phrase(self.t, ph, max_gap=1, lo=max(lo, c.idx - 7), hi=c.idx - 1):
                d = sum(1 for k in range(m.last + 1, c.idx) if self.t[k].kind == "word")
                if d <= 4:
                    s = 1.0 - 0.18 * d
                    if s > best:
                        best, span = s, (m.first, c.idx)
            for m in find_phrase(self.t, ph, max_gap=0, lo=c.idx + 1, hi=min(hi, c.idx + 4)):
                d = sum(1 for k in range(c.idx + 1, m.first) if self.t[k].kind == "word")
                if d <= 2:
                    s = 0.5 - 0.1 * d
                    if s > best:
                        best, span = s, (c.idx, m.last)
        return best, span

    def _resolve_entities(self) -> None:
        specs = [f for f in self.form.fields if f.type == FieldType.ENTITY_REF]
        if not specs:
            return
        live = [c for c in self.cands if not c.decimal and not c.negated and c.claimed_by is None]
        for c in live:
            for spec in specs:
                c.scores[spec.key], span = self._trigger_score(c, spec)
                if span:
                    c.trigger_span[spec.key] = span

        # spoken corrections: "pole 123, sorry, 132" -> the later id supersedes the earlier one
        for a, b in zip(live, live[1:]):
            between = [self.t[k].text for k in range(a.idx + 1, b.idx)]
            if any(w in CORRECTION_CUES for w in between):
                best_a = max(a.scores, key=lambda k: a.scores[k], default=None)
                best_b = max(b.scores, key=lambda k: b.scores[k], default=None)
                if (b.scores.get(best_b or "", 0) < 0.45) or best_a == best_b:
                    a.superseded = True
                    self.covered.update(range(a.idx, a.idx + 1))
        live = [c for c in live if not c.superseded]

        pairs: list[tuple[float, FieldSpec, IdCandidate]] = []
        for c in live:
            for spec in specs:
                score = c.scores.get(spec.key, 0.0)
                kind_hit = self.world.contains(spec.entity_kind, c.value)
                if kind_hit:
                    score += 0.35
                elif self.world.has_kind(spec.entity_kind) and any(
                        self.world.contains(o.entity_kind, c.value) for o in specs if o.entity_kind != spec.entity_kind):
                    score -= 0.4
                if score >= 0.45 or (kind_hit and score >= 0.35):
                    pairs.append((score, spec, c))
        pairs.sort(key=lambda p: (-p[0], p[2].idx))

        assigned_f: dict[str, tuple[float, IdCandidate]] = {}
        assigned_c: set[int] = set()
        for score, spec, c in pairs:
            if spec.key in assigned_f or c.idx in assigned_c:
                continue
            assigned_f[spec.key] = (score, c)
            assigned_c.add(c.idx)

        # weak fallback: one leftover candidate and one leftover field. Only when the candidate can be validated against
        # today's assets (a stray number such as a work-order number must never be proposed as an asset id)
        left_c = [c for c in live if c.idx not in assigned_c]
        left_f = [s for s in specs if s.key not in assigned_f]
        if len(left_c) == 1 and len(left_f) == 1:
            c, spec = left_c[0], left_f[0]
            compatible = self.world.contains(spec.entity_kind, c.value) if self.world.has_kind(spec.entity_kind) else True
            if compatible:
                assigned_f[spec.key] = (0.4, c)
                assigned_c.add(c.idx)

        for spec in specs:
            if spec.key not in assigned_f:
                continue
            score, c = assigned_f[spec.key]
            trig = c.scores.get(spec.key, 0.0)
            in_world = self.world.contains(spec.entity_kind, c.value)
            known = self.world.has_kind(spec.entity_kind)
            candidates: list[str] = []
            note: str | None = None
            if known:
                if in_world:
                    conf = 0.96 if trig >= 0.6 else 0.88 if trig > 0 else 0.85  # 0.85: inferred from closed-world kind
                else:
                    conf = 0.5
                    candidates = self.world.near(spec.entity_kind, c.value)
                    note = "not in today's assets" + (f"; closest: {', '.join(candidates)}" if candidates else "")
            else:
                conf = 0.85 if trig >= 0.8 else 0.6
            # several fields of the same kind (old meter / new meter) and no role words: which is which is a guess
            twins = [s for s in specs if s.key != spec.key and s.entity_kind == spec.entity_kind]
            if in_world and twins and trig == 0 and not any(
                    t.key in assigned_f and assigned_f[t.key][1].scores.get(t.key, 0.0) > 0 for t in twins):
                conf = min(conf, 0.6)
                note = "role not stated - please confirm which is which"
            # competing candidate for the same field with a similar score -> flag
            rivals = [
                p for p in pairs
                if p[1].key == spec.key and p[2].idx != c.idx and p[0] >= score - 0.1 and p[2].idx not in assigned_c
            ]
            status = _status_for(conf)
            if rivals:
                conf = min(conf, 0.55)
                status = FieldStatus.CONFLICT
                candidates = list(dict.fromkeys([c.value] + [r[2].value for r in rivals]))
                note = "several ids match this role"
            span = c.trigger_span.get(spec.key)
            first, last = (span if span else (c.idx, c.idx))
            self.covered.update(range(min(first, c.idx), max(last, c.idx) + 1))
            self.fields[spec.key] = FieldValue(
                key=spec.key, value=c.value, source=FieldSource.RULE, confidence=conf, status=status,
                evidence=self.n.evidence(min(first, c.idx), max(last, c.idx)), note=note, candidates=candidates,
            )
        for c in self.cands:
            if c.superseded or c.negated:
                self.covered.add(c.idx)

    # ---- enums ------------------------------------------------------------------------------------------------
    def _resolve_enums(self) -> None:
        for spec in self.form.fields:
            if spec.type != FieldType.ENUM:
                continue
            found: list[tuple[PhraseMatch, str, bool]] = []  # match, code, negated
            for op in self.pack.enum_patterns.get(spec.key, []):
                for ph in op.phrases:
                    gap = 2 if len(ph.stems) > 1 else 0
                    for m in find_phrase(self.t, ph, max_gap=gap):
                        found.append((m, op.option.code, is_negated(self.t, m.first, match=m)))
            if not found:
                continue
            # keep the longest match when ranges overlap
            found.sort(key=lambda x: (-(x[0].last - x[0].first), not x[0].exact, x[0].first))
            kept: list[tuple[PhraseMatch, str, bool]] = []
            used: set[int] = set()
            for m, code, neg in found:
                rng = set(range(m.first, m.last + 1))
                if rng & used:
                    continue
                used |= rng
                kept.append((m, code, neg))
            positives = [(m, code) for m, code, neg in kept if not neg]
            negatives = [(m, code) for m, code, neg in kept if neg]
            if positives:
                by_code: dict[str, PhraseMatch] = {}
                for m, code in sorted(positives, key=lambda x: (not x[0].exact, x[0].first)):
                    by_code.setdefault(code, m)
                order = sorted(by_code.items(), key=lambda kv: (not kv[1].exact, kv[1].first))
                code, m = order[0]
                conf = 0.95 if m.exact else 0.88
                status, note, cands = _status_for(conf), None, []
                if len(order) > 1:
                    conf, status = 0.55, FieldStatus.CONFLICT
                    cands = [c for c, _ in order]
                    note = "several values mentioned"
                    for _, mm in order:
                        self.covered.update(range(mm.first, mm.last + 1))
                self.covered.update(range(m.first, m.last + 1))
                self.fields[spec.key] = FieldValue(
                    key=spec.key, value=code, source=FieldSource.RULE, confidence=conf, status=status,
                    evidence=self.n.evidence(m.first, m.last), note=note, candidates=cands,
                )
            elif negatives and spec.key in self.pack.none_code:
                m, _ = negatives[0]
                start = m.first
                j = m.first - 1
                while j >= 0 and self.t[j].kind == "word" and m.first - j <= 3:
                    if self.t[j].text in NEGATORS:
                        start = j
                        break
                    j -= 1
                self.covered.update(range(start, m.last + 1))
                self.fields[spec.key] = FieldValue(
                    key=spec.key, value=self.pack.none_code[spec.key], source=FieldSource.RULE, confidence=0.9,
                    status=FieldStatus.FILLED, evidence=self.n.evidence(start, m.last), note="negated mention",
                )

    # ---- booleans ---------------------------------------------------------------------------------------------
    def _resolve_booleans(self) -> None:
        for spec in self.form.fields:
            if spec.type != FieldType.BOOLEAN:
                continue
            hits: list[tuple[PhraseMatch, bool]] = []
            for ph in self.pack.true_patterns.get(spec.key, []):
                for m in find_phrase(self.t, ph, max_gap=2):
                    hits.append((m, is_negated(self.t, m.first, match=m)))
            if not hits:
                continue
            hits.sort(key=lambda x: (not x[0].exact, x[0].first))
            m, neg = hits[0]
            self.covered.update(range(m.first, m.last + 1))
            self.fields[spec.key] = FieldValue(
                key=spec.key, value=not neg, source=FieldSource.RULE, confidence=0.9, status=FieldStatus.FILLED,
                evidence=self.n.evidence(m.first, m.last),
                note="negated mention" if neg else None,
            )

    # ---- text / prefill ---------------------------------------------------------------------------------------
    def _resolve_text(self) -> None:
        for spec in self.form.fields:
            if spec.type == FieldType.TEXT and spec.fill_from_transcript and self.n.clean:
                text = self.n.clean[: spec.max_length or 400]
                self.fields[spec.key] = FieldValue(
                    key=spec.key, value=text, source=FieldSource.RULE, confidence=0.9, status=FieldStatus.FILLED,
                    note="transcript",
                )

    def _apply_prefill(self) -> None:
        for key, value in self.prefill.items():
            if key in self.fields and self.fields[key].status == FieldStatus.MISSING and value is not None:
                self.fields[key] = FieldValue(
                    key=key, value=value, source=FieldSource.PREFILL, confidence=1.0, status=FieldStatus.FILLED,
                    note="from work order",
                )

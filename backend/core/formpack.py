"""Form pack: a form schema compiled into matchers, vocabulary, prompts and decoding grammars.

Compiled once per (form id, version) - in production at morning-sync time - so nothing here is paid in the field.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache

from backend.core.normalize import ID_TRIGGERS, QUANTITY_UNITS, STOPWORDS, Token, stem
from backend.schemas.forms import CodeOption, FieldSpec, FieldType, FormSchema

NONE_CODES = ("none", "no_issue", "no_defect", "no_damage", "not_applicable", "n_a", "normal", "no_problem")
NEGATORS = {
    "no", "not", "without", "never", "none", "nothing", "neither", "nor", "cannot", "free", "zero",
    "isnt", "wasnt", "arent", "werent", "dont", "didnt", "doesnt", "wouldnt", "couldnt", "cant", "hasnt", "hadnt",
    "isn't", "wasn't", "aren't", "weren't", "don't", "didn't", "doesn't", "wouldn't", "couldn't", "can't", "hasn't",
    "hadn't", "wont", "won't", "unable", "failed",
}
# reassuring words that say "nothing wrong" without a negator ("looked fine", "clean as a whistle", "in great shape")
ABSENCE_CUES = {
    "fine", "good", "great", "clean", "perfect", "excellent", "healthy", "solid", "pristine", "spotless",
    "normal", "intact", "nominal",
}
CORRECTION_CUES = {"sorry", "correction", "actually", "rather", "mean", "scratch", "wait", "oops", "meant"}
# generic "work talk" stems that never indicate unexplained content
COMMON_STEMS = {stem(w) for w in (
    "replace install swap change remove pull found find check inspect complete finish done work job site arrive left "
    "leave start begin need require note notice see saw observe report fix repair restore reset close open clean test "
    "verify confirm connect disconnect energize crew truck ground area today yesterday morning afternoon completed "
    "finished crews called called request dispatch copy roger over new old existing back put took take set get got "
    "make made use used using went going go come came put replaced installed swapped changed removed pulled"
).split()}


@dataclass(frozen=True)
class Phrase:
    stems: tuple[str, ...]
    text: str


def compile_phrase(text: str) -> Phrase | None:
    words = re.findall(r"[A-Za-z0-9']+", text.lower())
    stems = tuple(stem(w) for w in words if w not in ("the", "a", "an"))
    return Phrase(stems, text) if stems else None


def _phrases(items: list[str]) -> list[Phrase]:
    out = []
    for it in items:
        p = compile_phrase(it)
        if p:
            out.append(p)
    return out


@dataclass
class PhraseMatch:
    first: int  # token index
    last: int
    exact: bool  # contiguous (no intervening words)
    phrase: Phrase


def find_phrase(tokens: list[Token], phrase: Phrase, max_gap: int = 2, lo: int = 0, hi: int | None = None) -> list[PhraseMatch]:
    """Find occurrences of ``phrase`` (stem sequence) allowing up to ``max_gap`` skipped words between its stems.

    Matching never crosses sentence-ending punctuation. Returns non-overlapping matches in text order.
    """
    hi = len(tokens) - 1 if hi is None else hi
    n = len(phrase.stems)
    matches: list[PhraseMatch] = []
    i = lo
    while i <= hi:
        t = tokens[i]
        if t.kind in ("word", "num", "id") and _tok_stem(t) == phrase.stems[0]:
            j, k, gaps, exact = i, 1, 0, True
            last = i
            j += 1
            while k < n and j <= hi:
                u = tokens[j]
                if u.kind == "punct":
                    if u.text in ".!?;":
                        break
                    j += 1
                    continue
                if _tok_stem(u) == phrase.stems[k]:
                    k += 1
                    last = j
                    j += 1
                else:
                    gaps += 1
                    exact = False
                    if gaps > max_gap:
                        break
                    j += 1
            if k == n:
                matches.append(PhraseMatch(i, last, exact, phrase))
                i = last + 1
                continue
        i += 1
    return matches


def _tok_stem(t: Token) -> str:
    return t.stem if t.kind == "word" else t.text.lower()


def is_negated(tokens: list[Token], first: int, window: int = 3, match: PhraseMatch | None = None) -> bool:
    """True if a negator appears within ``window`` word tokens before ``first`` in the same clause (commas and sentence
    ends stop the scan: "no defects, applied preservative" does not negate the preservative), or - for a gapped
    ``match`` - between the matched words ("customer was *not* notified")."""
    if match is not None and not match.exact:
        stems = set(match.phrase.stems)
        for t in tokens[match.first + 1: match.last]:
            if t.kind == "word" and t.text in NEGATORS and _tok_stem(t) not in stems:
                return True
    j = first - 1
    seen = 0
    while j >= 0 and seen < window:
        t = tokens[j]
        if t.kind == "punct":
            if t.text in ".!?;,:":
                return False
            j -= 1
            continue
        if t.kind == "word" and t.text in NEGATORS:
            return True
        seen += 1
        j -= 1
    return False


@dataclass
class OptionPatterns:
    option: CodeOption
    phrases: list[Phrase]


@dataclass
class FormPack:
    form: FormSchema
    enum_patterns: dict[str, list[OptionPatterns]] = field(default_factory=dict)
    role_patterns: dict[str, list[Phrase]] = field(default_factory=dict)
    unit_patterns: dict[str, list[Phrase]] = field(default_factory=dict)
    label_patterns: dict[str, list[Phrase]] = field(default_factory=dict)
    true_patterns: dict[str, list[Phrase]] = field(default_factory=dict)
    none_code: dict[str, str] = field(default_factory=dict)
    vocab: frozenset[str] = frozenset()
    # everything the form talks about EXCEPT the wording of its enum options (labels, role / unit / trigger phrases, generic
    # work talk). A word that only occurs in option wording ("fine", "good", "oil") and was not matched as part of an option
    # phrase is unexplained content - it opens the LLM gate; it must not count as "known vocabulary".
    structural_stems: frozenset[str] = frozenset()
    id_trigger_words: frozenset[str] = frozenset()
    unit_words: frozenset[str] = frozenset()
    # boolean field -> content stems of its trigger phrases ("customer", "notify"); a model may only be asked about the
    # field when the statement mentions at least one of them (a boolean nobody talked about is "not stated", never False)
    topic_stems: dict[str, frozenset[str]] = field(default_factory=dict)

    def absence_supported(self, statement: str) -> bool:
        """A model may only claim "none / no issues" when the statement says something negative or reassuring.

        Small models answer ``none`` for any field they were asked about and could not find: that is "not stated", and
        showing it as "No issues" would put a claim on the form that nobody made.
        """
        words = set(re.findall(r"[a-z']+", statement.lower()))
        return bool(words & (NEGATORS | ABSENCE_CUES))

    # ---- prompt / grammar builders ---------------------------------------------------------------------------------
    def field_hint(self, spec: FieldSpec, candidates: list[str] | None = None) -> str:
        if spec.type == FieldType.ENUM:
            return " | ".join([o.code for o in spec.options])
        if spec.type == FieldType.ENTITY_REF:
            ids = candidates or []
            return "one of [" + ", ".join(ids) + "] or null" if ids else "id from the statement or null"
        if spec.type == FieldType.NUMBER:
            return f"number{' (' + spec.unit + ')' if spec.unit else ''} or null"
        if spec.type == FieldType.BOOLEAN:
            return "true | false | null"
        return "short text or null"

    def lark_grammar(self, keys: list[str], candidates: dict[str, list[str]] | None = None,
                     presence: bool = False) -> str:
        """Tight Lark grammar (llguidance): fixed key order, no whitespace, enum alternatives, ``null`` allowed.

        ``presence=True`` asks every enum field as ``{"mentioned": true|false, "value": <option>}`` instead: whether the
        statement says anything about the field is a separate yes/no answer, and the value is a forced choice (no ``null``).
        """
        candidates = candidates or {}
        rules = ['start: "{" ' + ' "," '.join(f"f{i}" for i in range(len(keys))) + ' "}"']
        for i, key in enumerate(keys):
            spec = self.form.field(key)
            if presence and spec.type == FieldType.ENUM:
                rules.append(f'f{i}: ' + _lark_lit(f'"{key}":{{"mentioned":') + f" b{i} " + _lark_lit(',"value":') + f" v{i} "
                             + _lark_lit("}"))
                rules.append(f'b{i}: ' + _lark_lit("true") + " | " + _lark_lit("false"))
                rules.append(f"v{i}: " + " | ".join(_lark_lit(f'"{o.code}"') for o in spec.options))
                continue
            rules.append(f'f{i}: ' + _lark_lit(f'"{key}":') + f" v{i}")
            alts: list[str]
            if spec.type == FieldType.ENUM:
                alts = [_lark_lit(f'"{o.code}"') for o in spec.options]
            elif spec.type == FieldType.ENTITY_REF:
                alts = [_lark_lit(f'"{c}"') for c in candidates.get(key, [])]
            elif spec.type == FieldType.BOOLEAN:
                alts = [_lark_lit("true"), _lark_lit("false")]
            elif spec.type == FieldType.NUMBER:
                alts = ["/-?[0-9]{1,6}(\\.[0-9]{1,3})?/"]
            else:
                alts = ['"\\"" /[^"\\\\]{0,120}/ "\\""']
            alts.append(_lark_lit("null"))
            rules.append(f"v{i}: " + " | ".join(alts))
        return "\n".join(rules)

    def json_schema(self, keys: list[str] | None = None, presence: bool = False) -> dict:
        """JSON schema for the (sub)form. Object form (the SDK's string form failed in 2.2.1, see docs/FINDINGS.md)."""
        keys = keys or self.form.keys
        props: dict = {}
        for key in keys:
            spec = self.form.field(key)
            if spec.type == FieldType.ENUM and presence:
                props[key] = {"type": "object", "properties": {"mentioned": {"type": "boolean"},
                                                               "value": {"enum": [o.code for o in spec.options]}},
                              "required": ["mentioned", "value"], "additionalProperties": False}
            elif spec.type == FieldType.ENUM:
                props[key] = {"enum": [o.code for o in spec.options] + [None]}
            elif spec.type == FieldType.NUMBER:
                props[key] = {"type": ["number", "null"]}
            elif spec.type == FieldType.BOOLEAN:
                props[key] = {"type": ["boolean", "null"]}
            else:
                props[key] = {"type": ["string", "null"]}
        return {"type": "object", "properties": props, "required": list(keys), "additionalProperties": False}

    def form_spec_text(self, keys: list[str] | None = None, candidates: dict[str, list[str]] | None = None) -> str:
        keys = keys or self.form.keys
        lines = []
        for key in keys:
            spec = self.form.field(key)
            lines.append(f"- {key}: {self.field_hint(spec, (candidates or {}).get(key))}")
        return "\n".join(lines)


def _lark_lit(text: str) -> str:
    """Lark string literal for arbitrary text (escape backslashes and quotes)."""
    return json.dumps(text)


def _vocab_stems(*texts: str) -> set[str]:
    out: set[str] = set()
    for t in texts:
        for w in re.findall(r"[A-Za-z']+", t.lower()):
            out.add(stem(w))
    return out


@lru_cache(maxsize=256)
def _compile(form_json: str) -> FormPack:
    form = FormSchema.model_validate_json(form_json)
    pack = FormPack(form=form)
    vocab: set[str] = set()
    structural: set[str] = set()  # the vocabulary minus the wording of enum options (see FormPack.structural_stems)
    id_words: set[str] = set(ID_TRIGGERS)
    unit_words: set[str] = set(QUANTITY_UNITS)
    for f in form.fields:
        vocab |= _vocab_stems(f.label, f.key.replace("_", " "))
        structural |= _vocab_stems(f.label, f.key.replace("_", " "))
        if f.type == FieldType.ENUM:
            pats = []
            for o in f.options:
                texts = list(o.synonyms) + [o.label, o.code.replace("_", " ")]
                phrases = _phrases(texts)
                pats.append(OptionPatterns(o, phrases))
                vocab |= _vocab_stems(*texts)
                if o.code in NONE_CODES:
                    pack.none_code[f.key] = o.code
            pack.enum_patterns[f.key] = pats
        elif f.type == FieldType.ENTITY_REF:
            pack.role_patterns[f.key] = _phrases(f.role_triggers)
            for t in f.role_triggers:
                vocab |= _vocab_stems(t)
                structural |= _vocab_stems(t)
                id_words |= set(re.findall(r"[a-z]+", t.lower()))
            if f.entity_kind:
                vocab |= _vocab_stems(f.entity_kind.replace("_", " "))
                structural |= _vocab_stems(f.entity_kind.replace("_", " "))
        elif f.type == FieldType.NUMBER:
            pack.unit_patterns[f.key] = _phrases(f.unit_triggers + ([f.unit] if f.unit else []))
            pack.label_patterns[f.key] = _phrases(f.label_triggers)
            for t in f.unit_triggers + f.label_triggers + ([f.unit] if f.unit else []):
                vocab |= _vocab_stems(t)
                structural |= _vocab_stems(t)
                unit_words |= set(re.findall(r"[a-z]+", t.lower()))
        elif f.type == FieldType.BOOLEAN:
            pack.true_patterns[f.key] = _phrases(f.true_triggers)
            for t in f.true_triggers:
                vocab |= _vocab_stems(t)
                structural |= _vocab_stems(t)
            topic = _vocab_stems(f.label, *f.true_triggers)
            pack.topic_stems[f.key] = frozenset(topic)  # role/stop/generic stems are removed below, once they are known
    pack.vocab = frozenset(vocab | COMMON_STEMS)
    pack.structural_stems = frozenset(structural | COMMON_STEMS | {stem(w) for w in id_words})
    pack.id_trigger_words = frozenset(id_words)
    pack.unit_words = frozenset(unit_words)
    generic = COMMON_STEMS | STOP_STEMS | {stem(w) for w in id_words}
    pack.topic_stems = {k: frozenset(v - generic) for k, v in pack.topic_stems.items()}
    return pack


def get_formpack(form: FormSchema) -> FormPack:
    return _compile(form.model_dump_json())


def lint_form(form: FormSchema) -> list[str]:
    """Authoring warnings for a form's lexicon: single-word synonyms that are also ordinary work talk (they would
    fire on "Checked pole 123"), and phrases claimed by two options of the same field."""
    warnings: list[str] = []
    for f in form.fields:
        if f.type != FieldType.ENUM:
            continue
        seen: dict[tuple[str, ...], str] = {}
        for o in f.options:
            for text in [*o.synonyms, o.label, o.code.replace("_", " ")]:
                ph = compile_phrase(text)
                if ph is None:
                    continue
                if len(ph.stems) == 1 and ph.stems[0] in COMMON_STEMS:
                    warnings.append(f"{f.key}.{o.code}: synonym {text!r} is a generic work word and will match ordinary speech")
                other = seen.get(ph.stems)
                if other is not None and other != o.code:
                    warnings.append(f"{f.key}: {text!r} is claimed by both {other!r} and {o.code!r}")
                seen[ph.stems] = o.code
    return warnings


STOP_STEMS = frozenset(stem(w) for w in STOPWORDS)

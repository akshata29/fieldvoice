"""Utterance generator: turns the synthetic world into labelled spoken statements (``EvalCase``).

Each case carries exactly what was said (``spoken_text``, numbers as words - the TTS input and WER reference), how a good
recognizer would write it (``written_text``) and the ground truth per form field (``expected``; ``None`` = never stated).
Cases are tagged so every metric can be sliced: digits / grouped / nato (how ids are spoken), correction, negation, missing,
distractor, number, colloquial (held-out phrasing), ...
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from backend.schemas.eval import EvalCase
from backend.schemas.extraction import Scalar
from backend.schemas.reference import Asset
from backend.schemas.workorders import DemoWorld
from backend.synth import lexicon

ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
        "seventeen eighteen nineteen").split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
NATO = {"A": "alpha", "B": "bravo", "C": "charlie", "D": "delta", "E": "echo", "F": "foxtrot", "G": "golf", "H": "hotel",
        "J": "juliet", "K": "kilo", "L": "lima", "M": "mike", "N": "november", "P": "papa", "R": "romeo", "S": "sierra",
        "T": "tango", "U": "uniform", "V": "victor", "W": "whiskey", "X": "xray", "Y": "yankee", "Z": "zulu"}


def int_words(n: int) -> str:
    """Cardinal in words, 0..999999 ("twelve thousand four hundred fifty six")."""
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + (" " + ONES[n % 10] if n % 10 else "")
    if n < 1000:
        return ONES[n // 100] + " hundred" + (" " + int_words(n % 100) if n % 100 else "")
    return int_words(n // 1000) + " thousand" + (" " + int_words(n % 1000) if n % 1000 else "")


def digit_words(s: str) -> str:
    return " ".join(ONES[int(c)] for c in s)


def _pair(two: str) -> str | None:
    v = int(two)
    if v == 0:
        return None
    return "oh " + ONES[v] if v < 10 else int_words(v)


def grouped_words(digits: str) -> str | None:
    """"456" -> "four fifty six", "1234" -> "twelve thirty four"; None when the id has no natural grouped reading."""
    if len(digits) == 3:
        tail = _pair(digits[1:])
        return None if tail is None or digits[0] == "0" else f"{ONES[int(digits[0])]} {tail}"
    if len(digits) == 4:
        head, tail = _pair(digits[:2]), _pair(digits[2:])
        return None if head is None or tail is None or head.startswith("oh") else f"{head} {tail}"
    return None


def say_id(asset_id: str, rng: random.Random) -> tuple[str, str, str]:
    """(spoken, written, style tag) for an asset id."""
    if asset_id[0].isalpha():
        letter, rest = asset_id[0].upper(), asset_id[1:]
        word = NATO[letter]
        spoken = f"{word} {digit_words(rest)}" if rng.random() < 0.7 else f"{letter.lower()} as in {word} {digit_words(rest)}"
        return spoken, asset_id.upper(), "nato"
    if rng.random() < 0.45:
        g = grouped_words(asset_id)
        if g:
            return g, asset_id, "grouped"
    return digit_words(asset_id), asset_id, "digits"


@dataclass
class Utt:
    rng: random.Random
    split: str
    spoken: list[str] = field(default_factory=list)
    written: list[str] = field(default_factory=list)
    expected: dict[str, Scalar] = field(default_factory=dict)
    tags: set[str] = field(default_factory=set)
    ids: list[tuple[str, str]] = field(default_factory=list)  # (kind, id) referenced

    def t(self, text: str) -> Utt:
        self.spoken.append(text)
        self.written.append(text)
        return self

    def ident(self, key: str, asset: Asset, *, expect: bool = True) -> Utt:
        s, w, style = say_id(asset.id, self.rng)
        self.spoken.append(s)
        self.written.append(w)
        self.tags.add(style)
        self.ids.append((asset.kind, asset.id))
        if expect:
            self.expected[key] = asset.id
        return self

    def enum(self, form_id: str, key: str, code: str) -> Utt:
        """Append a phrase meaning ``code``; held-out cases mostly use colloquial phrasing the lexicon does not contain."""
        bank = lexicon.HELDOUT if self.split == "heldout" and self.rng.random() < 0.85 else lexicon.DEV
        phrases = bank[form_id][key][code]
        if bank is lexicon.HELDOUT:
            self.tags.add("colloquial")
        return self.t(self.rng.choice(phrases)).set(key, code)

    def number(self, key: str, value: float, spoken: str, written: str) -> Utt:
        self.spoken.append(spoken)
        self.written.append(written)
        self.expected[key] = value
        self.tags.add("number")
        return self

    def plain_digits(self, digits: str) -> Utt:
        """A number that is not an asset id (ticket / work-order number): words when spoken, digits when written."""
        self.spoken.append(digit_words(digits))
        self.written.append(digits)
        return self

    def set(self, key: str, value: Scalar) -> Utt:
        self.expected[key] = value
        return self

    def text(self) -> tuple[str, str]:
        def tidy(parts: list[str]) -> str:
            s = "".join(parts).strip()
            return s[:1].upper() + s[1:] if s else s

        return tidy(self.spoken), tidy(self.written)


class Pick:
    """Random choices from the world, preferring assets that have a confusable twin (near-miss id) in the world."""

    def __init__(self, world: DemoWorld, rng: random.Random) -> None:
        self.rng = rng
        self.by_kind: dict[str, list[Asset]] = {}
        for a in world.assets:
            self.by_kind.setdefault(a.kind, []).append(a)

    def one(self, kind: str, *, exclude: set[str] | None = None, status: str | None = None) -> Asset:
        pool = [a for a in self.by_kind[kind] if a.id not in (exclude or set())
                and (status is None or a.attributes.get("status") == status)]
        return self.rng.choice(pool)

    def other_like(self, a: Asset) -> Asset:
        """An asset of the same kind whose id is close to ``a`` when one exists (else any other)."""
        others = [x for x in self.by_kind[a.kind] if x.id != a.id]
        pool = [x for x in others if len(x.id) == len(a.id)] or others
        close = [x for x in pool if len(x.id) == len(a.id) and sum(p != q for p, q in zip(x.id, a.id)) <= 2]
        return self.rng.choice(close or pool)


# ---- templates ---------------------------------------------------------------------------------------------------
def _kva(u: Utt) -> None:
    v = u.rng.choice(lexicon.KVA_VALUES)
    spoken = (int_words(int(v)) if v == int(v) else f"{int_words(int(v))} point {digit_words(str(v).split('.')[1])}") + " k v a"
    u.number("kva_rating", v, spoken, f"{v:g} kVA")


def gen_transformer(p: Pick, u: Utt) -> None:
    f, r = "transformer_replacement", u.rng
    pole, new = p.one("pole"), p.one("stock_unit")
    old = next((a for a in p.by_kind["transformer"] if a.attributes.get("parent_pole") == pole.id), p.one("transformer"))
    wp = r.choices(["transformer_replacement", "transformer_repair", "transformer_removal"], [6, 2, 2])[0]
    cond = r.choice(["oil_leak", "oil_leak", "corrosion", "damage", "overheating", "none"])
    has_new = wp == "transformer_replacement"
    n = r.randrange(9) if u.split == "dev" else r.randrange(3)
    if u.split == "dev":
        if n == 8:  # the worker forgets the replacement unit (a required field)
            u.t("I ").enum(f, "work_performed", "transformer_replacement").t(" at pole ").ident("pole_id", pole).t(".")
            return
        if n == 0:
            u.t("I ").enum(f, "work_performed", wp).t(" at pole ").ident("pole_id", pole).t(". The old unit ").enum(
                f, "condition_found", cond).t(" and I installed unit ").ident("replacement_unit", new).t(".")
            has_new = True
        elif n == 1:
            u.enum(f, "work_performed", wp).t(" at pole ").ident("pole_id", pole)
            if has_new:
                u.t(", installed unit ").ident("replacement_unit", new)
            u.t(".")
        elif n == 2:
            u.t("At pole ").ident("pole_id", pole).t(" I ").enum(f, "work_performed", wp).t(". The old unit ").ident(
                "removed_unit", old).t(" ").enum(f, "condition_found", cond).t(".")
            if has_new:
                u.t(" New unit ").ident("replacement_unit", new).t(".")
        elif n == 3:
            u.t("I ").enum(f, "work_performed", wp).t(" at pole ").ident("pole_id", pole).t(" and ")
            if has_new:
                u.t("installed unit ").ident("replacement_unit", new).t(", ")
            _kva(u)
            u.t(" unit.")
        elif n == 4:
            wrong = p.other_like(pole)
            u.t("I ").enum(f, "work_performed", wp).t(" at pole ").ident("pole_id", wrong, expect=False).t(", sorry, ")
            u.ident("pole_id", pole).t(". ")
            if has_new:
                u.t("Installed unit ").ident("replacement_unit", new).t(".")
            u.tags.add("correction")
        elif n == 5:
            u.t("I ").enum(f, "work_performed", wp).t(" at pole ").ident("pole_id", pole)
            if has_new:
                u.t(", installed unit ").ident("replacement_unit", new)
            u.t(", the customer was not notified.").set("customer_notified", False)
            u.tags.add("negation")
        elif n == 6:
            u.t("I ").enum(f, "work_performed", wp).t(" at pole ").ident("pole_id", pole).t(". The unit was not leaking.")
            u.set("condition_found", "none").tags.update({"negation"})
        else:
            u.t("Work order ").plain_digits(str(r.randint(1000, 9999))).t(". I ").enum(
                f, "work_performed", wp).t(" at pole ").ident("pole_id", pole)
            if has_new:
                u.t(" and installed unit ").ident("replacement_unit", new)
            u.t(", customer notified.").set("customer_notified", True)
            u.tags.add("distractor")
    else:
        if n == 0:
            u.t("Okay, finished up at pole ").ident("pole_id", pole).t(". ").enum(f, "work_performed", wp).t(". The old one ").enum(
                f, "condition_found", cond)
            u.t(".")
            if has_new:
                u.t(" Put in unit ").ident("replacement_unit", new).t(".")
        elif n == 1:
            u.t("So I ").enum(f, "work_performed", wp).t(" over at pole ").ident("pole_id", pole).t(", the old unit ").enum(
                f, "condition_found", cond).t(".")
            if has_new:
                u.t(" Unit ").ident("replacement_unit", new).t(" went in.")
        else:
            u.t("Alright, pole ").ident("pole_id", pole).t(" is done, I ").enum(f, "work_performed", wp).t(".")
            if has_new:
                u.t(" New unit is ").ident("replacement_unit", new).t(".")


def gen_pole(p: Pick, u: Utt) -> None:
    f, r = "pole_inspection", u.rng
    pole = p.one("pole")
    result = r.choice(["pass", "pass", "fail", "monitor"])
    defect = r.choice(["rot", "woodpecker", "leaning", "cracked", "none"])
    n = r.randrange(7) if u.split == "dev" else r.randrange(3)
    height = r.choice([30, 35, 40, 45, 50, 55])
    if u.split == "dev":
        if n == 6:  # the worker forgets the inspection result (a required field)
            u.t("Pole ").ident("pole_id", pole).t(" ").t(r.choice(lexicon.DEV[f]["defect_found"][defect])).set("defect_found", defect)
            u.t(".")
            return
        if n == 0:
            u.t("Inspected pole ").ident("pole_id", pole).t(". The pole ").enum(f, "defect_found", defect).t(" and it ").enum(
                f, "inspection_result", result).t(".")
        elif n == 1:
            u.t("Pole ").ident("pole_id", pole).t(" ").enum(f, "inspection_result", result).t(". ").number(
                "height_ft", float(height), f"{int_words(height)} foot pole", f"{height} foot pole")
            u.t(", it ").enum(f, "defect_found", defect).t(".")
        elif n == 2:
            u.t("Checked pole ").ident("pole_id", pole).t(", it ").enum(f, "defect_found", defect).t(", applied preservative.")
            u.set("treatment_applied", True)
        elif n == 3:
            wrong = p.other_like(pole)
            u.t("Inspected pole ").ident("pole_id", wrong, expect=False).t(", no wait, pole ").ident("pole_id", pole).t(". It ")
            u.enum(f, "inspection_result", result).t(".")
            u.tags.add("correction")
        elif n == 4:
            u.t("Pole ").ident("pole_id", pole).t(", ").number("height_ft", float(height), f"{int_words(height)} feet",
                                                                f"{height} feet")
            u.t(". It ").enum(f, "inspection_result", result).t(".")
        else:
            u.t("Inspection done on pole ").ident("pole_id", pole).t(", ").enum(f, "inspection_result", result).t(".")
    else:
        if n == 0:
            u.t("Looked at pole ").ident("pole_id", pole).t(" and it ").enum(f, "defect_found", defect).t(". Overall it ").enum(
                f, "inspection_result", result).t(".")
        elif n == 1:
            u.t("Okay pole ").ident("pole_id", pole).t(" it ").enum(f, "inspection_result", result).t(".")
        else:
            u.t("So pole ").ident("pole_id", pole).t(", it ").enum(f, "defect_found", defect).t(" and it ").enum(
                f, "inspection_result", result).t(".")


def gen_meter(p: Pick, u: Utt) -> None:
    f, r = "meter_exchange", u.rng
    old, new = p.one("meter", status="installed"), p.one("meter", status="stock")
    reason = r.choice(list(lexicon.DEV[f]["reason"]))
    reading = r.choice([1250, 4821, 12456, 30877, 987, 20415])
    n = r.randrange(6) if u.split == "dev" else r.randrange(3)
    rd = lambda: u.number("final_reading", float(reading), f"{int_words(reading)} kilowatt hours", f"{reading} kWh")
    if u.split == "dev":
        if n == 5:  # the worker forgets the installed meter (a required field)
            u.t("Removed meter ").ident("old_meter", old).t(", final reading ")
            rd()
            u.t(".")
            return
        if n == 0:
            u.t("Removed meter ").ident("old_meter", old).t(", installed meter ").ident("new_meter", new).t(", final reading ")
            rd()
            u.t(". This one ").enum(f, "reason", reason).t(".")
        elif n == 1:
            u.t("Old meter ").ident("old_meter", old).t(", new meter ").ident("new_meter", new).t(". Final reading ")
            rd()
            u.t(". Seal applied.").set("seal_applied", True)
        elif n == 2:
            wrong = p.other_like(new)
            u.t("Installed meter ").ident("new_meter", wrong, expect=False).t(", sorry, ").ident("new_meter", new).t(". Removed meter ")
            u.ident("old_meter", old).t(".")
            u.tags.add("correction")
        elif n == 3:
            u.t("Exchanged the meter, old meter ").ident("old_meter", old).t(", new meter ").ident("new_meter", new).t(". This one ")
            u.enum(f, "reason", reason).t(".")
        else:
            u.t("Put in meter ").ident("new_meter", new).t(", the removed meter was ").ident("old_meter", old).t(". Final reading ")
            rd()
            u.t(".")
    else:
        if n == 0:
            u.t("Swapped the meter out, old one ").ident("old_meter", old).t(" and the new one is ").ident("new_meter", new).t(
                ". This one ").enum(f, "reason", reason).t(".")
        elif n == 1:
            u.t("Meter job done. Removed ").ident("old_meter", old).t(", put in ").ident("new_meter", new).t(". It ").enum(
                f, "reason", reason).t(".")
        else:
            u.t("Okay the old meter ").ident("old_meter", old).t(" is out, new meter ").ident("new_meter", new).t(" is in and it ")
            u.enum(f, "reason", reason).t(".")


def gen_outage(p: Pick, u: Utt) -> None:
    f, r = "outage_restoration", u.rng
    feeder = p.one("feeder")
    cause = r.choice(list(lexicon.DEV[f]["cause"]))
    customers = r.choice([12, 45, 112, 260, 1450, 87])
    n = r.randrange(5) if u.split == "dev" else r.randrange(3)
    cu = lambda: u.number("customers_restored", float(customers), f"{int_words(customers)} customers", f"{customers} customers")
    if u.split == "dev":
        if n == 4:  # the worker forgets the cause (a required field)
            u.t("Power restored on feeder ").ident("feeder", feeder).t(", ")
            cu()
            u.t(".").set("power_restored", True)
            return
        if n == 0:
            u.t("Feeder ").ident("feeder", feeder).t(" restored. Cause was ").enum(f, "cause", cause).t(". ")
            cu()
            u.t(" restored. Power restored.").set("power_restored", True)
        elif n == 1:
            u.t("Restored power on feeder ").ident("feeder", feeder).t(", ").enum(f, "cause", cause).t(", ")
            cu()
            u.t(".").set("power_restored", True)
        elif n == 2:
            wrong = p.other_like(feeder)
            u.t("Circuit ").ident("feeder", wrong, expect=False).t(", correction, circuit ").ident("feeder", feeder).t(
                ". Cause was ").enum(f, "cause", cause).t(".")
            u.tags.add("correction")
        else:
            u.t("Feeder ").ident("feeder", feeder).t(", cause was ").enum(f, "cause", cause).t(".")
    else:
        if n == 0:
            u.t("Got feeder ").ident("feeder", feeder).t(" back on. Looks like ").enum(f, "cause", cause).t(".")
        elif n == 1:
            u.t("Okay circuit ").ident("feeder", feeder).t(" is energized again, ").enum(f, "cause", cause).t(".")
        else:
            u.t("Trouble call on feeder ").ident("feeder", feeder).t(" is closed out. ").enum(f, "cause", cause).t(".")


GENERATORS = {"transformer_replacement": gen_transformer, "pole_inspection": gen_pole, "meter_exchange": gen_meter,
              "outage_restoration": gen_outage}
FORM_WEIGHTS = {"transformer_replacement": 0.4, "pole_inspection": 0.25, "meter_exchange": 0.2, "outage_restoration": 0.15}


def build_cases(world: DemoWorld, n_cases: int, seed: int, heldout_fraction: float = 0.25) -> list[EvalCase]:
    rng = random.Random(seed)
    p = Pick(world, rng)
    forms = {f.id: f for f in world.forms}
    ids = list(FORM_WEIGHTS)
    cases: list[EvalCase] = []
    for i in range(n_cases):
        form_id = rng.choices(ids, [FORM_WEIGHTS[x] for x in ids])[0]
        split = "heldout" if rng.random() < heldout_fraction else "dev"
        u = Utt(rng, split)
        GENERATORS[form_id](p, u)
        spoken, written = u.text()
        form = forms[form_id]
        expected: dict[str, Scalar] = {spec.key: u.expected.get(spec.key) for spec in form.fields if spec.key != "notes"}
        absent = [s.key for s in form.fields if s.required and expected.get(s.key) is None]
        if expected.get("work_performed") == "transformer_replacement" and expected.get("replacement_unit") is None:
            absent.append("replacement_unit")
        if absent:
            u.tags.add("missing_required")
        referenced = {a for _, a in u.ids}
        job_ids = set(referenced)
        for kind, aid in u.ids:
            asset = next(a for a in p.by_kind[kind] if a.id == aid)
            if rng.random() < 0.35:  # a confusable twin in the closed world: a misheard digit is still "valid"
                job_ids.add(p.other_like(asset).id)
            job_ids.add(p.one(kind, exclude=referenced).id)
        # transformer jobs: the stock inventory and the transformers on the referenced poles are part of the truck's world
        if form_id == "transformer_replacement":
            job_ids.update(a.id for a in p.by_kind["stock_unit"])
            on_poles = {aid for kind, aid in u.ids if kind == "pole"}
            job_ids.update(a.id for a in p.by_kind["transformer"] if a.attributes.get("parent_pole") in on_poles)
            job_ids.add(p.one("transformer").id)
        cases.append(EvalCase(
            id=f"c-{i:04d}", form_id=form_id, form_version=form.version, job_asset_ids=sorted(job_ids),
            spoken_text=spoken, written_text=written, expected=expected, tags=sorted(u.tags), split=split))
    return cases

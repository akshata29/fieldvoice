"""Prompt-tuning set: hand-written colloquial statements, disjoint from the held-out phrase bank.

The held-out split of ``synth-v1`` is for *reporting* generalization, so it must never be used to tune a prompt. This tiny
dataset (``prompt-dev``, text only) is what prompts are tuned on: every enum field of the four forms, three different
ways of saying each option, none of them in the form lexicon (so the rules leave them to the model) and none of them in the
held-out phrase bank (``lexicon.HELDOUT``).

    python -m backend.synth.prompt_dev
"""
from __future__ import annotations

import argparse
import logging
import re
import shutil
from collections import Counter
from datetime import datetime, timezone

from backend.config import get_settings
from backend.schemas.eval import EvalCase, EvalDatasetInfo
from backend.schemas.extraction import Scalar
from backend.synth import lexicon
from backend.synth.utterances import digit_words
from backend.synth.world import CANON_POLE, CANON_UNIT, build_world

log = logging.getLogger(__name__)
PROMPT_DEV = "prompt-dev"

# (form, field) -> option code -> ways of saying it, written to follow the lead-in text of the template below
PHRASES: dict[tuple[str, str], dict[str, list[str]]] = {
    ("transformer_replacement", "work_performed"): {
        "transformer_replacement": ["swapped the old can out for a new one", "exchanged the unit for a fresh one",
                                    "set a new pot on the pole in place of the old one"],
        "transformer_repair": ["tightened the loose connections on the transformer", "replaced a bushing on the existing transformer",
                               "got the transformer working again without changing it"],
        "transformer_removal": ["pulled the transformer off the pole and left it at the yard", "disconnected the unit and hauled it away",
                                "took the old transformer away and did not put one back"],
    },
    ("transformer_replacement", "condition_found"): {
        "oil_leak": ["had oil seeping out of the tank", "left a puddle of oil underneath it", "was wet with oil"],
        "corrosion": ["was rusted through", "had paint flaking off from rust", "had heavy rust all over the case"],
        "damage": ["had a big dent in the case", "had a broken bushing", "looked like somebody hit it, it was bent"],
        "overheating": ["had paint blistered from heat", "was too hot to touch", "had cooked itself"],
        "none": ["looked normal", "had nothing unusual about it", "seemed fine to me"],
    },
    ("pole_inspection", "inspection_result"): {
        "pass": ["is solid", "has no concerns at all", "is in fine shape"],
        "fail": ["needs to be replaced", "is shot", "is not safe to climb and should be changed"],
        "monitor": ["needs an eye kept on it", "should be rechecked next cycle", "is marginal so watch it"],
    },
    ("pole_inspection", "defect_found"): {
        "rot": ["is hollow inside from fungus", "is soft at the ground", "is spongy near the base"],
        "woodpecker": ["is full of holes from birds", "has had woodpeckers working on it", "has holes drilled all over it by birds"],
        "leaning": ["is crooked and tipping over", "is tipped way over toward the road", "is sagging to one side"],
        "cracked": ["has a deep crack near the top", "has a crack along the grain", "has a seam opening up on the side"],
        "none": ["is in perfect condition", "has nothing to report", "is all clear"],
    },
    ("meter_exchange", "reason"): {
        "scheduled_upgrade": ["was part of the smart meter changeout program", "was a routine swap for the new digital type",
                              "was due for the newer kind of meter"],
        "failed_meter": ["had a blank display", "had stopped registering", "had died on us"],
        "tamper": ["had its seal cut and wires jumpered", "showed wires run around the meter", "had a cut seal"],
        "customer_request": ["was requested by the account holder", "was done because the person living there wanted it",
                             "was something the occupant asked about"],
    },
    ("outage_restoration", "cause"): {
        "tree_contact": ["a big limb came down on the line", "tree growth was touching the primary", "a tree fell across the wires"],
        "equipment_failure": ["a transformer blew", "an insulator failed and shorted out", "a switch failed on the pole"],
        "animal_contact": ["a bird landed on the crossarm and shorted it", "a snake got into the cabinet", "a possum climbed the pole"],
        "vehicle_accident": ["a delivery truck snagged the service drop", "a car slid off the road and hit the guy wire",
                             "a driver clipped the pole"],
        "weather": ["a thunderstorm rolled through", "heavy snow loaded up the wires", "the wind was howling all night"],
        "unknown": ["the cause is still undetermined", "we do not know why it tripped", "nobody could say what happened"],
    },
}


def _held_out_phrases() -> set[str]:
    return {p for form in lexicon.HELDOUT.values() for field in form.values() for ps in field.values() for p in ps}


def build_prompt_dev(name: str = PROMPT_DEV) -> EvalDatasetInfo:
    world = build_world(7)
    forms = {f.id: f for f in world.forms}
    by_kind: dict[str, list] = {}
    for a in world.assets:
        by_kind.setdefault(a.kind, []).append(a)
    stock = [a.id for a in by_kind["stock_unit"]]
    installed = [a for a in by_kind["meter"] if a.attributes.get("status") == "installed"]
    spare = [a for a in by_kind["meter"] if a.attributes.get("status") == "stock"]
    feeders = by_kind["feeder"]
    poles = [CANON_POLE, "213", "321", "132", "A77", "E9"]
    transformers = [a.id for a in by_kind["transformer"]]
    taken = _held_out_phrases()
    cases: list[EvalCase] = []

    def add(form_id: str, written: str, expected: dict[str, Scalar], job_ids: list[str]) -> None:
        form = forms[form_id]
        spoken = re.sub(r"\s+([.,])", r"\1", re.sub(r"\d+", lambda m: f" {digit_words(m.group())} ", written)).replace("  ", " ")
        full = {s.key: expected.get(s.key) for s in form.fields if s.key != "notes"}
        cases.append(EvalCase(
            id=f"pd-{len(cases) + 1:03d}", form_id=form_id, form_version=form.version, job_asset_ids=sorted(set(job_ids)),
            spoken_text=spoken, written_text=written, expected=full, tags=["tune", "colloquial"], split="dev"))

    n = 0
    for (form_id, key), options in PHRASES.items():
        for code, phrases in options.items():
            for phrase in phrases:
                assert phrase not in taken, f"{phrase!r} is a held-out phrase"
                n += 1
                if form_id == "transformer_replacement":
                    pole = poles[n % 4]
                    unit = stock[n % len(stock)]
                    job = [pole, *transformers[:2], *stock]
                    if key == "work_performed":
                        exp: dict[str, Scalar] = {"work_performed": code, "pole_id": pole}
                        text = f"At pole {pole} I {phrase}."
                        if code == "transformer_replacement":
                            text += f" Unit {unit} went in."
                            exp["replacement_unit"] = unit
                    else:
                        exp = {"condition_found": code, "pole_id": pole}
                        text = f"Done at pole {pole}, the old unit {phrase}."
                    add(form_id, text, exp, job)
                elif form_id == "pole_inspection":
                    pole = poles[(n % 2) + 4] if n % 3 == 0 else poles[n % 4]
                    add(form_id, f"Pole {pole}, it {phrase}.", {key: code, "pole_id": pole}, [pole, *poles])
                elif form_id == "meter_exchange":
                    old, new = installed[n % len(installed)].id, spare[n % len(spare)].id
                    add(form_id, f"Meter job done. Old meter {old}, new meter {new}. It {phrase}.",
                        {"reason": code, "old_meter": old, "new_meter": new}, [old, new, *[a.id for a in spare[:4]]])
                else:
                    feeder = feeders[n % len(feeders)].id
                    add(form_id, f"Got feeder {feeder} back on. Looks like {phrase}.", {"cause": code, "feeder": feeder},
                        [feeder, *[a.id for a in feeders[:3]]])
    root = get_settings().datasets_dir / name
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    (root / "world.json").write_text(world.model_dump_json(indent=1), encoding="utf-8")
    (root / "cases.jsonl").write_text("\n".join(c.model_dump_json() for c in cases) + "\n", encoding="utf-8")
    info = EvalDatasetInfo(
        id=name, name=name, created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), seed=7,
        n_cases=len(cases), n_with_audio=0, form_ids=sorted({c.form_id for c in cases}),
        tag_counts=dict(sorted(Counter(t for c in cases for t in c.tags).items())),
        splits=dict(Counter(c.split for c in cases)), synthetic=True)
    (root / "manifest.json").write_text(info.model_dump_json(indent=1), encoding="utf-8")
    return info


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(prog="backend.synth.prompt_dev")
    ap.add_argument("--name", default=PROMPT_DEV)
    a = ap.parse_args(argv)
    print(build_prompt_dev(a.name).model_dump_json(indent=1))


if __name__ == "__main__":
    main()

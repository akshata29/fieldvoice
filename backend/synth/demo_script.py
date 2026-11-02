"""The scripted demo dataset: hand-written utterances for the three work orders of the demo technician (w-1001).

Unlike the generated dataset these lines are authored, not sampled, so the first one is exactly the sentence from the
customer call. They are labelled like every other case, form a tiny dataset (``demo-script``) that evaluates in a
minute, and are the first thing the job page's sample picker offers.

    python -m backend.synth.demo_script            # text + speech (Windows voices)
"""
from __future__ import annotations

import argparse
import logging
import shutil
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np

from backend.config import get_settings
from backend.evalkit.dataset import DEMO_DATASET
from backend.schemas.eval import EvalCase, EvalDatasetInfo, NoiseSpec
from backend.schemas.extraction import Scalar
from backend.synth import tts
from backend.synth.augment import apply_noise, read_wav, write_wav
from backend.synth.build_dataset import _tag_noise
from backend.synth.world import build_world

log = logging.getLogger(__name__)
ProgressFn = Callable[[float, str], None]
WORLD_SEED = 7  # the system of record's world (backend/demo/sor/service.py)


@dataclass(frozen=True)
class Line:
    id: str
    work_order: str  # the job this is spoken against
    spoken: str
    written: str
    expected: dict[str, Scalar]  # only what is said; every other field of the form is left empty
    tags: tuple[str, ...] = ()
    split: str = "dev"
    noise: NoiseSpec | None = None
    note: str = field(default="", compare=False)  # what the line is there to show


HEADLINE_SPOKEN = ("I replaced the transformer at pole one two three. The old unit was leaking oil and I installed "
                   "unit four five six.")

LINES: tuple[Line, ...] = (
    Line("demo-01", "WO-10231", HEADLINE_SPOKEN,
         "I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.",
         {"work_performed": "transformer_replacement", "pole_id": "123", "condition_found": "oil_leak",
          "replacement_unit": "456"}, ("headline", "digits"),
         note="The sentence from the customer call. Removed unit T9921 comes from dispatch, not from speech."),
    Line("demo-02", "WO-10231",
         "At pole one two three I changed out the transformer. The old unit tango nine nine two one was corroded. "
         "New unit is four fifty six, customer was notified.",
         "At pole 123 I changed out the transformer. The old unit T9921 was corroded. New unit is 456, customer was notified.",
         {"work_performed": "transformer_replacement", "pole_id": "123", "removed_unit": "T9921",
          "condition_found": "corrosion", "replacement_unit": "456", "customer_notified": True}, ("grouped", "nato"),
         note="Every field spoken; numbers said in groups and a letter id read out in the phonetic alphabet."),
    Line("demo-03", "WO-10231",
         "I swapped the transformer at pole one three two, sorry, one two three. Installed unit four five six.",
         "I swapped the transformer at pole 132, sorry, 123. Installed unit 456.",
         {"work_performed": "transformer_replacement", "pole_id": "123", "replacement_unit": "456"},
         ("correction", "digits"), note="A spoken self-correction: the last id wins. Pole 132 is a real neighbour."),
    Line("demo-04", "WO-10231",
         "So I did a change-out on the can over at pole one two three, the old unit was weeping badly. "
         "Unit four five six went in.",
         "So I did a change-out on the can over at pole 123, the old unit was weeping badly. Unit 456 went in.",
         {"work_performed": "transformer_replacement", "pole_id": "123", "condition_found": "oil_leak",
          "replacement_unit": "456"}, ("colloquial", "digits"), split="heldout",
         note="Slang the lexicon does not contain: the rules leave two fields open and the model suggests them for review."),
    Line("demo-05", "WO-10231",
         "Work order one zero two three one. I replaced the transformer at pole one two three and installed unit "
         "four five six. The unit was not leaking, customer notified.",
         "Work order 10231. I replaced the transformer at pole 123 and installed unit 456. The unit was not leaking, "
         "customer notified.",
         {"work_performed": "transformer_replacement", "pole_id": "123", "replacement_unit": "456",
          "condition_found": "none", "customer_notified": True}, ("distractor", "negation", "digits"),
         note="A work-order number that is not an asset, and a negation (not leaking means no issues)."),
    Line("demo-06", "WO-10231",
         "I replaced the transformer at pole one two three. The old unit was leaking oil.",
         "I replaced the transformer at pole 123. The old unit was leaking oil.",
         {"work_performed": "transformer_replacement", "pole_id": "123", "condition_found": "oil_leak"},
         ("digits", "missing_required"), note="The replacement unit is never said: a required field stays open."),
    Line("demo-07", "WO-10231",
         "I replaced the transformer at pole one two three and installed unit four five six, twenty five k v a unit.",
         "I replaced the transformer at pole 123 and installed unit 456, 25 kVA unit.",
         {"work_performed": "transformer_replacement", "pole_id": "123", "replacement_unit": "456", "kva_rating": 25.0},
         ("digits", "number"), note="A quantity with a unit."),
    Line("demo-08", "WO-10232",
         "At pole three seventy four I repaired the transformer. The old unit tango one zero zero three was damaged.",
         "At pole 374 I repaired the transformer. The old unit T1003 was damaged.",
         {"work_performed": "transformer_repair", "pole_id": "374", "removed_unit": "T1003",
          "condition_found": "damage"}, ("grouped", "nato"), note="The second transformer job of the day."),
    Line("demo-09", "WO-10235",
         "Inspected pole echo nine, forty five feet. The pole has woodpecker holes and it needs to be monitored.",
         "Inspected pole E9, 45 feet. The pole has woodpecker holes and it needs to be monitored.",
         {"pole_id": "E9", "height_ft": 45.0, "defect_found": "woodpecker", "inspection_result": "monitor"},
         ("nato", "number"), note="A different form (pole inspection) from the same bundle."),
    Line("demo-10", "WO-10235",
         "Looked at pole echo nine and it has been pecked up. Overall it bears watching.",
         "Looked at pole E9 and it has been pecked up. Overall it bears watching.",
         {"pole_id": "E9", "defect_found": "woodpecker", "inspection_result": "monitor"}, ("colloquial", "nato"),
         split="heldout", note="Slang again, on the inspection form."),
    Line("demo-11", "WO-10231", HEADLINE_SPOKEN,
         "I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.",
         {"work_performed": "transformer_replacement", "pole_id": "123", "condition_found": "oil_leak",
          "replacement_unit": "456"}, ("digits",), noise=NoiseSpec(kind="engine", snr_db=10.0),
         note="The headline sentence with a truck engine idling behind it."),
)


def build_demo_script(name: str = DEMO_DATASET, with_audio: bool = True, progress: ProgressFn | None = None) -> EvalDatasetInfo:
    report = progress or (lambda f, m: None)
    root = get_settings().datasets_dir / name
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    world = build_world(WORLD_SEED)
    forms = {f.id: f for f in world.forms}
    orders = {w.id: w for w in world.work_orders}
    stock_units = [a.id for a in world.assets if a.kind == "stock_unit"]

    report(0.05, "authoring the scripted cases")
    cases: list[EvalCase] = []
    for ln in LINES:
        wo = orders[ln.work_order]
        form = forms[wo.form_id]
        expected: dict[str, Scalar] = {s.key: ln.expected.get(s.key) for s in form.fields if s.key != "notes"}
        job_ids = list(wo.asset_ids) + (stock_units if form.id == "transformer_replacement" else [])
        cases.append(EvalCase(
            id=ln.id, form_id=form.id, form_version=form.version, job_asset_ids=sorted(set(job_ids)),
            spoken_text=ln.spoken, written_text=ln.written, expected=expected,
            tags=sorted({"demo", *ln.tags}), split="heldout" if ln.split == "heldout" else "dev"))

    n_audio = 0
    if with_audio:
        try:
            voices = tts.list_voices()
        except tts.TtsUnavailable as exc:
            log.warning("no audio generated: %s", exc)
            voices = []
        if voices:
            items = [tts.TtsItem(c.spoken_text, root / "audio" / f"{c.id}.wav", voices[k % len(voices)], 0)
                     for k, c in enumerate(cases)]
            report(0.1, f"synthesizing speech for {len(items)} lines")
            results = tts.synthesize_batch(items, on_item=lambda done, err: report(0.1 + 0.8 * done / len(items),
                                                                                  f"speech {done}/{len(items)}"))
            rng = np.random.default_rng(WORLD_SEED)
            for ln, case, item in zip(LINES, cases, items):
                if results.get(item.out_wav):
                    log.warning("speech failed for %s: %s", case.id, results[item.out_wav])
                    item.out_wav.unlink(missing_ok=True)
                    continue
                if ln.noise is not None:
                    samples, rate = read_wav(item.out_wav)
                    write_wav(item.out_wav, apply_noise(samples, ln.noise, rng), rate)
                case.audio_path = f"audio/{case.id}.wav"
                case.voice = item.voice
                case.noise = ln.noise
                _tag_noise(case, ln.noise)
                case.tags = sorted(case.tags)
                n_audio += 1

    report(0.95, "writing dataset")
    (root / "world.json").write_text(world.model_dump_json(indent=1), encoding="utf-8")
    (root / "cases.jsonl").write_text("\n".join(c.model_dump_json() for c in cases) + "\n", encoding="utf-8")
    info = EvalDatasetInfo(
        id=name, name=name, created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), seed=WORLD_SEED,
        n_cases=len(cases), n_with_audio=n_audio, form_ids=sorted({c.form_id for c in cases}),
        tag_counts=dict(sorted(Counter(t for c in cases for t in c.tags).items())),
        splits=dict(Counter(c.split for c in cases)), synthetic=True)
    (root / "manifest.json").write_text(info.model_dump_json(indent=1), encoding="utf-8")
    report(1.0, f"dataset {name}: {info.n_cases} cases, {n_audio} with audio")
    return info


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(prog="backend.synth.demo_script")
    ap.add_argument("--name", default=DEMO_DATASET)
    ap.add_argument("--no-audio", action="store_true", help="text only")
    a = ap.parse_args(argv)
    info = build_demo_script(a.name, not a.no_audio, progress=lambda f, m: print(f"[{f * 100:5.1f}%] {m}", flush=True))
    print(info.model_dump_json(indent=1))


if __name__ == "__main__":
    main()

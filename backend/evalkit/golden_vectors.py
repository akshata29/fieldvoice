"""Cross-language golden vectors.

A port of the deterministic stages (Swift on iOS, Kotlin, C#, ...) must reproduce the Python behaviour exactly; these
language-neutral vectors make that checkable. ``build_vectors`` refuses to emit a pipeline vector whose output differs
from the stated expectation, so the file never encodes a known-wrong answer as the specification.

    python -m backend.evalkit.golden_vectors [--out ios-spike/golden/golden_vectors.json]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from backend.config import REPO_ROOT
from backend.core.formpack import get_formpack
from backend.core.golden import golden_assets, golden_form
from backend.core.normalize import normalize
from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.engines.simple import ScriptedLlm

VECTOR_VERSION = 1
DEFAULT_OUT = REPO_ROOT / "ios-spike" / "golden" / "golden_vectors.json"

NORMALIZER_INPUTS = [
    "I replaced the transformer at pole 123.",
    "I replaced the transformer at pole 1 2 3.",
    "at pole one two three",
    "pole one hundred twenty three",
    "pole one twenty three",
    "unit four fifty six",
    "unit twelve thirty four",
    "pole oh seven",
    "pole one oh four",
    "serial double five seven",
    "serial triple zero",
    "pole two thousand five",
    "meter one two three four five six seven eight",
    "a twenty five k v a transformer",
    "rated fourteen point two kilovolts",
    "pole 12 3",
    "one of the poles was no one's",
    "it was the one on the left",
    "pole one",
    "Um, I installed, uh, unit 456.",
    "poles 1, 2, 3",
    "pole 1-2-3, sorry, 3-28",
    "feeder 23-22",
    "transformer tango four four seven one",
    "pole A as in alpha seven seven",
    "pole T-4471",
    "mike checked the pole",
    "First thing. Second thing here.",
]

# (transcript, fields that must be present with exactly these values). Statuses are recorded from the run.
PIPELINE_CASES: list[tuple[str, dict]] = [
    ("I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.",
     {"work_performed": "transformer_replacement", "pole_id": "123", "replacement_unit": "456",
      "condition_found": "oil_leak"}),
    ("at pole one two three I swapped the transformer and put in unit four fifty six",
     {"work_performed": "transformer_replacement", "pole_id": "123", "replacement_unit": "456"}),
    ("Inspected the pole A as in alpha seven seven, looked fine",
     {"work_performed": "pole_inspection", "pole_id": "A77", "condition_found": "none"}),
    ("replaced the transformer at pole 123, removed unit T9921 and installed unit 456, customer notified",
     {"work_performed": "transformer_replacement", "pole_id": "123", "removed_unit": "T9921",
      "replacement_unit": "456", "customer_notified": True}),
    ("pole one twenty three, installed unit four five six, no wait four six five",
     {"pole_id": "123", "replacement_unit": "465"}),
    ("repaired the transformer at pole 132, twenty five k v a, corrosion",
     {"work_performed": "transformer_repair", "pole_id": "132", "condition_found": "corrosion", "kva_rating": 25.0}),
    ("changed out the transformer at pole 132 and installed unit 789, the customer was not notified",
     {"work_performed": "transformer_replacement", "pole_id": "132", "replacement_unit": "789",
      "customer_notified": False}),
    ("Replaced the transformer at pole 123 and the old unit T9921 had rust, installed 456",
     {"work_performed": "transformer_replacement", "pole_id": "123", "removed_unit": "T9921",
      "replacement_unit": "456", "condition_found": "corrosion"}),
]

# utterances whose prompts are captured for LLM benchmarking (the colloquial one opens the hybrid LLM gate)
PROMPT_TRANSCRIPTS = [
    "I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.",
    "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456.",
]
PROMPT_STRATEGIES = ["free_json", "enum_grammar", "hybrid", "hybrid_always"]


def _field_record(fv) -> dict:
    return {"value": fv.value, "status": fv.status.value, "confidence": round(float(fv.confidence), 2)}


def build_vectors() -> dict:
    form, assets = golden_form(), golden_assets()
    pack = get_formpack(form)
    triggers = sorted(pack.id_trigger_words)

    normalizer = []
    for raw in NORMALIZER_INPUTS:
        n = normalize(raw, set(triggers))
        normalizer.append({
            "raw": raw, "text": n.text, "clean": n.clean,
            "tokens": [{"text": t.text, "kind": t.kind, "value": t.value, "start": t.start, "end": t.end}
                       for t in n.tokens],
        })

    pipeline = ExtractionPipeline()
    cases = []
    for transcript, expected in PIPELINE_CASES:
        res = pipeline.run(PipelineInput(transcript=transcript, form=form, assets=assets), "rules_only", None)
        wrong = {k: (res.fields[k].value, v) for k, v in expected.items() if res.fields[k].value != v}
        if wrong:
            raise AssertionError(f"rules_only disagrees with the stated expectation for {transcript!r}: {wrong}")
        cases.append({
            "transcript": transcript, "expected": expected,
            "fields": {k: _field_record(v) for k, v in res.fields.items() if v.value is not None},
        })

    prompts = []
    for transcript in PROMPT_TRANSCRIPTS:
        for strategy in PROMPT_STRATEGIES:
            llm = ScriptedLlm(reply={})
            pipeline.run(PipelineInput(transcript=transcript, form=form, assets=assets), strategy, llm)
            for call in llm.calls[:1]:
                prompts.append({"strategy": strategy, "transcript": transcript, "system": call["system"],
                                "user": call["user"], "response_format": call["response_format"]})

    return {
        "version": VECTOR_VERSION,
        "generated_by": "python -m backend.evalkit.golden_vectors",
        "note": "Regenerate after any change to normalize/resolver/formpack/prompts; backend tests fail on drift.",
        "form": form.model_dump(mode="json"),
        "assets": [a.model_dump(mode="json") for a in assets],
        "normalizer_extra_id_triggers": triggers,
        "normalizer": normalizer,
        "pipeline_rules_only": cases,
        "llm_prompts": prompts,
    }


def render(vectors: dict) -> str:
    return json.dumps(vectors, indent=1, ensure_ascii=False, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="backend.evalkit.golden_vectors")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render(build_vectors()), encoding="utf-8")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

"""The committed cross-language golden vectors must match what the Python implementation produces today."""
from __future__ import annotations

import json

from backend.evalkit.golden_vectors import DEFAULT_OUT, build_vectors, render


def test_golden_vectors_file_is_current() -> None:
    assert DEFAULT_OUT.exists(), "run: python -m backend.evalkit.golden_vectors"
    committed = json.loads(DEFAULT_OUT.read_text(encoding="utf-8"))
    fresh = json.loads(render(build_vectors()))
    assert committed == fresh, "behaviour changed - regenerate with: python -m backend.evalkit.golden_vectors"


def test_vectors_cover_negation_and_corrections() -> None:
    v = build_vectors()
    by_text = {c["transcript"]: c for c in v["pipeline_rules_only"]}
    neg = next(c for t, c in by_text.items() if "was not notified" in t)
    assert neg["fields"]["customer_notified"]["value"] is False
    corr = next(c for t, c in by_text.items() if "no wait" in t)
    assert corr["fields"]["replacement_unit"]["value"] == "465"
    assert {p["strategy"] for p in v["llm_prompts"]} >= {"free_json", "enum_grammar", "hybrid"}

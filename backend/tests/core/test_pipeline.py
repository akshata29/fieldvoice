"""Tests for the extraction pipeline strategies (no model needed: scripted LLM double)."""
from __future__ import annotations

import pytest

from backend.config import get_settings
from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.engines.simple import ScriptedLlm
from backend.schemas.extraction import FieldSource, FieldStatus
from backend.tests.core.fixtures import transformer_form, world_assets

CANONICAL = "I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456."


def make_input(text: str) -> PipelineInput:
    return PipelineInput(transcript=text, form=transformer_form(), assets=world_assets())


def test_rules_only_canonical() -> None:
    res = ExtractionPipeline().run(make_input(CANONICAL), "rules_only")
    assert res.error is None
    assert res.fields["pole_id"].value == "123"
    assert res.fields["condition_found"].value == "oil_leak"
    stages = [t.stage for t in res.timings]
    assert stages == ["normalize", "resolve", "validate"]
    assert any("Required" not in w for w in res.warnings) or res.warnings == []


def test_hybrid_skips_llm_when_everything_is_explained() -> None:
    llm = ScriptedLlm(reply={})
    res = ExtractionPipeline().run(make_input(CANONICAL), "hybrid", llm)
    assert llm.calls == []  # gate closed: no residual words -> zero LLM latency
    assert "llm" not in [t.stage for t in res.timings]


def test_hybrid_asks_llm_only_about_residual_and_flags_suggestions() -> None:
    llm = ScriptedLlm(reply={"condition_found": "oil_leak"})
    text = "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456."
    res = ExtractionPipeline().run(make_input(text), "hybrid", llm)
    assert len(llm.calls) == 1
    fmt = llm.calls[0]["response_format"]
    assert fmt["type"] == "lark_grammar" and "oil_leak" in fmt["lark_grammar"]
    f = res.fields["condition_found"]
    assert f.value == "oil_leak" and f.source == FieldSource.LLM and f.status == FieldStatus.NEEDS_REVIEW
    # deterministic fields are untouched and confident
    assert res.fields["pole_id"].status == FieldStatus.FILLED
    assert [t.stage for t in res.timings] == ["normalize", "resolve", "llm", "validate"]


def test_llm_cannot_invent_ids_or_invalid_enums() -> None:
    llm = ScriptedLlm(reply={"condition_found": "exploded", "removed_unit": "999"})
    text = "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456."
    res = ExtractionPipeline().run(make_input(text), "hybrid", llm)
    assert res.fields["condition_found"].status == FieldStatus.MISSING
    assert res.fields["removed_unit"].value is None


def test_ids_already_assigned_are_not_offered_for_other_fields() -> None:
    # regression: the patch prompt used to list pole 123 / unit 456 as candidates for "removed_unit"
    llm = ScriptedLlm(reply={"condition_found": "oil_leak", "removed_unit": "456"})
    text = "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456."
    res = ExtractionPipeline().run(make_input(text), "hybrid", llm)
    assert "removed_unit" not in llm.calls[0]["user"]  # nothing free to offer -> the model is not asked
    assert res.fields["removed_unit"].value is None
    assert res.fields["condition_found"].value == "oil_leak"
    # a genuinely free id is resolved by the rules (kind inferred from today's assets), not left to the model
    llm2 = ScriptedLlm(reply={"condition_found": "oil_leak"})
    text2 = "Replaced the transformer at pole 123, installed unit 456, the old unit T9921 was weeping badly."
    res2 = ExtractionPipeline().run(make_input(text2), "hybrid", llm2)
    assert res2.fields["removed_unit"].value == "T9921" and res2.fields["removed_unit"].source == FieldSource.RULE
    assert "removed_unit" not in llm2.calls[0]["user"]


def test_hybrid_always_calls_llm() -> None:
    text = "I replaced the transformer at pole 123 and installed unit 456."  # the condition was never stated
    gated = ScriptedLlm(reply={})
    ExtractionPipeline().run(make_input(text), "hybrid", gated)
    assert gated.calls == []  # nothing unexplained was said: the gate stays closed
    always = ScriptedLlm(reply={})
    ExtractionPipeline().run(make_input(text), "hybrid_always", always)
    assert len(always.calls) == 1 and "condition_found" in always.calls[0]["user"]


def test_booleans_are_only_asked_about_when_the_topic_was_mentioned() -> None:
    # regression: a 0.5B model answered customer_notified=true for statements that never mention a customer
    quiet = ScriptedLlm(reply={"condition_found": "oil_leak", "customer_notified": True})
    text = "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456."
    res = ExtractionPipeline().run(make_input(text), "hybrid", quiet)
    assert "customer_notified" not in quiet.calls[0]["user"]
    assert res.fields["customer_notified"].value is None and res.fields["condition_found"].value == "oil_leak"
    told = ScriptedLlm(reply={"condition_found": "oil_leak", "customer_notified": True})
    res2 = ExtractionPipeline().run(
        make_input("Replaced the transformer at pole 123, the old unit was weeping badly, the customer was told, "
                   "installed unit 456."), "hybrid", told)
    assert "customer_notified" in told.calls[0]["user"] and res2.fields["customer_notified"].value is True
    assert res2.fields["customer_notified"].status == FieldStatus.NEEDS_REVIEW  # still only a suggestion


def test_model_cannot_claim_none_when_nothing_was_said_about_it() -> None:
    # regression: qwen2.5-1.5b answered condition_found="none" (shown as "No issues") for statements that never mention a
    # condition; "not stated" is not "no issues"
    shrug = ScriptedLlm(reply={"work_performed": "transformer_repair", "condition_found": "none"})
    text = "So I patched up the transformer over at pole 123, installed unit 456."
    res = ExtractionPipeline().run(make_input(text), "hybrid_always", shrug)
    assert len(shrug.calls) == 1 and "condition_found" in shrug.calls[0]["user"]
    assert res.fields["condition_found"].status == FieldStatus.MISSING
    assert res.fields["work_performed"].value == "transformer_repair"  # other suggestions are unaffected
    # with something reassuring said, the same answer is an acceptable (still unconfirmed) suggestion
    ok = ScriptedLlm(reply={"condition_found": "none"})
    reassuring = "Replaced the transformer at pole 123, the old unit was in great shape, installed unit 456."
    res2 = ExtractionPipeline().run(make_input(reassuring), "hybrid", ok)
    f = res2.fields["condition_found"]
    assert f.value == "none" and f.status == FieldStatus.NEEDS_REVIEW and f.source == FieldSource.LLM
    # the LLM-only baseline stays unguarded: it exists to show what a model does on its own
    base = ScriptedLlm(reply={"condition_found": "none"})
    res3 = ExtractionPipeline().run(make_input(text), "enum_grammar", base)
    assert res3.fields["condition_found"].value == "none"


@pytest.fixture()
def presence_prompt(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FV_PATCH_PROMPT", "v4")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_presence_prompt_separates_mentioned_from_the_value(presence_prompt) -> None:
    # a model that may answer null mostly does: "mentioned" is a yes/no answer, the value a forced choice
    text = "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456."
    yes = ScriptedLlm(reply={"condition_found": {"mentioned": True, "value": "oil_leak"}})
    res = ExtractionPipeline().run(make_input(text), "hybrid", yes)
    call = yes.calls[0]
    assert "mentioned" in call["response_format"]["lark_grammar"] and "mentioned" in call["user"]
    assert call["response_format"]["lark_grammar"].count("null") == 0  # no way out for the enum
    f = res.fields["condition_found"]
    assert f.value == "oil_leak" and f.status == FieldStatus.NEEDS_REVIEW and f.source == FieldSource.LLM
    no = ScriptedLlm(reply={"condition_found": {"mentioned": False, "value": "corrosion"}})
    assert ExtractionPipeline().run(make_input(text), "hybrid", no).fields["condition_found"].status == FieldStatus.MISSING
    # a forced value for "none" still needs something negative or reassuring in the statement
    shrug = ScriptedLlm(reply={"condition_found": {"mentioned": True, "value": "none"}})
    assert ExtractionPipeline().run(make_input(text), "hybrid", shrug).fields["condition_found"].status == FieldStatus.MISSING
    # the LLM-only baseline keeps the flat form whatever the setting says
    flat = ScriptedLlm(reply={"condition_found": "oil_leak"})
    base = ExtractionPipeline().run(make_input(text), "enum_grammar", flat)
    assert "mentioned" not in flat.calls[0]["response_format"]["lark_grammar"]
    assert base.fields["condition_found"].value == "oil_leak"


def test_free_json_baseline_accepts_values_unverified() -> None:
    llm = ScriptedLlm(reply="```json\n{\"work_performed\": \"transformer_replacement\", \"pole_id\": \"456\", "
                            "\"replacement_unit\": \"123\", \"condition_found\": \"none\"}\n```")
    res = ExtractionPipeline().run(make_input(CANONICAL), "free_json", llm)
    assert res.fields["pole_id"].value == "456"  # swapped ids are accepted silently (the baseline risk)
    assert res.fields["pole_id"].status == FieldStatus.FILLED
    assert llm.calls[0]["response_format"] is None


def test_schema_constrained_passes_schema_object() -> None:
    llm = ScriptedLlm(reply={"work_performed": "pole_inspection"})
    res = ExtractionPipeline().run(make_input(CANONICAL), "schema_constrained", llm)
    fmt = llm.calls[0]["response_format"]
    assert fmt["type"] == "json_schema" and isinstance(fmt["json_schema"], dict)
    assert res.fields["work_performed"].value == "pole_inspection"


def test_enum_grammar_restricts_ids_to_heard_candidates() -> None:
    llm = ScriptedLlm(reply={"pole_id": "123", "replacement_unit": "456", "work_performed": "transformer_replacement"})
    res = ExtractionPipeline().run(make_input(CANONICAL), "enum_grammar", llm)
    grammar = llm.calls[0]["response_format"]["lark_grammar"]
    assert '\\"123\\"' in grammar and '\\"456\\"' in grammar
    assert res.fields["pole_id"].value == "123"


def test_llm_failure_is_reported_not_raised() -> None:
    class Boom(ScriptedLlm):
        def complete(self, *a, **k):  # type: ignore[override]
            raise RuntimeError("model crashed")

    res = ExtractionPipeline().run(make_input("Replaced the transformer at pole 123, weeping badly."), "hybrid", Boom())
    assert res.error and "LLM call failed" in res.error
    assert res.fields["pole_id"].value == "123"  # deterministic results survive an LLM failure


def test_without_guidance_the_pipeline_falls_through_to_plain_generation_and_stays_safe() -> None:
    # the prebuilt ONNX Runtime GenAI iOS build has no constrained decoding: a grammar/schema request throws (docs/IOS_SPIKE.md)
    class NoGuidance(ScriptedLlm):
        def complete(self, system, user, *, response_format=None, max_tokens=200, temperature=0.0):  # type: ignore[override]
            if response_format:
                self.calls.append({"system": system, "user": user, "response_format": response_format})
                raise RuntimeError('Guidance is unavailable in this build (guidance_type="%s").' % response_format["type"])
            return super().complete(system, user, response_format=None, max_tokens=max_tokens, temperature=temperature)

    text = "Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456."
    llm = NoGuidance(reply={"condition_found": "oil_leak", "removed_unit": "999"})
    res = ExtractionPipeline().run(make_input(text), "hybrid", llm)
    tried = [(c["response_format"] or {}).get("type") for c in llm.calls]
    assert tried == ["lark_grammar", "json_schema", None]  # the pipeline's own chain ends unconstrained
    assert res.error is None
    f = res.fields["condition_found"]
    assert f.value == "oil_leak" and f.status == FieldStatus.NEEDS_REVIEW and f.source == FieldSource.LLM
    assert res.fields["removed_unit"].value is None  # an id outside the job's assets is still refused
    assert res.fields["pole_id"].status == FieldStatus.FILLED  # and the deterministic fields are untouched


def test_events_stream_progressively() -> None:
    events: list[dict] = []
    ExtractionPipeline().run(make_input(CANONICAL), "rules_only", on_event=events.append)
    kinds = [(e["type"], e.get("stage")) for e in events]
    assert ("fields", "resolve") in kinds and kinds[-1] == ("fields", "validate")

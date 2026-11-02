"""Tests for the deterministic resolver."""
from __future__ import annotations

from backend.core.formpack import get_formpack
from backend.core.normalize import normalize
from backend.core.resolver import resolve
from backend.core.world import ClosedWorld
from backend.schemas.extraction import FieldStatus
from backend.tests.core.fixtures import transformer_form, world_assets


def run(text: str, assets=None):
    form = transformer_form()
    pack = get_formpack(form)
    norm = normalize(text, set(pack.id_trigger_words))
    world = ClosedWorld.from_assets(assets if assets is not None else world_assets())
    return resolve(norm, pack, world), norm


def val(out, key):
    f = out.fields[key]
    return f.value, f.status


def test_canonical_example() -> None:
    out, norm = run("I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.")
    assert val(out, "work_performed") == ("transformer_replacement", FieldStatus.FILLED)
    assert val(out, "pole_id") == ("123", FieldStatus.FILLED)
    assert val(out, "replacement_unit") == ("456", FieldStatus.FILLED)
    assert val(out, "condition_found") == ("oil_leak", FieldStatus.FILLED)
    assert val(out, "removed_unit")[1] == FieldStatus.MISSING  # old unit id was not stated: never guessed
    assert val(out, "customer_notified")[1] == FieldStatus.MISSING
    assert out.residual == []  # everything explained -> LLM not needed
    ev = out.fields["pole_id"].evidence
    assert ev is not None and "pole 123" in norm.text[ev.start:ev.end]


def test_spoken_digits_and_asr_variants_agree() -> None:
    texts = [
        "I replaced the transformer at pole one two three. The old unit was leaking oil and I installed unit four five six.",
        "I replaced the transformer at pole 1 2 3. The old unit was leaking oil and I installed unit 4 5 6.",
        "i replaced the transformer at pole one twenty three the old unit was leaking oil and i installed unit four fifty six",
    ]
    for t in texts:
        out, _ = run(t)
        assert val(out, "pole_id") == ("123", FieldStatus.FILLED), t
        assert val(out, "replacement_unit") == ("456", FieldStatus.FILLED), t


def test_negation_maps_to_none() -> None:
    out, _ = run("Swapped the transformer at pole 123, the old one was not leaking, installed unit 456.")
    assert val(out, "condition_found") == ("none", FieldStatus.FILLED)
    assert val(out, "work_performed")[0] == "transformer_replacement"


def test_correction_takes_the_later_id() -> None:
    out, _ = run("Replaced the transformer at pole 123, sorry, 132, installed unit 456.")
    assert val(out, "pole_id") == ("132", FieldStatus.FILLED)
    assert val(out, "replacement_unit") == ("456", FieldStatus.FILLED)


def test_out_of_world_is_flagged_not_replaced() -> None:
    out, _ = run("Replaced the transformer at pole 124 and installed unit 456.")
    f = out.fields["pole_id"]
    assert f.value == "124" and f.status == FieldStatus.NEEDS_REVIEW
    assert "123" in f.candidates


def test_role_inferred_from_closed_world() -> None:
    out, _ = run("Installed 456 at 123.")
    assert val(out, "replacement_unit")[0] == "456"
    assert val(out, "pole_id")[0] == "123"


def test_number_with_unit_is_not_an_id() -> None:
    out, _ = run("Replaced the transformer at pole 123 with a twenty five kva unit, installed unit 456.")
    assert out.fields["kva_rating"].value == 25.0
    assert val(out, "pole_id")[0] == "123"
    assert val(out, "replacement_unit")[0] == "456"


def test_boolean_true_and_negated() -> None:
    out, _ = run("Replaced the transformer at pole 123, customer was notified.")
    assert out.fields["customer_notified"].value is True
    out2, _ = run("Replaced the transformer at pole 123, did not notify.")
    assert out2.fields["customer_notified"].status == FieldStatus.MISSING


def test_negator_between_trigger_words_is_honoured() -> None:
    # regression: "customer was not notified" used to match the trigger "customer notified" across the gap -> True
    out, _ = run("Replaced the transformer at pole 123, the customer was not notified.")
    f = out.fields["customer_notified"]
    assert f.value is False and f.status == FieldStatus.FILLED and f.note == "negated mention"
    out2, _ = run("Replaced the transformer at pole 123, the oil was not leaking.")
    assert val(out2, "condition_found") == ("none", FieldStatus.FILLED)
    out3, _ = run("Replaced the transformer at pole 123, the customer was also notified.")
    assert out3.fields["customer_notified"].value is True  # a non-negating gap word changes nothing


def test_colloquial_leaves_residual_for_llm() -> None:
    out, _ = run("Replaced the transformer at pole 123, the old unit was weeping badly, installed unit 456.")
    assert val(out, "condition_found")[1] == FieldStatus.MISSING
    assert "weeping" in out.residual
    assert "condition_found" in out.unresolved


def test_two_poles_conflict() -> None:
    out, _ = run("Checked the pole 123 and pole 132 near the corner.")
    f = out.fields["pole_id"]
    assert f.status == FieldStatus.CONFLICT
    assert set(f.candidates) == {"123", "132"}


def test_text_field_filled_from_transcript() -> None:
    out, _ = run("Um, replaced the transformer at pole 123.")
    assert "um" not in str(out.fields["notes"].value).lower().split()


def test_empty_world_still_works_with_triggers() -> None:
    out, _ = run("Replaced the transformer at pole 123.", assets=[])
    f = out.fields["pole_id"]
    assert f.value == "123" and f.status == FieldStatus.FILLED

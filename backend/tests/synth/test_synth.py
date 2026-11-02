"""World, lexicon, utterance generator, noise augmentation, TTS wrapper and dataset builder (no network, no models)."""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

import numpy as np
import pytest

from backend.config import get_settings
from backend.core.formpack import lint_form
from backend.core.golden import golden_form
from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.engines.simple import ScriptedLlm
from backend.evalkit.dataset import load_dataset
from backend.evalkit.metrics import score_case
from backend.schemas.eval import NoiseSpec
from backend.schemas.forms import CodeOption, FieldSpec, FieldType, FormSchema
from backend.synth import tts
from backend.synth.augment import apply_noise, measured_snr_db, read_wav, write_wav
from backend.synth.build_dataset import build_dataset
from backend.synth.lexicon import all_forms
from backend.synth.utterances import build_cases, grouped_words, int_words, say_id
from backend.synth.world import CANON_POLE, CANON_TRANSFORMER, CANON_UNIT, build_world


# ---- world ---------------------------------------------------------------------------------------------------------
def test_world_is_deterministic_and_unique() -> None:
    a, b = build_world(7), build_world(7)
    assert a.model_dump_json() == b.model_dump_json()
    assert build_world(8).model_dump_json() != a.model_dump_json()
    ids = [x.id for x in a.assets]
    assert len(ids) == len(set(ids)), "asset ids must be unique across kinds"


def test_headline_demo_assets_exist() -> None:
    w = build_world(7)
    by = {(x.kind, x.id): x for x in w.assets}
    assert ("pole", CANON_POLE) in by and ("stock_unit", CANON_UNIT) in by and ("transformer", CANON_TRANSFORMER) in by
    assert by[("transformer", CANON_TRANSFORMER)].attributes["parent_pole"] == CANON_POLE
    for near in ("132", "465"):  # near-miss neighbours catch wrong digits
        assert any(x.id == near for x in w.assets)


def test_work_orders_are_consistent() -> None:
    w = build_world(7)
    asset_ids = {x.id for x in w.assets}
    forms = {f.id: f for f in w.forms}
    kb_ids = {d.id for d in w.kb_docs}
    workers = {x.id for x in w.workers}
    assert len(w.work_orders) >= 10
    for wo in w.work_orders:
        assert wo.worker_id in workers and wo.form_id in forms
        assert set(wo.asset_ids) <= asset_ids and set(wo.kb_doc_ids) <= kb_ids
        for key, value in wo.prefill.items():
            assert key in forms[wo.form_id].keys and str(value) in asset_ids
    first = w.work_orders[0]
    assert first.worker_id == "w-1001" and first.prefill["pole_id"] == CANON_POLE


# ---- lexicon -------------------------------------------------------------------------------------------------------
def test_form_lexicons_have_no_generic_or_ambiguous_synonyms() -> None:
    for form in [golden_form(), *all_forms()]:
        assert lint_form(form) == [], form.id


def test_lint_catches_generic_work_words() -> None:
    form = FormSchema(id="f", title="f", work_type="f", fields=[FieldSpec(
        key="defect", label="Defect", type=FieldType.ENUM,
        options=[CodeOption(code="cracked", label="Cracked", synonyms=["checking"]),
                 CodeOption(code="rot", label="Rot", synonyms=["rot", "cracked"])])])
    problems = lint_form(form)
    assert any("generic work word" in p for p in problems)
    assert any("claimed by both" in p for p in problems)


# ---- number / id speaking ------------------------------------------------------------------------------------------
def test_int_words_and_grouping() -> None:
    assert int_words(25) == "twenty five" and int_words(12456) == "twelve thousand four hundred fifty six"
    assert grouped_words("456") == "four fifty six" and grouped_words("1234") == "twelve thirty four"
    assert grouped_words("105") == "one oh five" and grouped_words("400") is None


def test_say_id_styles() -> None:
    import random

    spoken, written, style = say_id("A77", random.Random(1))
    assert written == "A77" and style == "nato" and "alpha" in spoken
    assert say_id("9921", random.Random(2))[1] == "9921"


# ---- cases ---------------------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def world():
    return build_world(7)


@pytest.fixture(scope="module")
def cases(world):
    return build_cases(world, 300, 11)


def test_cases_are_deterministic(world) -> None:
    a = [c.model_dump_json() for c in build_cases(world, 40, 5)]
    assert a == [c.model_dump_json() for c in build_cases(world, 40, 5)]
    assert a != [c.model_dump_json() for c in build_cases(world, 40, 6)]


def test_case_labels_are_valid(world, cases) -> None:
    forms = {f.id: f for f in world.forms}
    asset_ids = {a.id for a in world.assets}
    for c in cases:
        form = forms[c.form_id]
        assert set(c.expected) == {s.key for s in form.fields if s.key != "notes"}
        for spec in form.fields:
            v = c.expected.get(spec.key)
            if spec.type == FieldType.ENUM and v is not None:
                assert v in {o.code for o in spec.options}, (c.id, spec.key, v)
            if spec.type == FieldType.ENTITY_REF and v is not None:
                assert v in asset_ids and v in c.job_asset_ids, (c.id, spec.key, v)
        assert not re.search(r"\d", c.spoken_text), f"spoken text must have numbers as words: {c.spoken_text}"
        for spec in form.fields:
            if spec.type == FieldType.ENTITY_REF and c.expected.get(spec.key):
                assert str(c.expected[spec.key]) in c.written_text, (c.id, spec.key)


def test_dataset_covers_forms_tags_and_splits(cases) -> None:
    assert {c.form_id for c in cases} == {f.id for f in all_forms()}
    tags = Counter(t for c in cases for t in c.tags)
    for needed in ("digits", "grouped", "nato", "correction", "negation", "distractor", "number", "colloquial",
                   "missing_required"):
        assert tags[needed] >= 3, (needed, tags)
    heldout = [c for c in cases if c.split == "heldout"]
    assert 0.15 < len(heldout) / len(cases) < 0.4


def _run_rules(world, cases):
    forms = {f.id: f for f in world.forms}
    amap = {a.id.upper(): a for a in world.assets}
    pipe = ExtractionPipeline()
    tot = {"correct": 0, "scored": 0, "silent": 0, "confident": 0}
    for c in cases:
        assets = [amap[i.upper()] for i in c.job_asset_ids if i.upper() in amap]
        res = pipe.run(PipelineInput(transcript=c.written_text, form=forms[c.form_id], assets=assets), "rules_only", None)
        sc = score_case(c, forms[c.form_id], res)
        tot["correct"] += sc.correct
        tot["scored"] += sc.scored
        tot["silent"] += sc.silent_wrong
        tot["confident"] += sc.confident
    return tot


def test_rules_handle_the_dev_split_and_never_silently_fail_on_heldout(world, cases) -> None:
    dev = _run_rules(world, [c for c in cases if c.split == "dev"])
    held = _run_rules(world, [c for c in cases if c.split == "heldout"])
    assert dev["correct"] / dev["scored"] >= 0.97, dev
    assert dev["silent"] / dev["confident"] <= 0.01, dev
    # colloquial phrasing is outside the lexicon: deterministic stages leave it for review/the LLM instead of guessing
    assert held["correct"] / held["scored"] < dev["correct"] / dev["scored"]
    assert held["silent"] / held["confident"] <= 0.02, held


# ---- resolver behaviours the dataset exposed (regressions) ----------------------------------------------------------
def _extract(form_id: str, text: str, ids: list[str], world):
    form = next(f for f in world.forms if f.id == form_id)
    assets = [a for a in world.assets if a.id in ids]
    return ExtractionPipeline().run(PipelineInput(transcript=text, form=form, assets=assets), "rules_only", None)


def test_same_kind_roles_without_trigger_words_need_review(world) -> None:
    old = next(a for a in world.assets if a.attributes.get("status") == "installed")
    new = next(a for a in world.assets if a.attributes.get("status") == "stock")
    res = _extract("meter_exchange", f"Swapped the meter out, old one {old.id} and the new one is {new.id}.",
                   [old.id, new.id], world)
    assert res.fields["old_meter"].value == old.id and res.fields["new_meter"].value == new.id
    assert res.fields["old_meter"].status.value == "needs_review"  # which is which was a guess
    res2 = _extract("meter_exchange", f"Old meter {old.id}, new meter {new.id}.", [old.id, new.id], world)
    assert res2.fields["old_meter"].status.value == "filled" and res2.fields["new_meter"].status.value == "filled"


def test_negation_does_not_cross_a_comma(world) -> None:
    res = _extract("pole_inspection", f"Checked pole {CANON_POLE}, it has no defects, applied preservative.",
                   [CANON_POLE], world)
    assert res.fields["treatment_applied"].value is True
    assert res.fields["defect_found"].value == "none"  # "Checked" is not the synonym "checking"


def test_option_wording_alone_does_not_excuse_a_word_from_the_llm_gate(world) -> None:
    # regression: "good to go" and "checks out fine" never reached the model, because "good" and "fine" occur in the wording
    # of OTHER options ("good condition", "looked fine") and so counted as known vocabulary
    form = next(f for f in world.forms if f.id == "pole_inspection")
    assets = [a for a in world.assets if a.id == "213"]
    colloquial = ScriptedLlm(reply={"inspection_result": "pass"})
    res = ExtractionPipeline().run(
        PipelineInput(transcript="Okay pole 213 it is good to go.", form=form, assets=assets), "hybrid", colloquial)
    assert len(colloquial.calls) == 1
    f = res.fields["inspection_result"]
    assert f.value == "pass" and f.status.value == "needs_review"
    # a statement the rules fully explain still costs no model call
    quiet = ScriptedLlm(reply={})
    ExtractionPipeline().run(
        PipelineInput(transcript="Inspected pole 213, no defects, passed.", form=form, assets=assets), "hybrid", quiet)
    assert quiet.calls == []


def test_stray_numbers_are_not_proposed_as_assets(world) -> None:
    # a work-order number is not in today's assets, so it must not be proposed for a field whose kind is known
    res = _extract("transformer_replacement",
                   "Work order 3084. I replaced the transformer at pole 123 and installed unit 456.",
                   ["123", "456", CANON_TRANSFORMER], world)
    assert res.fields["removed_unit"].value is None
    assert res.fields["pole_id"].value == "123" and res.fields["replacement_unit"].value == "456"


# ---- augmentation --------------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def speechlike() -> np.ndarray:
    t = np.arange(16000 * 3) / 16000
    return (0.3 * np.sin(2 * np.pi * 220 * t) * (np.sin(2 * np.pi * 2 * t) > 0)).astype(np.float32)


@pytest.mark.parametrize("kind", ["white", "pink", "wind", "engine", "crackle"])
def test_additive_noise_hits_the_requested_snr(speechlike, kind) -> None:
    out = apply_noise(speechlike, NoiseSpec(kind=kind, snr_db=10.0), np.random.default_rng(3))
    assert out.shape == speechlike.shape and np.abs(out).max() <= 0.951
    assert abs(measured_snr_db(speechlike, out) - 10.0) < 2.5


def test_band_limited_kinds_change_the_signal(speechlike) -> None:
    for kind in ("radio", "muffled"):
        out = apply_noise(speechlike, NoiseSpec(kind=kind, snr_db=20.0), np.random.default_rng(1))
        assert not np.allclose(out, speechlike) and np.isfinite(out).all()
    reverb = apply_noise(speechlike, NoiseSpec(kind="none", reverb=True), np.random.default_rng(1))
    assert not np.allclose(reverb, speechlike)


def test_noise_is_deterministic_per_seed(speechlike) -> None:
    spec = NoiseSpec(kind="wind", snr_db=15.0)
    a = apply_noise(speechlike, spec, np.random.default_rng(9))
    assert np.array_equal(a, apply_noise(speechlike, spec, np.random.default_rng(9)))
    assert not np.array_equal(a, apply_noise(speechlike, spec, np.random.default_rng(10)))


def test_wav_roundtrip(tmp_path: Path, speechlike) -> None:
    write_wav(tmp_path / "x.wav", speechlike)
    back, rate = read_wav(tmp_path / "x.wav")
    assert rate == 16000 and np.allclose(back, speechlike, atol=1 / 16000)


# ---- tts wrapper ---------------------------------------------------------------------------------------------------
def test_tts_batch_reports_per_item_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeProc:
        stdout = iter([f"OK\t{tmp_path / 'a.wav'}\n", f"ERR\t{tmp_path / 'b.wav'}\tvoice not found\n"])

        def wait(self, timeout=None):
            return 0

    def fake_popen(cmd, **kw):
        write_wav(tmp_path / "a.wav", np.zeros(1600, dtype=np.float32) + 0.1)
        return FakeProc()

    monkeypatch.setattr(tts, "_powershell", lambda: "powershell")
    monkeypatch.setattr(tts.subprocess, "Popen", fake_popen)
    res = tts.synthesize_batch([tts.TtsItem("a", tmp_path / "a.wav"), tts.TtsItem("b", tmp_path / "b.wav")])
    assert res[tmp_path / "a.wav"] is None and res[tmp_path / "b.wav"] == "voice not found"


@pytest.mark.skipif(not tts.tts_available(), reason="no Windows speech voices")
def test_real_tts_produces_valid_audio(tmp_path: Path) -> None:
    voice = tts.synthesize("Pole one two three.", tmp_path / "p.wav")
    samples, rate = read_wav(tmp_path / "p.wav")
    assert voice and rate == 16000 and len(samples) > 8000 and np.abs(samples).max() > 0.01


# ---- dataset builder -----------------------------------------------------------------------------------------------
@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FV_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def test_build_dataset_text_only(data_dir: Path) -> None:
    info = build_dataset("t1", 30, 3, with_audio=False, audio_limit=None, augment=True)
    assert info.n_cases == 30 and info.n_with_audio == 0 and info.synthetic
    ds = load_dataset("t1")
    assert len(ds.cases) == 30 and ds.world.forms and not any(c.audio_path for c in ds.cases)
    with pytest.raises(ValueError):
        build_dataset("../escape", 1, 1, False, None, False)


def test_build_dataset_with_audio_and_noise(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_batch(items, on_item=None, timeout_s=0):
        for i, it in enumerate(items):
            write_wav(it.out_wav, (0.2 * np.sin(2 * np.pi * 200 * np.arange(16000) / 16000)).astype(np.float32))
            if on_item:
                on_item(i + 1, None)
        return {it.out_wav: None for it in items}

    monkeypatch.setattr(tts, "list_voices", lambda culture_prefix="en-": ["Voice A", "Voice B"])
    monkeypatch.setattr(tts, "synthesize_batch", fake_batch)
    info = build_dataset("t2", 40, 4, with_audio=True, audio_limit=12, augment=True)
    assert info.n_with_audio == 12
    ds = load_dataset("t2")
    audio_cases = [c for c in ds.cases if c.audio_path]
    assert len(audio_cases) == 12 and all(ds.audio_path(c) for c in audio_cases)
    assert {c.voice for c in audio_cases} == {"Voice A", "Voice B"}
    assert any("noisy" in c.tags for c in audio_cases) and any("clean" in c.tags for c in audio_cases)
    assert info.tag_counts["clean"] + info.tag_counts["noisy"] == 12


def test_build_dataset_degrades_gracefully_without_tts(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def no_voices(culture_prefix="en-"):
        raise tts.TtsUnavailable("no voices")

    monkeypatch.setattr(tts, "list_voices", no_voices)
    info = build_dataset("t3", 10, 1, with_audio=True, audio_limit=5, augment=False)
    assert info.n_cases == 10 and info.n_with_audio == 0

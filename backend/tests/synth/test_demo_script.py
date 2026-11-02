"""The scripted demo dataset (hand-written lines for the demo technician's jobs)."""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pytest

from backend.config import get_settings
from backend.core.pipeline import ExtractionPipeline, PipelineInput
from backend.evalkit.dataset import DEMO_DATASET, find_sample, load_dataset, sample_datasets
from backend.evalkit.metrics import score_case
from backend.schemas.forms import FieldType
from backend.synth import tts
from backend.synth.augment import measured_snr_db, read_wav, write_wav
from backend.synth.build_dataset import build_dataset
from backend.synth.demo_script import HEADLINE_SPOKEN, LINES, build_demo_script
from backend.synth.world import CANON_POLE, CANON_UNIT, build_world


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FV_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


@pytest.fixture()
def fake_speech(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_batch(items, on_item=None, timeout_s=0):
        for i, it in enumerate(items):
            write_wav(it.out_wav, (0.2 * np.sin(2 * np.pi * 200 * np.arange(16000) / 16000)).astype(np.float32))
            if on_item:
                on_item(i + 1, None)
        return {it.out_wav: None for it in items}

    monkeypatch.setattr(tts, "list_voices", lambda culture_prefix="en-": ["Voice A", "Voice B"])
    monkeypatch.setattr(tts, "synthesize_batch", fake_batch)


def test_the_first_line_is_the_sentence_from_the_call(data_dir: Path) -> None:
    build_demo_script(with_audio=False)
    ds = load_dataset(DEMO_DATASET)
    first = ds.cases[0]
    assert first.id == "demo-01" and "headline" in first.tags
    assert first.written_text == "I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456."
    assert first.spoken_text == HEADLINE_SPOKEN
    assert first.expected["replacement_unit"] == CANON_UNIT and first.expected["pole_id"] == CANON_POLE
    assert first.expected["condition_found"] == "oil_leak" and first.expected["work_performed"] == "transformer_replacement"


def test_demo_labels_are_valid_and_scoped_to_the_job(data_dir: Path) -> None:
    build_demo_script(with_audio=False)
    ds = load_dataset(DEMO_DATASET)
    world = build_world(7)
    orders = {w.id: w for w in world.work_orders}
    forms = {f.id: f for f in ds.world.forms}
    asset_ids = {a.id for a in ds.world.assets}
    assert [c.id for c in ds.cases] == [ln.id for ln in LINES]
    for ln, c in zip(LINES, ds.cases):
        wo, form = orders[ln.work_order], forms[c.form_id]
        assert form.id == wo.form_id
        assert set(c.expected) == {s.key for s in form.fields if s.key != "notes"}
        assert not re.search(r"\d", c.spoken_text), c.id
        assert set(wo.asset_ids) <= set(c.job_asset_ids), c.id  # the closed world is the job's own
        for spec in form.fields:
            v = c.expected.get(spec.key)
            if spec.type == FieldType.ENUM and v is not None:
                assert v in {o.code for o in spec.options}, (c.id, spec.key, v)
            if spec.type == FieldType.ENTITY_REF and v is not None:
                assert v in asset_ids and v in c.job_asset_ids and v in c.written_text, (c.id, spec.key, v)
        if form.id == "transformer_replacement":
            assert CANON_UNIT in c.job_asset_ids  # the truck's stock is part of every transformer job
    assert ds.info.synthetic and ds.info.n_cases == len(LINES)


def test_every_scripted_line_is_solved_by_rules_unless_it_is_slang(data_dir: Path) -> None:
    build_demo_script(with_audio=False)
    ds = load_dataset(DEMO_DATASET)
    forms = {f.id: f for f in ds.world.forms}
    pipe = ExtractionPipeline()
    for c in ds.cases:
        res = pipe.run(PipelineInput(transcript=c.written_text, form=forms[c.form_id], assets=ds.assets_for(c)),
                       "rules_only", None)
        sc = score_case(c, forms[c.form_id], res)
        assert sc.silent_wrong == 0, c.id
        if "colloquial" in c.tags:
            assert sc.correct < sc.scored, f"{c.id} is meant to need the model"
        else:
            assert sc.correct == sc.scored, (c.id, {k: (v.value, v.status.value) for k, v in res.fields.items()})


def test_demo_audio_has_a_clean_voice_and_a_noisy_variant(data_dir: Path, fake_speech) -> None:
    info = build_demo_script()
    assert info.n_with_audio == len(LINES)
    ds = load_dataset(DEMO_DATASET)
    assert all(ds.audio_path(c) for c in ds.cases) and {c.voice for c in ds.cases} == {"Voice A", "Voice B"}
    clean, noisy = ds.cases[0], ds.cases[-1]
    assert "clean" in clean.tags and clean.spoken_text == noisy.spoken_text
    assert {"noisy", "noise_engine", "snr_10"} <= set(noisy.tags) and noisy.noise is not None
    a, _ = read_wav(ds.root / clean.audio_path)
    b, _ = read_wav(ds.root / noisy.audio_path)
    assert abs(measured_snr_db(a, b) - 10.0) < 2.5


def test_samples_come_from_the_demo_script_first(data_dir: Path) -> None:
    assert sample_datasets() == []
    build_dataset("synth-v1", 20, 3, with_audio=False, audio_limit=None, augment=False)
    assert [d.info.id for d in sample_datasets()] == ["synth-v1"]
    build_demo_script(with_audio=False)
    assert [d.info.id for d in sample_datasets()] == [DEMO_DATASET, "synth-v1"]
    ds, case = find_sample("demo-01")
    assert ds.info.id == DEMO_DATASET and case.id == "demo-01"
    ds2, case2 = find_sample("c-0000")
    assert ds2.info.id == "synth-v1" and case2.id == "c-0000"
    assert find_sample("nope") is None

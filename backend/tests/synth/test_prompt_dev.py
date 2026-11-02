"""Hand-written prompt-tuning set (text only)."""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.config import get_settings
from backend.evalkit.dataset import load_dataset
from backend.schemas.forms import FieldType
from backend.synth import lexicon
from backend.synth.prompt_dev import PHRASES, PROMPT_DEV, build_prompt_dev


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FV_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def test_every_enum_option_is_said_three_ways_and_none_is_a_heldout_phrase() -> None:
    heldout = {p for form in lexicon.HELDOUT.values() for field in form.values() for ps in field.values() for p in ps}
    forms = {f.id: f for f in lexicon.all_forms()}
    for (form_id, key), options in PHRASES.items():
        assert {o.code for o in forms[form_id].field(key).options} == set(options), (form_id, key)
        for code, phrases in options.items():
            assert len(phrases) == 3 and not heldout & set(phrases), (form_id, key, code)


def test_labels_are_valid_and_scoped_to_the_job(data_dir: Path) -> None:
    info = build_prompt_dev()
    ds = load_dataset(PROMPT_DEV)
    assert info.n_cases == len(ds.cases) == sum(len(p) for opts in PHRASES.values() for p in opts.values())
    assert info.n_with_audio == 0 and all(c.split == "dev" and "tune" in c.tags for c in ds.cases)
    asset_ids = {a.id for a in ds.world.assets}
    for c in ds.cases:
        form = ds.form(c.form_id)
        assert set(c.expected) == {s.key for s in form.fields if s.key != "notes"}
        for spec in form.fields:
            v = c.expected.get(spec.key)
            if spec.type == FieldType.ENUM and v is not None:
                assert v in {o.code for o in spec.options}
            if spec.type == FieldType.ENTITY_REF and v is not None:
                assert v in asset_ids and v in c.job_asset_ids and v in c.written_text, (c.id, spec.key, v)
        assert sum(spec.type == FieldType.ENUM and c.expected.get(spec.key) is not None for spec in form.fields) >= 1

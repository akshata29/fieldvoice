"""Dataset samples (synthetic utterances) for playback in the UI."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.api.context import load_sample
from backend.evalkit.dataset import sample_datasets
from backend.schemas.api import SampleInfo
from backend.schemas.eval import EvalCase

router = APIRouter(prefix="/api/v1/samples", tags=["samples"])


def _info(case: EvalCase, has_audio: bool) -> SampleInfo:
    return SampleInfo(
        id=case.id, form_id=case.form_id, tags=case.tags, split=case.split, has_audio=has_audio,
        spoken_text=case.spoken_text, written_text=case.written_text, expected=case.expected, noise=case.noise,
        voice=case.voice, audio_url=f"/api/v1/samples/{case.id}/audio" if has_audio else None)


@router.get("", response_model=list[SampleInfo])
def list_samples(form_id: str | None = None, tag: str | None = None, split: str | None = None,
                 with_audio: bool | None = None, limit: int = 100) -> list[SampleInfo]:
    out: list[SampleInfo] = []
    for ds in sample_datasets():  # the scripted demo lines come first
        for c in ds.cases:
            if form_id and c.form_id != form_id:
                continue
            if tag and tag not in c.tags:
                continue
            if split and c.split != split:
                continue
            has_audio = ds.audio_path(c) is not None
            if with_audio is not None and with_audio != has_audio:
                continue
            out.append(_info(c, has_audio))
            if len(out) >= limit:
                return out
    return out


@router.get("/{sample_id}/audio")
def sample_audio(sample_id: str) -> FileResponse:
    ds, case = load_sample(sample_id)
    path = ds.audio_path(case)
    if path is None:
        raise HTTPException(404, detail="sample has no audio")
    return FileResponse(path, media_type="audio/wav")

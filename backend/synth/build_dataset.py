"""Build an evaluation dataset: world + labelled utterances (+ synthesized speech, + noise variants).

    python -m backend.synth.build_dataset --name synth-v1 --cases 240 --seed 11 --audio --audio-limit 120

Writes ``data/datasets/<name>/`` = manifest.json, world.json, cases.jsonl and audio/<case>.wav (16 kHz mono PCM16).
"""
from __future__ import annotations

import argparse
import logging
import random
import re
import shutil
from collections import Counter
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from backend.config import get_settings
from backend.schemas.eval import EvalCase, EvalDatasetInfo, NoiseSpec
from backend.synth import tts
from backend.synth.augment import NOISE_KINDS, apply_noise, read_wav, write_wav
from backend.synth.utterances import build_cases
from backend.synth.world import build_world

log = logging.getLogger(__name__)
ProgressFn = Callable[[float, str], None]
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _noise_for(rng: random.Random) -> NoiseSpec:
    if rng.random() < 0.2:
        return NoiseSpec(kind="none", reverb=True)
    return NoiseSpec(kind=rng.choice(NOISE_KINDS), snr_db=float(rng.choice([20, 15, 10, 5])), reverb=rng.random() < 0.15)


def _tag_noise(case: EvalCase, spec: NoiseSpec | None) -> None:
    if spec is None:
        case.tags.append("clean")
        return
    case.tags.append("noisy")
    if spec.kind != "none":
        case.tags.append(f"noise_{spec.kind}")
        case.tags.append(f"snr_{int(spec.snr_db or 0)}")
    if spec.reverb:
        case.tags.append("reverb")


def build_dataset(name: str, n_cases: int, seed: int, with_audio: bool, audio_limit: int | None, augment: bool,
                  progress: ProgressFn | None = None) -> EvalDatasetInfo:
    if not _NAME.match(name):
        raise ValueError(f"invalid dataset name {name!r} (letters, digits, '.', '_' and '-' only)")
    report = progress or (lambda f, m: None)
    root = get_settings().datasets_dir / name
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    rng = random.Random(seed * 7919 + 1)

    report(0.02, "building world")
    world = build_world(seed)
    report(0.05, f"generating {n_cases} utterances")
    cases = build_cases(world, n_cases, seed)

    n_audio = 0
    if with_audio and n_cases > 0:
        wanted = min(n_cases, audio_limit if audio_limit else n_cases)
        chosen = sorted(rng.sample(range(n_cases), wanted))
        try:
            voices = tts.list_voices()
        except tts.TtsUnavailable as exc:
            log.warning("no audio generated: %s", exc)
            voices = []
        if voices:
            items = [tts.TtsItem(cases[i].spoken_text, root / "audio" / f"{cases[i].id}.wav", voices[k % len(voices)],
                                 rng.choice([-1, 0, 0, 1])) for k, i in enumerate(chosen)]
            report(0.08, f"synthesizing speech for {len(items)} utterances")
            results = tts.synthesize_batch(
                items, on_item=lambda done, err: report(0.08 + 0.75 * done / len(items), f"speech {done}/{len(items)}"))
            nprng = np.random.default_rng(seed)
            for k, (i, item) in enumerate(zip(chosen, items)):
                if results.get(item.out_wav):
                    log.warning("speech failed for %s: %s", cases[i].id, results[item.out_wav])
                    item.out_wav.unlink(missing_ok=True)
                    continue
                spec = _noise_for(rng) if augment and rng.random() < 0.5 else None
                if spec is not None:
                    samples, rate = read_wav(item.out_wav)
                    write_wav(item.out_wav, apply_noise(samples, spec, nprng), rate)
                cases[i].audio_path = f"audio/{cases[i].id}.wav"
                cases[i].voice = item.voice
                cases[i].noise = spec
                _tag_noise(cases[i], spec)
                n_audio += 1
                if k % 20 == 0:
                    report(0.83 + 0.12 * k / len(items), "post-processing audio")

    report(0.96, "writing dataset")
    (root / "world.json").write_text(world.model_dump_json(indent=1), encoding="utf-8")
    (root / "cases.jsonl").write_text("\n".join(c.model_dump_json() for c in cases) + "\n", encoding="utf-8")
    info = EvalDatasetInfo(
        id=name, name=name, created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), seed=seed,
        n_cases=len(cases), n_with_audio=n_audio, form_ids=sorted({c.form_id for c in cases}),
        tag_counts=dict(sorted(Counter(t for c in cases for t in c.tags).items())),
        splits=dict(Counter(c.split for c in cases)), synthetic=True)
    (root / "manifest.json").write_text(info.model_dump_json(indent=1), encoding="utf-8")
    report(1.0, f"dataset {name}: {info.n_cases} cases, {n_audio} with audio")
    return info


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(prog="backend.synth.build_dataset")
    ap.add_argument("--name", default="synth-v1")
    ap.add_argument("--cases", type=int, default=240)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--audio", action="store_true", help="synthesize speech (Windows voices)")
    ap.add_argument("--audio-limit", type=int, default=120, help="synthesize audio for at most N cases")
    ap.add_argument("--no-augment", action="store_true", help="keep all audio clean (no noise variants)")
    a = ap.parse_args(argv)
    info = build_dataset(a.name, a.cases, a.seed, a.audio, a.audio_limit, not a.no_augment,
                         progress=lambda f, m: print(f"[{f * 100:5.1f}%] {m}", flush=True))
    print(info.model_dump_json(indent=1))


if __name__ == "__main__":
    main()

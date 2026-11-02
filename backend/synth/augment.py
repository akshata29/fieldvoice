"""Audio degradation for the synthetic dataset: background noise at a target SNR, band-limiting, reverb.

Pure numpy (FFT filters), deterministic for a given ``numpy.random.Generator``. The kinds model what a truck cab, a
substation or a pole-top radio sound like; they approximate - they do not reproduce - real field audio.
"""
from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from backend.schemas.eval import NoiseSpec

RATE = 16000
NOISE_KINDS = ["white", "pink", "wind", "engine", "crackle", "radio", "muffled"]


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError(f"{path.name}: expected mono 16-bit PCM")
        rate, raw = w.getframerate(), w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0, rate


def write_wav(path: Path, samples: np.ndarray, rate: int = RATE) -> None:
    pcm = np.clip(samples, -1.0, 1.0)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((pcm * 32767.0).astype("<i2").tobytes())


def _speech_rms(x: np.ndarray, frame: int = 400) -> float:
    """RMS over active frames only (silence would otherwise make the requested SNR meaningless)."""
    n = len(x) // frame
    if n == 0:
        return float(np.sqrt(np.mean(x ** 2)) + 1e-9)
    frames = x[: n * frame].reshape(n, frame)
    energy = np.sqrt((frames ** 2).mean(axis=1))
    active = energy > 0.1 * energy.max() if energy.max() > 0 else energy > 0
    return float(np.sqrt((frames[active] ** 2).mean()) + 1e-9)


def _fft_filter(x: np.ndarray, rate: int, low: float | None = None, high: float | None = None) -> np.ndarray:
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1.0 / rate)
    mask = np.ones_like(freqs)
    if low is not None:
        mask[freqs < low] = 0.0
    if high is not None:
        mask[freqs > high] = 0.0
    return np.fft.irfft(spec * mask, n=len(x)).astype(np.float32)


def _white(n: int, rng: np.random.Generator) -> np.ndarray:
    return rng.standard_normal(n).astype(np.float32)


def _pink(n: int, rng: np.random.Generator) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1.0 / RATE)
    freqs[0] = freqs[1] if len(freqs) > 1 else 1.0
    return np.fft.irfft(spec / np.sqrt(freqs), n=n).astype(np.float32)


def _wind(n: int, rng: np.random.Generator) -> np.ndarray:
    base = _fft_filter(_white(n, rng), RATE, high=350.0)
    t = np.arange(n) / RATE
    gust = 0.55 + 0.45 * np.sin(2 * np.pi * rng.uniform(0.15, 0.5) * t + rng.uniform(0, 6.28))
    return (base * gust).astype(np.float32)


def _engine(n: int, rng: np.random.Generator) -> np.ndarray:
    t = np.arange(n) / RATE
    f0 = rng.uniform(40.0, 70.0)
    wobble = 1 + 0.01 * np.sin(2 * np.pi * rng.uniform(0.5, 2.0) * t)
    hum = sum(np.sin(2 * np.pi * f0 * k * wobble * t + rng.uniform(0, 6.28)) / k for k in range(1, 12))
    return (hum + 0.15 * _fft_filter(_white(n, rng), RATE, high=900.0)).astype(np.float32)


def _crackle(n: int, rng: np.random.Generator) -> np.ndarray:
    out = 0.05 * _white(n, rng)
    for pos in rng.integers(0, max(1, n - 200), size=max(1, n // 1600)):
        length = int(rng.integers(20, 160))
        out[pos:pos + length] += (rng.standard_normal(length) * np.exp(-np.arange(length) / (length / 4))).astype(np.float32) * 3
    return out.astype(np.float32)


_NOISE = {"white": _white, "pink": _pink, "wind": _wind, "engine": _engine, "crackle": _crackle}


def _reverb(x: np.ndarray, rng: np.random.Generator, rt60: float = 0.35) -> np.ndarray:
    length = int(RATE * rt60)
    ir = rng.standard_normal(length) * np.exp(-6.9 * np.arange(length) / length)
    ir[0] = 1.0
    wet = np.convolve(x, ir.astype(np.float32))[: len(x)]
    return (0.7 * x + 0.3 * wet / (np.abs(wet).max() + 1e-9) * np.abs(x).max()).astype(np.float32)


def apply_noise(x: np.ndarray, spec: NoiseSpec, rng: np.random.Generator) -> np.ndarray:
    """Return a degraded copy of ``x`` (float32, -1..1, 16 kHz). ``spec.kind == "none"`` only applies optional reverb."""
    y = x.astype(np.float32).copy()
    if spec.reverb:
        y = _reverb(y, rng)
    if spec.kind == "muffled":
        y = _fft_filter(y, RATE, high=2200.0)
    elif spec.kind == "radio":
        y = np.clip(1.6 * _fft_filter(y, RATE, low=350.0, high=3000.0), -0.6, 0.6)
    if spec.kind in _NOISE or spec.kind in ("radio", "muffled"):
        noise = _NOISE.get(spec.kind, _white)(len(y), rng)
        if spec.kind in ("radio", "muffled"):
            noise = noise * 0.5  # hiss/hum floor; the band-limiting is the main effect
        snr = spec.snr_db if spec.snr_db is not None else 15.0
        target = _speech_rms(y) / (10 ** (snr / 20.0))
        y = y + noise * (target / (float(np.sqrt(np.mean(noise ** 2))) + 1e-9))
    peak = float(np.abs(y).max())
    return (y * (0.95 / peak) if peak > 0.95 else y).astype(np.float32)


def measured_snr_db(clean: np.ndarray, noisy: np.ndarray) -> float:
    """SNR of ``noisy`` relative to ``clean`` (for tests), independent of any overall gain applied for peak limiting."""
    gain = float(np.dot(noisy, clean) / (np.dot(clean, clean) + 1e-12))
    added = noisy - gain * clean
    return float(20 * np.log10(_speech_rms(gain * clean) / (np.sqrt(np.mean(added ** 2)) + 1e-9)))

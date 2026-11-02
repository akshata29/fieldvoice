"""Speech synthesis for the synthetic dataset using the Windows voices (System.Speech / SAPI5) - no extra pip packages.

Batching matters: starting PowerShell costs ~2 s, so many utterances are synthesized per process from a JSON manifest.
Output is always 16 kHz mono PCM16 WAV (what Whisper-class engines and the Azure embedded recognizer expect).
Synthetic speech is clean and regular; it is a proxy for relative comparisons, not a substitute for field recordings.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
import tempfile
import wave
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


class TtsUnavailable(RuntimeError):
    """No usable text-to-speech voice on this machine (non-Windows, no SAPI voices, PowerShell missing)."""


@dataclass
class TtsItem:
    text: str
    out_wav: Path
    voice: str | None = None
    rate: int = 0  # SAPI rate -10..10


_PS_LIST = r"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }
"""

_PS_SPEAK = r"""
param([string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$items = Get-Content -Raw -Encoding UTF8 -LiteralPath $Manifest | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($it in $items) {
  try {
    if ($it.voice) { $synth.SelectVoice([string]$it.voice) }
    $synth.Rate = [int]$it.rate
    $synth.SetOutputToWaveFile([string]$it.out, $fmt)
    $synth.Speak([string]$it.text)
    $synth.SetOutputToNull()
    Write-Output ("OK`t" + $it.out)
  } catch {
    try { $synth.SetOutputToNull() } catch {}
    Write-Output ("ERR`t" + $it.out + "`t" + $_.Exception.Message)
  }
}
"""

_voices_cache: list[str] | None = None


def _powershell() -> str:
    exe = shutil.which("powershell") or shutil.which("powershell.exe")
    if sys.platform != "win32" or not exe:
        raise TtsUnavailable("text-to-speech needs Windows PowerShell with System.Speech (SAPI voices)")
    return exe


def list_voices(culture_prefix: str = "en-") -> list[str]:
    """Installed English voices (e.g. ``Microsoft David Desktop``). Raises ``TtsUnavailable`` when none."""
    global _voices_cache
    if _voices_cache is None:
        exe = _powershell()
        try:
            proc = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-Command", _PS_LIST], capture_output=True,
                                  text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise TtsUnavailable(f"could not query voices: {exc}") from exc
        found = [line.strip().split("|") for line in proc.stdout.splitlines() if "|" in line]
        _voices_cache = [name for name, culture in found if culture.lower().startswith(culture_prefix)]
    if not _voices_cache:
        raise TtsUnavailable("no English speech voices are installed")
    return list(_voices_cache)


def tts_available() -> bool:
    try:
        list_voices()
        return True
    except TtsUnavailable:
        return False


def synthesize_batch(items: list[TtsItem], on_item: Callable[[int, str | None], None] | None = None,
                     timeout_s: float = 900.0) -> dict[Path, str | None]:
    """Synthesize every item in one PowerShell process. Returns ``{out_wav: None | error message}``."""
    if not items:
        return {}
    exe = _powershell()
    results: dict[Path, str | None] = {it.out_wav: "not synthesized" for it in items}
    by_path = {str(it.out_wav): it for it in items}
    with tempfile.TemporaryDirectory(prefix="fv_tts_") as tmp:
        script, manifest = Path(tmp) / "speak.ps1", Path(tmp) / "manifest.json"
        script.write_text(_PS_SPEAK, encoding="utf-8")
        for it in items:
            it.out_wav.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps([
            {"text": it.text, "out": str(it.out_wav), "voice": it.voice, "rate": it.rate} for it in items]),
            encoding="utf-8")
        proc = subprocess.Popen(
            [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Manifest",
             str(manifest)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        done = 0
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                parts = line.rstrip("\r\n").split("\t")
                if parts[0] not in ("OK", "ERR") or len(parts) < 2 or parts[1] not in by_path:
                    continue
                path = Path(parts[1])
                results[path] = None if parts[0] == "OK" else (parts[2] if len(parts) > 2 else "synthesis failed")
                done += 1
                if on_item:
                    on_item(done, results[path])
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise TtsUnavailable("speech synthesis timed out") from None
    for path, err in results.items():
        if err is None and not _valid_wav(path):
            results[path] = "synthesis produced an invalid WAV file"
    return results


def _valid_wav(path: Path) -> bool:
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == 16000 and w.getnframes() > 0
    except (wave.Error, OSError, EOFError):
        return False


def synthesize(text: str, out_wav: Path, voice: str | None = None, rate: int = 0) -> str:
    """Synthesize one utterance; returns the voice used. Prefer ``synthesize_batch`` for more than a handful."""
    voice = voice or list_voices()[0]
    res = synthesize_batch([TtsItem(text, out_wav, voice, rate)])
    err = res[out_wav]
    if err:
        raise TtsUnavailable(err)
    return voice

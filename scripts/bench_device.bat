@echo off
rem Quick device probe (about a minute per engine): speech real-time factor, and the language-model call asked three ways.
rem Run this first on a new device, before the full matrix.
rem   scripts\bench_device.bat --stt foundry:stt:whisper-base:cpu --llm foundry:llm:qwen2.5-0.5b:cpu
rem   scripts\bench_device.bat --stt foundry:stt:nemotron-speech-streaming-en-0.6b:cpu --live   (wait after the last word)
rem   scripts\bench_device.bat --llm foundry:llm:phi-3.5-mini:cpu --repeats 7 --json data\bench-7220.json
setlocal
cd /d "%~dp0.."
".venv\Scripts\python.exe" -m backend.evalkit.bench %*

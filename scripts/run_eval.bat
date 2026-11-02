@echo off
rem Evaluation CLI. Examples:
rem   scripts\run_eval.bat engines
rem   scripts\run_eval.bat run --llm foundry:llm:qwen2.5-0.5b:cpu --strategy free_json --strategy hybrid --limit 60
rem   scripts\run_eval.bat run --stt foundry:stt:whisper-base:cpu --stt foundry:stt:nemotron-speech-streaming-en-0.6b:cpu --strategy rules_only
rem   scripts\run_eval.bat report <run_id>
rem   scripts\run_eval.bat rescore <run_id>      (re-score a past run's transcripts after changing the rules; no audio)
setlocal
cd /d "%~dp0.."
".venv\Scripts\python.exe" -m backend.evalkit.cli %*

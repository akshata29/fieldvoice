@echo off
rem Generate the synthetic datasets: synth-v1 (generated cases + TTS audio + noise variants, matches the UI's "Generate"
rem button) and demo-script (the hand-written lines used by the demo, 11 cases).
rem   scripts\build_dataset.bat                       -> synth-v1 (240 cases, audio for 120) + demo-script
rem   scripts\build_dataset.bat --cases 60 --audio-limit 20
setlocal
cd /d "%~dp0.."
".venv\Scripts\python.exe" -m backend.synth.build_dataset --name synth-v1 --cases 240 --seed 11 --audio --audio-limit 120 %*
if errorlevel 1 exit /b 1
".venv\Scripts\python.exe" -m backend.synth.demo_script

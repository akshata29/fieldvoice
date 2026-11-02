@echo off
rem Device-like mode: build the UI once and serve everything from ONE process on http://127.0.0.1:8010
rem Set FV_API_PORT first to use another port (for example set FV_API_PORT=8020) when 8010 is taken.
setlocal
cd /d "%~dp0.."
if "%FV_API_PORT%"=="" set FV_API_PORT=8010
if not exist ".venv\Scripts\python.exe" ( echo Run scripts\setup_backend.bat first. & exit /b 1 )
if not exist "data\datasets\demo-script\manifest.json" (
  echo Building the demo dataset ^(first run only^) ...
  ".venv\Scripts\python.exe" -m backend.synth.demo_script >nul
)
if not exist "frontend\dist\index.html" (
  pushd frontend
  if not exist node_modules ( call npm install || exit /b 1 )
  call npm run build || exit /b 1
  popd
)
rem open the browser a few seconds from now, once the server is listening
start "" /b cmd /c "ping -n 5 127.0.0.1 >nul & start http://127.0.0.1:%FV_API_PORT%"
echo FieldVoice: http://127.0.0.1:%FV_API_PORT%   (Ctrl+C to stop)
".venv\Scripts\python.exe" -m uvicorn backend.api.main:app --host 127.0.0.1 --port %FV_API_PORT%

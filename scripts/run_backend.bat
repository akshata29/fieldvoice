@echo off
rem Start the API on http://127.0.0.1:8010 (serves frontend\dist too when it has been built).
rem Set FV_API_PORT first to use another port.
setlocal
cd /d "%~dp0.."
if "%FV_API_PORT%"=="" set FV_API_PORT=8010
if not exist ".venv\Scripts\python.exe" ( echo Run scripts\setup_backend.bat first. & exit /b 1 )
".venv\Scripts\python.exe" -m uvicorn backend.api.main:app --host 127.0.0.1 --port %FV_API_PORT% %*

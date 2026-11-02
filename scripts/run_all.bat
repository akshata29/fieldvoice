@echo off
rem Developer mode: backend (:8010) and Vite dev server (:5173) in two windows. Set FV_API_PORT first to change the backend port.
setlocal
cd /d "%~dp0.."
if "%FV_API_PORT%"=="" set FV_API_PORT=8010
start "FieldVoice backend" cmd /k "%~dp0run_backend.bat"
start "FieldVoice frontend" cmd /k "%~dp0run_frontend.bat"
echo Backend: http://127.0.0.1:%FV_API_PORT%/docs     UI: http://localhost:5173

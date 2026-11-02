@echo off
rem Start the Vite dev server on http://localhost:5173 (proxies /api and /ws to the backend on :8010, or FV_API_PORT).
rem Pass "mock" to run against the in-browser mock API instead of the backend:  scripts\run_frontend.bat mock
setlocal
cd /d "%~dp0..\frontend"
if not exist node_modules ( call npm install || exit /b 1 )
if /i "%~1"=="mock" ( call npm run dev:mock ) else ( call npm run dev )

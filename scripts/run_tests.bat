@echo off
rem Run every automated check: backend tests (no network / no model download) + frontend typecheck, unit tests, build.
setlocal
cd /d "%~dp0.."
".venv\Scripts\python.exe" -m pytest -q %* || exit /b 1
pushd frontend
call npm run typecheck || exit /b 1
call npm test || exit /b 1
call npm run build || exit /b 1
popd
echo All checks passed.

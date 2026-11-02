@echo off
rem Create the Python venv and install backend dependencies (run once, needs internet).
setlocal
cd /d "%~dp0.."
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment .venv ...
  py -3.11 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 ( echo Could not create the venv. Install Python 3.11+ first. & exit /b 1 )
)
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
if errorlevel 1 exit /b 1
echo.
echo Backend ready. Optional engines (Azure Speech, ORT GenAI): see backend\requirements-optional.txt

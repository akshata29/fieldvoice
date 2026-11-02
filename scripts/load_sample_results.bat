@echo off
rem Copy the stored evaluation runs shipped in results\runs into data\runs, so they show up on the app's Results page.
rem Safe to repeat: the runs are immutable samples, copying them again just overwrites the same files.
setlocal
cd /d "%~dp0.."
if not exist "results\runs" ( echo results\runs not found. & exit /b 1 )
if not exist "data\runs" mkdir "data\runs"
xcopy "results\runs" "data\runs" /E /I /Y /Q >nul
if errorlevel 1 ( echo Copy failed. & exit /b 1 )
echo Copied the sample evaluation runs to data\runs. Start the app and open Results, then Runs.

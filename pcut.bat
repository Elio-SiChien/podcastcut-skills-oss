@echo off
rem pcut launcher: uses app\.venv made by install\install_windows.ps1, else the python on PATH
set PYTHONUTF8=1
set "PYTHONPATH=%~dp0app"
if exist "%~dp0app\.venv\Scripts\python.exe" (
  "%~dp0app\.venv\Scripts\python.exe" -m pcut %*
) else (
  python -m pcut %*
)

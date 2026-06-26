@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-agent-canvas.ps1" %*
if errorlevel 1 (
  echo.
  echo Agent Canvas dependency setup failed. Press any key to close this window.
  pause >nul
)

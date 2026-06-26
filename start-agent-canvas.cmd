@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-agent-canvas.ps1" %*
if errorlevel 1 (
  echo.
  echo Agent Canvas failed to start. Press any key to close this window.
  pause >nul
)

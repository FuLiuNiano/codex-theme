@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex-theme-controller.ps1" -Action Stop
endlocal

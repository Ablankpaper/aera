@echo off
setlocal
rem Forward to PowerShell so the signed Electron runtime inside Aera runs the collector.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-windows.ps1" %*
exit /b %ERRORLEVEL%

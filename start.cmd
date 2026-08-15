@echo off
REM Claude Session Switcher launcher.
REM Starts the server only if it is not already listening, then opens the browser.
setlocal
set PORT=7788

netstat -ano | findstr /R /C:"LISTENING" | findstr /C:":%PORT% " >nul 2>&1
if %errorlevel%==0 (
  echo Claude Session Switcher is already running on port %PORT%.
) else (
  echo Starting Claude Session Switcher...
  start "" /min /d "%~dp0" node server.js
  REM Absolute path: a "timeout" on PATH from Git/MSYS would shadow the Windows one.
  "%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul 2>&1
)

start "" http://localhost:%PORT%
endlocal

@echo off
REM Claude Session Manager launcher.
REM Starts the server only if it is not already listening, then opens the browser.
setlocal
set PORT=7788

netstat -ano | findstr /R /C:"LISTENING" | findstr /C:":%PORT% " >nul 2>&1
if %errorlevel%==0 (
  echo Already running on port %PORT%.
) else (
  echo Starting Claude Session Manager...
  start "" /min /d "%~dp0" node server.js
  REM Give the listener a moment before the browser races it.
  timeout /t 2 /nobreak >nul
)

start "" http://localhost:%PORT%
endlocal

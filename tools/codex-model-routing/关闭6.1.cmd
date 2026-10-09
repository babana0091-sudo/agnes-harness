@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo Copy the tool files beside agnes-win32-x64.exe first.
  pause
  exit /b 1
)
"runtime\node.exe" "agnes-model-routing.mjs" --off
set "agnesRoutingExit=%errorlevel%"
pause
exit /b %agnesRoutingExit%

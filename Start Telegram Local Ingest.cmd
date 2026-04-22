@echo off
setlocal

set "PROJECT=/home/tony/workspace/telegram-local-ingest"

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo wsl.exe was not found. Install or enable WSL first.
  pause
  exit /b 1
)

echo Starting Telegram Local Bot API Server and telegram-local-ingest worker...
echo Project: %PROJECT%
echo.

wsl.exe bash -lc "cd %PROJECT% && bash scripts/local-stack-status.sh"
set "STACK_STATUS=%ERRORLEVEL%"
echo.

if "%STACK_STATUS%"=="0" (
  echo The local ingest stack is already running.
  set /p "ANSWER=Stop it now? [y/N] "
  if /I "%ANSWER%"=="Y" (
    echo.
    wsl.exe bash -lc "cd %PROJECT% && bash scripts/stop-local-stack.sh"
    echo.
    echo Done. The stack stop command has finished.
    pause
    exit /b %ERRORLEVEL%
  )
  echo.
  echo Keeping the current stack running.
  pause
  exit /b 0
)

if "%STACK_STATUS%"=="2" (
  echo The local ingest stack appears to be partially running.
  set /p "ANSWER=Stop managed processes now? [y/N] "
  if /I "%ANSWER%"=="Y" (
    echo.
    wsl.exe bash -lc "cd %PROJECT% && bash scripts/stop-local-stack.sh"
    echo.
    echo Done. The stack stop command has finished.
    pause
    exit /b %ERRORLEVEL%
  )
  echo.
  echo Continuing with startup.
  echo.
)

wsl.exe bash -lc "cd %PROJECT% && bash scripts/start-local-stack.sh"

echo.
echo Done. The stack runs in WSL background processes.
echo Logs are under /home/tony/workspace/telegram-local-ingest/runtime/logs.
echo Run this launcher again to stop it, or run scripts/stop-local-stack.sh in WSL.
pause

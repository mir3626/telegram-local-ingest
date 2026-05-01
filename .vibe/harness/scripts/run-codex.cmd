@echo off
setlocal EnableExtensions EnableDelayedExpansion

chcp 65001 >nul 2>&1

if "%~1"=="--health"  goto :health
if "%~1"=="--version" goto :health
if "%~1"=="--help"    goto :usage
if "%~1"=="-h"        goto :usage

set "CODEX_SANDBOX_OPT=workspace-write"
if not "%CODEX_SANDBOX%"=="" set "CODEX_SANDBOX_OPT=%CODEX_SANDBOX%"

set "MAX_ATTEMPTS=3"
if not "%CODEX_RETRY%"=="" set "MAX_ATTEMPTS=%CODEX_RETRY%"

set "MODEL_LABEL=default"
if not "%CODEX_MODEL%"=="" set "MODEL_LABEL=%CODEX_MODEL%"
set "MODEL_ARG="
if not "%CODEX_MODEL%"=="" set "MODEL_ARG=-m %CODEX_MODEL%"
set "SCRIPT_DIR=%~dp0"
set "_start_iso="
for /f "usebackq tokens=*" %%I in (`node -e "process.stdout.write(new Date().toISOString())" 2^>nul`) do set "_start_iso=%%I"

set /a _attempt=0

:attempt_loop
set /a _attempt+=1
>&2 echo [run-codex] attempt !_attempt!/%MAX_ATTEMPTS% starting (sandbox=%CODEX_SANDBOX_OPT%, model=!MODEL_LABEL!)
call codex exec -s %CODEX_SANDBOX_OPT% %MODEL_ARG% %*
set "_rc=%ERRORLEVEL%"

if !_rc! EQU 0 goto :done_ok
if !_attempt! GEQ %MAX_ATTEMPTS% goto :done_fail

set /a _delay=!_attempt! * 30
>&2 echo [run-codex] attempt !_attempt!/%MAX_ATTEMPTS% retrying reason=exit=!_rc! delay=!_delay!s
timeout /t !_delay! /nobreak >nul
goto :attempt_loop

:done_ok
>&2 echo [run-codex] total attempts=!_attempt!
if "%VIBE_SPRINT_ID%"=="" (
  >&2 echo [run-codex] status-tick: skipped reason=no-sprint
) else (
  if defined _start_iso (
    node "%SCRIPT_DIR%vibe-status-tick.mjs" --add-tokens 0 --sprint "%VIBE_SPRINT_ID%" --elapsed-start "!_start_iso!" >nul 2>nul
  ) else (
    node "%SCRIPT_DIR%vibe-status-tick.mjs" --add-tokens 0 --sprint "%VIBE_SPRINT_ID%" >nul 2>nul
  )
  if errorlevel 1 >&2 echo [run-codex] status-tick: skipped reason=cli-failed
  if not errorlevel 1 >&2 echo [run-codex] status-tick: ticked tokens=0 sprint=%VIBE_SPRINT_ID%
)
call :attention_event info "Codex run completed" "Codex exec completed after !_attempt! attempt(s)." codex-wrapper
endlocal & exit /b 0

:done_fail
>&2 echo [run-codex] giving up after !_attempt! attempts last_exit=!_rc!
call :attention_event urgent "Codex run failed" "Codex exec failed after !_attempt! attempt(s), exit=!_rc!." codex-wrapper
endlocal & exit /b !_rc!

:health
where codex >nul 2>&1
if errorlevel 1 (
  >&2 echo run-codex: codex CLI not found in PATH
  endlocal & exit /b 1
)

set "_first="
rem Auth/config failures may also land here with rc=3 because cmd.exe health checks
rem do not have the bounded timeout/auth heuristics used by run-codex.sh.
for /f "delims=" %%I in ('call codex --version 2^>^&1') do (
  if not defined _first set "_first=%%I"
)

if not defined _first (
  >&2 echo run-codex: codex --version returned no output
  endlocal & exit /b 3
)

echo !_first! | findstr /r "[0-9][.][0-9]" >nul 2>nul
if errorlevel 1 (
  >&2 echo run-codex: codex --version failed: !_first!
  endlocal & exit /b 3
)

set "_version=!_first!"
if /i "!_version:~0,10!"=="codex-cli " set "_version=!_version:~10!"
if /i "!_version:~0,6!"=="codex " set "_version=!_version:~6!"
echo codex-cli !_version!
endlocal & exit /b 0

:usage
echo Usage:
echo   run-codex.cmd --health^|--version^|--help
echo   type prompt.txt ^| run-codex.cmd -
echo   run-codex.cmd "prompt text"
endlocal & exit /b 0

:attention_event
if "%VIBE_DISABLE_ATTENTION%"=="1" exit /b 0
if not exist "%SCRIPT_DIR%vibe-attention.mjs" exit /b 0
where node >nul 2>&1
if errorlevel 1 exit /b 0
node "%SCRIPT_DIR%vibe-attention.mjs" --severity "%~1" --title "%~2" --detail "%~3" --source "%~4" --provider codex >nul 2>nul
exit /b 0

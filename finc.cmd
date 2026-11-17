@echo off
rem finc CLI launcher. While the Docker worker runs, database commands run inside the container
rem (two writers across the Docker Desktop file boundary corrupted SQLite once). `spike` stays on the host.
setlocal
rem docker and node are found on PATH only, never in the current folder, so a planted docker.bat or node.exe there
rem cannot run (security research P3-01).
set "NoDefaultCurrentDirectoryInExePath=1"
rem `backup restore` always runs on the host and refuses while the worker container runs.
set "CMD1=%~1"
set "CMD2=%~2"
set "RESTORE="
set "RUNNING="
if /i "%CMD1%"=="backup" if /i "%CMD2%"=="restore" set "RESTORE=1"
if /i "%CMD1%"=="spike" goto host
if not defined RESTORE if defined FINC_HOST goto host
for /f "delims=" %%n in ('docker ps --filter "name=^finc-worker$" --filter "status=running" --format "{{.Names}}" 2^>nul') do set "RUNNING=%%n"
if "%RUNNING%"=="finc-worker" (
  if defined RESTORE (
    echo stop the worker first: docker compose stop worker
    exit /b 1
  )
  rem `mcp` (not `mcp token`) is an AI app's MCP server: JSON-RPC on stdin/stdout, so no TTY (-T)
  if /i "%CMD1%"=="mcp" if /i not "%CMD2%"=="token" (
    docker compose -f "%~dp0docker-compose.yml" exec -T worker node apps/worker/dist/cli.js %*
    exit /b %ERRORLEVEL%
  )
  docker compose -f "%~dp0docker-compose.yml" exec -it worker node apps/worker/dist/cli.js %*
  exit /b %ERRORLEVEL%
)
:host
if not exist "%~dp0apps\worker\dist\cli.js" (
  echo finc is not built yet. Run: pnpm -r build
  exit /b 1
)
rem A host run always works on this project's data folder, whatever the current directory.
if not defined FINC_DATA_DIR set "FINC_DATA_DIR=%~dp0data"
node "%~dp0apps\worker\dist\cli.js" %*

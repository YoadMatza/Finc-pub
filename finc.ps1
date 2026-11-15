# finc CLI launcher for PowerShell.
#
# While the Docker worker is running, every command that touches the database runs INSIDE the
# container (docker compose exec), never against the bind-mounted SQLite file from the host:
# two writers across the Docker Desktop file-sharing boundary corrupted the database once
# (2026-11-09). Only `spike` (needs a browser window on this screen) runs on the host; it opens
# no database. Pass FINC_HOST=1 to force a host run when the worker is stopped.
# Since P1-13 the code enforces this too: the worker keeps a heartbeat in data/finc.db.owner, and any process on
# another machine (this PC, while the worker runs in Docker) that opens the database is refused.
# `backup restore` always runs on the host and refuses while the worker container runs.
$cli = Join-Path $PSScriptRoot 'apps\worker\dist\cli.js'
$hostOnly = @('spike')
$isRestore = $args.Count -ge 2 -and $args[0] -eq 'backup' -and $args[1] -eq 'restore'
$inContainer = $false
if ($isRestore -or (-not $env:FINC_HOST -and $args.Count -gt 0 -and $hostOnly -notcontains $args[0])) {
  $running = (& docker ps --filter 'name=^finc-worker$' --filter 'status=running' --format '{{.Names}}' 2>$null)
  if ($running -eq 'finc-worker') {
    if ($isRestore) {
      Write-Host 'stop the worker first: docker compose stop worker' -ForegroundColor Red
      exit 1
    }
    $inContainer = $true
  }
}
if ($inContainer) {
  # FINC_HOST_DATA_DIR: where the container's /data is on this PC, for commands that print a path to a file they wrote
  & docker compose -f (Join-Path $PSScriptRoot 'docker-compose.yml') exec -it -e "FINC_HOST_DATA_DIR=$(Join-Path $PSScriptRoot 'data')" worker node apps/worker/dist/cli.js @args
  exit $LASTEXITCODE
}
if (-not (Test-Path $cli)) {
  Write-Error 'finc is not built yet. Run: pnpm -r build'
  exit 1
}
if (-not $env:FINC_HOST -and $args.Count -gt 0 -and $hostOnly -notcontains $args[0]) {
  Write-Host 'note: the Docker worker is not running; using the database directly from this machine.' -ForegroundColor DarkGray
}
# A host run always works on this project's data folder, whatever the current directory (a restore started
# from another folder must not land in <cwd>\data).
if (-not $env:FINC_DATA_DIR) { $env:FINC_DATA_DIR = Join-Path $PSScriptRoot 'data' }
& node $cli @args
exit $LASTEXITCODE

#!/usr/bin/env bash
# finc CLI launcher for Linux and macOS (the Raspberry Pi included); finc.ps1 / finc.cmd are the Windows ones.
#
# While the Docker worker is running, every command that touches the database runs INSIDE the container
# (docker compose exec), never against the bind-mounted SQLite file from the host: two writers on one SQLite file can
# corrupt it. Only `spike` (needs a browser window on this screen) runs on the host; it opens no database.
# Set FINC_HOST=1 to force a host run when the worker is stopped. `backup restore` always runs on the host and refuses
# while the worker container runs. A host run needs the build (pnpm -r build) and Node on the PATH.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli="$root/apps/worker/dist/cli.js"

restore=0
if [ "$#" -ge 2 ] && [ "$1" = "backup" ] && [ "$2" = "restore" ]; then restore=1; fi

in_container=0
if [ "$restore" = 1 ] || { [ -z "${FINC_HOST:-}" ] && [ "$#" -gt 0 ] && [ "$1" != "spike" ]; }; then
  running="$(docker ps --filter 'name=^finc-worker$' --filter 'status=running' --format '{{.Names}}' 2>/dev/null || true)"
  if [ "$running" = "finc-worker" ]; then
    if [ "$restore" = 1 ]; then
      echo 'stop the worker first: docker compose stop worker' >&2
      exit 1
    fi
    in_container=1
  fi
fi

if [ "$in_container" = 1 ]; then
  # -it only with a terminal (prompts for passwords need one); -T when piped or run from a script
  if [ -t 0 ] && [ -t 1 ]; then tty=(-it); else tty=(-T); fi
  # FINC_HOST_DATA_DIR: where the container's /data is on this machine, for commands that print a path to a file
  exec docker compose -f "$root/docker-compose.yml" exec "${tty[@]}" -e "FINC_HOST_DATA_DIR=$root/data" \
    worker node apps/worker/dist/cli.js "$@"
fi

if [ ! -f "$cli" ]; then
  echo 'finc is not built yet. Run: pnpm -r build' >&2
  exit 1
fi
if [ -z "${FINC_HOST:-}" ] && [ "$#" -gt 0 ] && [ "$1" != "spike" ]; then
  echo 'note: the Docker worker is not running; using the database directly from this machine.' >&2
fi
# A host run always works on this project's data folder, whatever the current directory.
export FINC_DATA_DIR="${FINC_DATA_DIR:-$root/data}"
exec node "$cli" "$@"

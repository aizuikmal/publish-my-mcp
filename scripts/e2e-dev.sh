#!/usr/bin/env bash
# Boots the publish.my app (DEV_MODE, temp DB/storage/sites, mail to stdout) and runs
# scripts/e2e-dev.mjs against it with an isolated HOME. Needs a publish-my checkout.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${PUBLISHMY_REPO:-$HOME/projects/publish-my}/app"
W="$(mktemp -d)"; PORT="${PORT:-8794}"
mkdir -p "$W/home"
( cd "$APP" && exec env DEV_MODE=1 DB_PATH="$W/app.db" STORAGE_DRIVER=local STORAGE_LOCAL_DIR="$W/storage" \
  SITES_DRIVER=local SITES_LOCAL_DIR="$W/sites" MAIL_DRIVER=stdout PORT="$PORT" \
  node src/server.js >"$W/log" 2>&1 ) &
SV=$!; trap 'kill $SV 2>/dev/null; rm -rf "$W"' EXIT
for i in $(seq 1 50); do curl -sf -o /dev/null "http://localhost:$PORT/v1/health" && break; sleep 0.2; done
PM_BASE="http://localhost:$PORT" PM_LOG="$W/log" PM_SITES="$W/sites" HOME="$W/home" \
  node "$HERE/e2e-dev.mjs"; rc=$?
[ $rc -ne 0 ] && { echo "--- server log (tail)"; tail -30 "$W/log"; }
exit $rc

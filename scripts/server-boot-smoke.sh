#!/usr/bin/env bash
# Boot a built server command and wait for it to become healthy.
#
#   scripts/server-boot-smoke.sh node server/dist-runtime/index.mjs
#
# Starts the command against a throwaway instance (embedded Postgres,
# local_trusted mode, loopback only) and waits until GET /api/health reports
# status "ok", which means migrations applied and startup recovery finished.
# Prints the time to listen and the time to ready, stops the server, and exits
# non-zero if it never became ready, with the server log on stderr.
#
# The server runs with a cleared environment (only PATH and a scratch HOME),
# from a scratch working directory, with its config path pointed into the
# scratch directory, so no DATABASE_URL, config file or .env from the caller
# can point it at a real instance. It listens on a free port chosen at start,
# and a healthy response counts only after the child logs that it bound that
# port. Relative command arguments are resolved against the repository root.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
port="${SMOKE_PORT:-$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})')}"
timeout_seconds="${SMOKE_TIMEOUT_SECONDS:-180}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-boot-smoke.XXXXXX")"
log="$scratch/server.log"

args=()
for arg in "$@"; do
  if [ -e "$repo_root/$arg" ]; then args+=("$repo_root/$arg"); else args+=("$arg"); fi
done

server_pid=""
cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$server_pid" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

started_ms=$(node -e 'console.log(Date.now())')
(
  cd "$scratch"
  exec env -i \
    PATH="$PATH" \
    HOME="$scratch" \
    NODE_ENV=production \
    PAPERCLIP_CONFIG="$scratch/config.json" \
    PAPERCLIP_HOME="$scratch/home" \
    PAPERCLIP_INSTANCE_ID=boot-smoke \
    PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
    PAPERCLIP_MIGRATION_AUTO_APPLY=true \
    HOST=127.0.0.1 \
    PORT="$port" \
    SERVE_UI=false \
    "${args[@]}"
) >"$log" 2>&1 &
server_pid=$!

listen_ms=""
deadline=$(( $(date +%s) + timeout_seconds ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "FAIL: server exited before becoming ready" >&2
    cat "$log" >&2
    exit 1
  fi
  # Only trust the port once this child has bound it.
  if ! grep -q "listener bound on 127.0.0.1:$port" "$log" 2>/dev/null; then sleep 0.5; continue; fi
  body="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)"
  if [ -n "$body" ] && [ -z "$listen_ms" ]; then
    listen_ms=$(node -e 'console.log(Date.now())')
  fi
  if printf '%s' "$body" | grep -q '"status":"ok"'; then
    ready_ms=$(node -e 'console.log(Date.now())')
    echo "boot smoke ok: listening after $(( listen_ms - started_ms )) ms, ready after $(( ready_ms - started_ms )) ms"
    exit 0
  fi
  sleep 0.5
done

echo "FAIL: /api/health did not report ok within ${timeout_seconds}s" >&2
echo "last response: ${body:-<none>}" >&2
cat "$log" >&2
exit 1

#!/usr/bin/env bash
# Local end-to-end gate for the hosted tenant-memory path (TECH-7126 / TECH-7142).
#
# Runs a built Paperclip image the way the hosted deployment runs it and proves, with a real Hermes,
# real mem0 and real provider keys:
#   1. an allowlisted company can write a memory and a fresh run (a different agent) can recall it;
#   2. the recall survives destroying and recreating the Paperclip container (Postgres volume kept);
#   3. a company that is not allowlisted gets no runtime memory and cannot see the marker;
#   4. the tenant database/role boundary holds and no secret value reaches the logs.
#
# Usage:
#   IMAGE=<image ref or digest ref> scripts/e2e-hosted-memory-local.sh              # allowlist scope (default)
#   IMAGE=<image ref or digest ref> E2E_SCOPE=all scripts/e2e-hosted-memory-local.sh  # universal scope
#
# E2E_SCOPE=all (PAPERCLIP_MEMORY_COMPANY_SCOPE=all, no pilot list) proves the universal path: neither company
# is listed anywhere, no database exists until a company's first memory use (lazy), and then BOTH companies get
# their own provisioned database + role. Company A writes a marker and a fresh agent in A recalls it; company B
# writes its own marker and a fresh agent in B recalls it; neither fresh reader's task text contains any marker,
# and neither company sees the other's marker. Agents in BOTH scopes run with `toolsets: memory`, which in the
# pinned Hermes (0.21.3) resolves to the single built-in `memory` tool plus the mem0 provider tools -- no terminal,
# file, web or Paperclip-API tool -- so a recall cannot be answered from the writer's issue or run logs. The
# traces are checked per run for TYPED Hermes logger records (`tool mem0_add completed (...)` on the write run,
# `tool mem0_search completed (...)` on each fresh read run; agents run with the existing `verbose` flag so the
# records reach the run log) and the tenant database is checked for the marker. Every wait is bounded by wall
# clock and every HTTP/AWS/docker call has a cap (overshoot at most a couple of seconds). Hosted/shared databases: check only the ids and names this script owns.
#
# Provider keys (never printed, never written outside a mode-0700 work dir that is deleted on exit):
#   TEST_ANTHROPIC_API_KEY / TEST_OPENAI_API_KEY      the key values, or
#   E2E_ANTHROPIC_SSM / E2E_OPENAI_SSM                SSM parameter names (uses `aws ssm get-parameter`,
#                                                     honours AWS_PROFILE / AWS_REGION)
#
# Optional: PORT (default 3131), E2E_PG_IMAGE (default pgvector/pgvector:pg17), E2E_KEEP=1 (keep containers and work dir for debugging -- never use it for the approved real-key gate; the work dir then
# holds credentials, delete it yourself), E2E_WAIT_RUN_SECONDS (per-run timeout, default 600),
# E2E_HEALTH_SECONDS (default 240).
#
# Requirements: Docker CLI 20.10+ (`docker exec --env-file`), curl, python3, openssl, and `aws` only when keys
# come from SSM. The Paperclip port is published on 127.0.0.1 only: the instance holds real provider keys.
#
# Two checks match literal text the server/Hermes print ("with runtime memory", the pino `inspectability`
# field). Each is paired: company A must show the memory line while company B must not, and the final
# container must say "protected" while no container may say "inspectable". If the wording changes, the
# positive check fails, so a negative check cannot silently pass by never matching.
#
# The image must be the one you intend to ship. For a linux/amd64 image on an arm64 host this runs under
# emulation and is slow; iterate on a native build first, then run the shipping image once.
set -euo pipefail

IMAGE="${IMAGE:?set IMAGE to the image reference to test}"
PORT="${PORT:-3131}"
SCOPE="${E2E_SCOPE:-allowlist}"
case "$SCOPE" in allowlist|all) ;; *) echo "E2E_SCOPE must be 'allowlist' or 'all'" >&2; exit 2;; esac
WAIT_RUN="${E2E_WAIT_RUN_SECONDS:-600}"
WAIT_HEALTH="${E2E_HEALTH_SECONDS:-240}"
SUFFIX="$$"
PG_NAME="e2e-mem-pg-$SUFFIX"
APP_NAME="e2e-mem-app-$SUFFIX"
PG_VOL="e2e-mem-pgdata-$SUFFIX"
HOME_VOL="e2e-mem-home-$SUFFIX"
PG_IMAGE="${E2E_PG_IMAGE:-pgvector/pgvector:pg17}"
BASE="http://localhost:$PORT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/e2e-hosted-memory.XXXXXX")"
chmod 700 "$WORK"
umask 077
cd "$WORK"

FAILURES=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }

cleanup() {
  local code=$?
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    echo "E2E_KEEP=1: containers $PG_NAME $APP_NAME and work dir $WORK kept. The work dir holds credentials; delete it."
    return
  fi
  docker rm -f "$APP_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$PG_VOL" "$HOME_VOL" >/dev/null 2>&1 || true
  cd / && rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 2; }; }
need docker; need curl; need python3; need openssl

# ---- secrets: from env or SSM, kept in one 0600 file, never echoed ------------------------------------
# >>> testable:bounded-ssm
# bounded <seconds> <cmd...>: run cmd in its own process group with a wall-clock cap; on timeout (or SIGTERM
# to this script's call) the WHOLE group is killed. Exit 124 = timed out. stdin/stdout/stderr pass through.
# Uses the python3 this script already requires (no GNU `timeout` on macOS).
bounded() {
  python3 -c '
import os, signal, subprocess, sys
try:
    p = subprocess.Popen(sys.argv[2:], start_new_session=True)
except OSError:
    sys.exit(127)
def kill_group():
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
def on_term(signum, _frame):
    kill_group()
    sys.exit(128 + signum)
signal.signal(signal.SIGTERM, on_term)
try:
    sys.exit(p.wait(timeout=float(sys.argv[1])))
except subprocess.TimeoutExpired:
    kill_group()
    p.wait()
    sys.exit(124)
except KeyboardInterrupt:
    kill_group()
    sys.exit(130)
' "$@"
}
# ssm_value <parameter-name>: prints the value on stdout ONLY (capture it into a variable, never a pipe or
# a terminal). Native AWS CLI bounds (connect/read timeouts + AWS_MAX_ATTEMPTS/AWS_RETRY_MODE) plus a
# wall-clock cap (E2E_AWS_CAP_SECONDS, default 45). On ANY failure it prints one FIXED code to stderr and
# returns 1: AWS stderr and parameter contents are never printed.
ssm_value() {
  local v rc=0
  v="$(AWS_MAX_ATTEMPTS=2 AWS_RETRY_MODE=standard bounded "${E2E_AWS_CAP_SECONDS:-45}" aws --cli-connect-timeout 5 --cli-read-timeout 20 \
    ssm get-parameter --with-decryption --name "$1" --query Parameter.Value --output text 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$v" ] || [ "$v" = None ]; then
    if [ "$rc" = 124 ]; then echo "SSM read failed (code=ssm_timeout)" >&2; else echo "SSM read failed (code=ssm_unavailable)" >&2; fi
    return 1
  fi
  printf '%s' "$v"
}
# <<< testable:bounded-ssm
ANTHROPIC_KEY="${TEST_ANTHROPIC_API_KEY:-}"
OPENAI_KEY="${TEST_OPENAI_API_KEY:-}"
if [ -z "$ANTHROPIC_KEY" ] && [ -n "${E2E_ANTHROPIC_SSM:-}" ]; then need aws; ANTHROPIC_KEY="$(ssm_value "$E2E_ANTHROPIC_SSM")" || exit 2; fi
if [ -z "$OPENAI_KEY" ] && [ -n "${E2E_OPENAI_SSM:-}" ]; then need aws; OPENAI_KEY="$(ssm_value "$E2E_OPENAI_SSM")" || exit 2; fi
if [ -z "$ANTHROPIC_KEY" ] || [ -z "$OPENAI_KEY" ]; then
  echo "provider keys missing: set TEST_ANTHROPIC_API_KEY/TEST_OPENAI_API_KEY or E2E_ANTHROPIC_SSM/E2E_OPENAI_SSM" >&2
  exit 2
fi
AUTH_SECRET="$(openssl rand -hex 32)"
MASTER_KEY="$(openssl rand -hex 32)"
PG_PW="$(openssl rand -hex 16)"
ADMIN_PW="$(openssl rand -hex 16)"
MARKER="MK-$(openssl rand -hex 8)"
MARKER_B="MK-$(openssl rand -hex 8)"   # E2E_SCOPE=all only: company B's own marker
# Secrets reach the leak scan through the environment, never argv (argv is visible in `ps`).
export E2E_ANTHROPIC_KEY="$ANTHROPIC_KEY" E2E_OPENAI_KEY="$OPENAI_KEY" E2E_PG_PW="$PG_PW" E2E_ADMIN_PW="$ADMIN_PW" E2E_AUTH_SECRET="$AUTH_SECRET" E2E_MASTER_KEY="$MASTER_KEY"

# ---- Postgres in the AWS-RDS shape ---------------------------------------------------------------------
# template0 keeps nominal PUBLIC CONNECT but datallowconn=false (the shape that broke the old preflight);
# vector lives in template1; PUBLIC CONNECT is revoked elsewhere; the memory admin is not a superuser.
docker volume create "$PG_VOL" >/dev/null
docker volume create "$HOME_VOL" >/dev/null
docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PG_PW" -v "$PG_VOL:/var/lib/postgresql/data" \
  --entrypoint sh "$PG_IMAGE" -c '
set -e
mkdir -p /certs
openssl req -new -x509 -nodes -days 2 -subj "/CN=e2e-mem-pg" -keyout /certs/k.pem -out /certs/c.pem 2>/dev/null
chown postgres:postgres /certs/*.pem && chmod 600 /certs/k.pem
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/c.pem -c ssl_key_file=/certs/k.pem' >/dev/null
for _ in $(seq 1 60); do
  bounded 10 docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && sleep 2 && break
  sleep 1
done
PSQL() { bounded 120 docker exec -i -e PGPASSWORD="$PG_PW" "$PG_NAME" psql -U postgres -v ON_ERROR_STOP=1 -q; }
PSQL <<SQL
CREATE DATABASE paperclip;
\c template1
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
\c postgres
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE paperclip FROM PUBLIC;
CREATE ROLE pcadmin LOGIN CREATEDB CREATEROLE PASSWORD '$ADMIN_PW';
GRANT CONNECT ON DATABASE postgres TO pcadmin;
SQL
PG_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG_NAME")"
[ -n "$PG_IP" ] || { echo "could not determine Postgres container IP" >&2; exit 2; }
echo "postgres ready (RDS-shaped) at $PG_IP"

# ---- Paperclip container -------------------------------------------------------------------------------
# Every app container's output is appended here before the container is removed, so the leak scan covers
# bootstrap, sign-up and secret creation as well as the final container.
snap_logs() { bounded 60 docker logs "$APP_NAME" >> server-all.log 2>&1 || true; }

start_server() { # $1 = comma separated pilot company ids; empty = memory disabled; "all" = universal scope
  local pilot="${1:-}"
  snap_logs
  docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
  {
    echo "PORT=3100"; echo "HOST=0.0.0.0"; echo "PAPERCLIP_BIND=lan"; echo "PAPERCLIP_HOME=/paperclip"
    echo "PAPERCLIP_DEPLOYMENT_MODE=authenticated"; echo "PAPERCLIP_DEPLOYMENT_EXPOSURE=private"
    echo "PAPERCLIP_AUTH_PUBLIC_BASE_URL=$BASE"; echo "PAPERCLIP_PUBLIC_URL=$BASE"
    # Better Auth derives trusted origins from the allowed hostnames plus the *listen* port, so the
    # published host port has to be listed explicitly.
    echo "PAPERCLIP_ALLOWED_HOSTNAMES=localhost,localhost:$PORT,127.0.0.1"
    # Must be reachable from inside the container: Hermes preflights the runtime MCP endpoint on it.
    echo "PAPERCLIP_API_URL=http://127.0.0.1:3100"
    echo "PAPERCLIP_MIGRATION_AUTO_APPLY=true"; echo "PAPERCLIP_AUTH_DISABLE_SIGN_UP=false"
    echo "DATABASE_URL=postgres://postgres:$PG_PW@$PG_IP:5432/paperclip?sslmode=require"
    echo "BETTER_AUTH_SECRET=$AUTH_SECRET"; echo "PAPERCLIP_SECRETS_MASTER_KEY=$MASTER_KEY"
    if [ -n "$pilot" ]; then
      echo "PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED=true"
      echo "PAPERCLIP_MEMORY_ADMIN_DATABASE_URL=postgres://pcadmin:$ADMIN_PW@$PG_IP:5432/postgres?sslmode=require"
      if [ "$pilot" = all ]; then
        echo "PAPERCLIP_MEMORY_COMPANY_SCOPE=all"
      else
        echo "PAPERCLIP_MEMORY_PILOT_COMPANIES=$pilot"
      fi
    fi
  } > app.env
  docker run -d --name "$APP_NAME" -p "127.0.0.1:$PORT:3100" --env-file app.env -v "$HOME_VOL:/paperclip" "$IMAGE" >/dev/null
  wait_healthy || { echo "server not healthy after ${WAIT_HEALTH}s (container log output withheld)" >&2; exit 1; }
}

# >>> testable:http
# Every curl has a connect timeout and a --max-time (API_MAX_TIME, default 30s); wait loops below pass the
# REMAINING wall-clock budget, so no single call can outlive the deadline it serves.
# HTTP errors are rejected (-f): no error body is ever read, echoed or parsed for an id. api never fails the
# pipeline; a failed call yields empty output, which jid/must turn into a fixed code-only error.
api() { # method path [json]
  local m="$1" p="$2" b="${3:-}"
  # The body goes over stdin: request bodies carry provider keys and argv is visible in `ps`.
  if [ -n "$b" ]; then
    printf '%s' "$b" | curl -sf --connect-timeout 5 --max-time "${API_MAX_TIME:-30}" -X "$m" -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $BASE" "$BASE$p" --data-binary @- || true
  else
    curl -sf --connect-timeout 5 --max-time "${API_MAX_TIME:-30}" -X "$m" -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $BASE" "$BASE$p" || true
  fi
}
# jid [field...]: print the first of the named fields (default: id) that is a UUID, else the fixed code
# ERR:invalid_response. The response body is never echoed.
jid() { python3 -c '
import sys, json, re
fields = sys.argv[1:] or ["id"]
try:
    d = json.load(sys.stdin)
except Exception:
    d = None
uuid = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
for f in fields:
    v = d.get(f) if isinstance(d, dict) else None
    if isinstance(v, str) and uuid.fullmatch(v):
        print(v)
        sys.exit(0)
print("ERR:invalid_response")' "$@"; }
must() { case "$1" in ERR*|"") echo "API call failed (no valid id in the response; body withheld)" >&2; exit 1;; esac; }

# wait_healthy: poll /api/health until E2E_HEALTH_SECONDS of WALL CLOCK ($SECONDS) have passed. Each probe is
# capped by the remaining time (max 5s) and the sleep never exceeds it, so the overshoot is at most ~2s
# (curl --max-time and $SECONDS both have 1s resolution).
wait_healthy() {
  local deadline=$((SECONDS + WAIT_HEALTH)) rem
  while :; do
    rem=$((deadline - SECONDS)); [ "$rem" -gt 0 ] || return 1
    [ "$rem" -le 5 ] || rem=5
    curl -fs --connect-timeout 2 --max-time "$rem" "$BASE/api/health" >/dev/null 2>&1 && return 0
    rem=$((deadline - SECONDS)); [ "$rem" -gt 0 ] || return 1
    sleep $((rem < 3 ? rem : 3))
  done
}

# poll_run <run-id> <label>: prints the run's terminal status code, or the last seen non-terminal code
# ("unknown" if none) once E2E_WAIT_RUN_SECONDS of wall clock have passed. Saves run-<label>.json. Each GET is
# capped by the remaining time (max 30s); overshoot is at most ~2s.
poll_run() {
  local run="$1" label="$2" deadline=$((SECONDS + WAIT_RUN)) rem st=unknown
  while :; do
    rem=$((deadline - SECONDS)); [ "$rem" -gt 0 ] || break
    [ "$rem" -le 30 ] || rem=30
    API_MAX_TIME=$rem api GET "/api/heartbeat-runs/$run" > "run-$label.json"
    st="$(python3 -c 'import json,re,sys; s=json.load(open(sys.argv[1])).get("status"); print(s if isinstance(s,str) and re.fullmatch(r"[a-z_]{1,32}",s) else "unknown")' "run-$label.json" 2>/dev/null || echo unknown)"
    case "$st" in succeeded|failed|cancelled|timed_out|interrupted) break;; esac
    rem=$((deadline - SECONDS)); [ "$rem" -gt 0 ] || break
    sleep $((rem < 5 ? rem : 5))
  done
  printf '%s' "$st"
}

# typed_tool_calls <label> <tool>: how many TYPED Hermes logger records "tool <tool> completed (<s>s, <n> chars)"
# (agent.tool_executor, INFO) the run's OWN raw log (runraw-<label>.ndjson) holds. Only records on the stderr
# stream count, and a record must match the whole line (HH:MM:SS - agent.tool_executor - INFO[ [session]] -
# tool ...): assistant text (stdout) and substrings of other lines can never satisfy it. The records exist
# because the agents run with the existing `verbose` flag (-v): the INFO agent.log file lives in the per-run
# HERMES_HOME, which the adapter deletes when the run ends. The output is a count only.
typed_tool_calls() {
  python3 -c '
import json, re, sys
path, tool = sys.argv[1], sys.argv[2]
pat = re.compile(r"\d{2}:\d{2}:\d{2} - agent\.tool_executor - INFO(?: \[[^\]\n]{1,64}\])? - tool ([A-Za-z0-9_]{1,64}) completed \(\d+\.\d{2}s, \d+ chars\)")
buf = []
try:
    with open(path, errors="ignore") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if isinstance(rec, dict) and rec.get("stream") == "stderr" and isinstance(rec.get("chunk"), str):
                buf.append(rec["chunk"])
except OSError:
    pass
n = sum(1 for l in "".join(buf).split("\n") if (m := pat.fullmatch(l)) and m.group(1) == tool)
print(n)' "runraw-$1.ndjson" "$2" 2>/dev/null || echo 0
}
# <<< testable:http

# Universal scope needs no restart to enable: start with memory on and no pilot list, so company creation itself
# is exercised under 'all' (it must not eagerly provision anything).
if [ "$SCOPE" = all ]; then start_server all; else start_server ""; fi

# ---- bootstrap the first admin: invite via the image's own CLI, sign up, accept ------------------------
BOOT_OUT="$(bounded 300 docker exec -u node --env-file app.env "$APP_NAME" sh -c 'mkdir -p /paperclip/instances/default && cat > /paperclip/instances/default/config.json <<J
{"\$meta":{"version":1,"updatedAt":"2026-01-01T00:00:00.000Z","source":"onboard"},"database":{"mode":"postgres"},"logging":{"mode":"file"},"server":{"deploymentMode":"authenticated","exposure":"private","host":"0.0.0.0","port":3100},"telemetry":{"enabled":false}}
J
cd /app/cli && timeout 240 /usr/local/bin/node --import ../server/node_modules/tsx/dist/loader.mjs src/index.ts auth bootstrap-ceo --force --data-dir /paperclip --base-url '"$BASE"' 2>&1')"
# Keep the CLI output for the leak scan (it runs with the server's full environment). It also holds the
# one-time invite URL, which is why the work dir is mode 0700 and deleted on exit.
printf '%s\n' "$BOOT_OUT" > bootstrap.log
INVITE="$(printf '%s\n' "$BOOT_OUT" | grep -o 'invite/pcp_bootstrap_[a-z0-9]*' | tail -1 | cut -d/ -f2 || true)"
[ -n "$INVITE" ] || { echo "bootstrap-ceo produced no invite" >&2; exit 1; }
# curl prints 000 itself on a connect failure/timeout, so the status is always a code; failure is then fixed-text below.
post_plain() { printf '%s' "$2" | curl -sS --connect-timeout 5 --max-time 30 -o last.json -w "%{http_code}" -c cookies.txt -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $BASE" -X POST "$1" --data-binary @- 2>/dev/null || true; }
S1="$(post_plain "$BASE/api/auth/sign-up/email" '{"name":"E2E Admin","email":"e2e-admin@paperclip.local","password":"E2e-local-pass-123456"}')"
S2="$(post_plain "$BASE/api/invites/$INVITE/accept" '{"requestType":"human"}')"
[ "$S1" = 200 ] && [ "$S2" = 202 ] || { echo "bootstrap failed (signup=$S1 accept=$S2)" >&2; exit 1; }

# ---- companies, provider secrets, agents ----------------------------------------------------------------
COMPANY_A="$(api POST /api/companies '{"name":"E2E Company A"}' | jid)"; must "$COMPANY_A"
COMPANY_B="$(api POST /api/companies '{"name":"E2E Company B"}' | jid)"; must "$COMPANY_B"
mksecret() { # company name env-var-holding-value
  python3 - "$2" "$3" <<'PY' | { api POST "/api/companies/$1/secrets" "$(cat)" | jid; }
import json, os, sys
print(json.dumps({"name": sys.argv[1], "value": os.environ[sys.argv[2]]}))
PY
}
mkagent() { # company name instructions anthropic-secret openai-secret
  python3 - "$2" "$3" "$4" "$5" <<'PY' | { api POST "/api/companies/$1/agents" "$(cat)" | jid; }
import json, sys
name, text, anth, oai = sys.argv[1:5]
cfg = {"provider": "anthropic", "model": "claude-haiku-4-5-20251001", "persistSession": False,
    "timeoutSec": 240, "maxTurnsPerRun": 8,
    "env": {"ANTHROPIC_API_KEY": {"type": "secret_ref", "secretId": anth, "version": "latest"},
            "OPENAI_API_KEY": {"type": "secret_ref", "secretId": oai, "version": "latest"}}}
# Memory-only tool surface in BOTH scopes (pinned Hermes 0.21.3: -t memory resolves to the built-in `memory`
# tool, and that enables the mem0 provider tools). Omitting toolsets enables all 17 tools, including
# terminal/file/web, so a recall could be answered from the writer's issue or logs instead of memory.
cfg["toolsets"] = "memory"
# Existing adapter flag (-v): makes Hermes emit its typed `tool <name> completed` logger records on stderr,
# which the run log keeps (the per-run INFO agent.log is deleted with the run home).
cfg["verbose"] = True
print(json.dumps({"name": name, "role": "general", "adapterType": "hermes_local", "adapterConfig": cfg,
  "instructionsBundle": {"entryFile": "AGENTS.md", "files": {"AGENTS.md": text}}}))
PY
}
SA_ANTH="$(mksecret "$COMPANY_A" e2e-anthropic E2E_ANTHROPIC_KEY)"; must "$SA_ANTH"
SA_OAI="$(mksecret "$COMPANY_A" e2e-openai E2E_OPENAI_KEY)"; must "$SA_OAI"
SB_ANTH="$(mksecret "$COMPANY_B" e2e-anthropic E2E_ANTHROPIC_KEY)"; must "$SB_ANTH"
SB_OAI="$(mksecret "$COMPANY_B" e2e-openai E2E_OPENAI_KEY)"; must "$SB_OAI"
STANDING="Do the task in the assigned issue exactly. Use your semantic memory tools when the task asks about memory."
AGENT_WRITE="$(mkagent "$COMPANY_A" e2e-write "$STANDING" "$SA_ANTH" "$SA_OAI")"; must "$AGENT_WRITE"
AGENT_RECALL="$(mkagent "$COMPANY_A" e2e-recall "$STANDING" "$SA_ANTH" "$SA_OAI")"; must "$AGENT_RECALL"
if [ "$SCOPE" = all ]; then
  # Company B gets its own writer and its own fresh reader; it is a full participant, not a negative control.
  AGENT_B_WRITE="$(mkagent "$COMPANY_B" e2e-b-write "$STANDING" "$SB_ANTH" "$SB_OAI")"; must "$AGENT_B_WRITE"
  AGENT_B_RECALL="$(mkagent "$COMPANY_B" e2e-b-recall "$STANDING" "$SB_ANTH" "$SB_OAI")"; must "$AGENT_B_RECALL"
else
  AGENT_B="$(mkagent "$COMPANY_B" e2e-b "$STANDING" "$SB_ANTH" "$SB_OAI")"; must "$AGENT_B"
fi
echo "companies and agents created"

if [ "$SCOPE" = all ]; then
  # Lazy provisioning: nothing is provisioned for either company until its first memory use, and no company
  # is listed anywhere. Only rows for the ids this script created are inspected (a shared database may hold others).
  [ "$(bounded 60 docker exec -e PGPASSWORD="$PG_PW" "$PG_NAME" psql -U postgres -d paperclip -Atc "select count(*) from company_memory_databases where company_id in ('$COMPANY_A','$COMPANY_B')")" = 0 ] \
    && pass "no memory database exists for either company before first memory use (lazy, no backfill)" \
    || fail "a memory database was provisioned before first memory use"
else
  # Memory is allowlisted per company id and ids are server generated, so restart with the allowlist now.
  start_server "$COMPANY_A"
fi

# A run must be task-bound to start (the runtime connection tools reject runs without an issue), and a
# wakeup's payload.instruction is not read by Hermes. So the task is an issue assigned to the agent;
# assignment starts the run and the follow-up wakeup returns that run's id.
run_task() { # label agent company title body -> prints terminal status; saves run-<label>.json
  local label="$1" agent="$2" company="$3" title="$4" body="$5" issue run st=""
  issue="$(python3 - "$agent" "$title" "$body" <<'PY' | { api POST "/api/companies/$company/issues" "$(cat)" | jid; }
import json, sys
print(json.dumps({"title": sys.argv[2], "description": sys.argv[3], "assigneeAgentId": sys.argv[1], "status": "todo"}))
PY
)"; must "$issue"
  sleep 2
  run="$(api POST "/api/agents/$agent/wakeup" "{\"source\":\"on_demand\",\"triggerDetail\":\"manual\",\"reason\":\"e2e\",\"payload\":{\"issueId\":\"$issue\"}}" \
    | jid executionRunId id)"
  must "$run"
  st="$(poll_run "$run" "$label")"
  echo "$label run=$run status=$st"
  # Failure detail (provider/model error text) is deliberately not printed; only the terminal status code is.
  [ "$st" = succeeded ] || { echo "$label run did not succeed (status=$st; error detail withheld)" >&2; return 1; }
}
answer_box() { python3 - "$1" <<'PY'
import json, sys
try:
    t = str((json.load(open(f"run-{sys.argv[1]}.json")).get("resultJson") or {}).get("result") or "")
except Exception:
    t = ""
# Hermes prints one boxed message per assistant turn; the answer is the last box, and the box can be long.
i = t.rfind("Hermes ─")
print(t[i:] if i >= 0 else t[-800:])
PY
}
run_log() { local r; r="$(python3 -c "import json;print(json.load(open('run-$1.json'))['id'])" 2>/dev/null || true)"; api GET "/api/heartbeat-runs/$r/log"; }
# A failed run ends the whole script at once (code-only): no further reader/provider attempts and no restart.
abort_run() { echo "FAIL fatal: run $1 did not succeed; stopping before any further provider attempts" >&2; echo "E2E RESULT: FAIL (fatal run $1, image $IMAGE)"; exit 1; }

# run_raw <label>: copy THIS run's own raw ndjson (found by its exact run id) into the private work dir.
run_raw() {
  local r; r="$(jid < "run-$1.json")"
  case "$r" in ERR*) : > "runraw-$1.ndjson"; return 0;; esac
  bounded 60 docker exec "$APP_NAME" sh -c 'f="$(find /paperclip -name "$1.ndjson" -print -quit)"; [ -n "$f" ] && cat "$f"' _ "$r" > "runraw-$1.ndjson" 2>/dev/null || true
}
tool_ok() { # tool_ok <label> <tool> <description>
  [ "$(typed_tool_calls "$1" "$2")" -ge 1 ] 2>/dev/null && pass "$3" || fail "$3 (no typed completed record in this run's own log)"
}

RECALL_TASK="Search your semantic memory for the exact company marker you were previously asked to remember. Return only the marker, or NONE if you cannot find one."
store_task() { echo "Use your semantic memory tool to store this exact company marker for future fresh runs: $1 . Reply STORED only after the memory tool confirms it stored the marker."; }
run_task write "$AGENT_WRITE" "$COMPANY_A" "Store company marker" "$(store_task "$MARKER")" || abort_run write
run_task recall1 "$AGENT_RECALL" "$COMPANY_A" "Recall company marker" "$RECALL_TASK" || abort_run recall1
if [ "$SCOPE" = all ]; then
  # Company B: its own write, then a fresh reader. The reader's issue and prompt carry no marker at all.
  run_task writeB "$AGENT_B_WRITE" "$COMPANY_B" "Store company marker" "$(store_task "$MARKER_B")" || abort_run writeB
  run_task recallB1 "$AGENT_B_RECALL" "$COMPANY_B" "Recall company marker" "$RECALL_TASK" || abort_run recallB1
fi
OLD_ID="$(docker inspect -f '{{.Id}}' "$APP_NAME" | cut -c1-12)"
if [ "$SCOPE" = all ]; then start_server all; else start_server "$COMPANY_A"; fi   # snapshots the old container's logs, removes it, starts a new one
echo "container recreated: $OLD_ID -> $(docker inspect -f '{{.Id}}' "$APP_NAME" | cut -c1-12)"
run_task recall2 "$AGENT_RECALL" "$COMPANY_A" "Recall company marker after restart" "$RECALL_TASK" || abort_run recall2
if [ "$SCOPE" != all ]; then
  run_task recallB "$AGENT_B" "$COMPANY_B" "Company marker lookup" \
    "Search your semantic memory for any company marker. Return only the marker, or NONE if unavailable." || abort_run recallB
fi

# ---- assertions -------------------------------------------------------------------------------------------
Q() { bounded 60 docker exec -e PGPASSWORD="$PG_PW" "$PG_NAME" psql -U postgres -d "${2:-paperclip}" -Atc "$1"; }
# Capture before matching: `producer | grep -q` can fail spuriously under pipefail when grep exits early.
has() { [[ "$1" == *"$2"* ]]; }
RAW_LABELS="write recall1 recall2"
if [ "$SCOPE" = all ]; then RAW_LABELS="$RAW_LABELS writeB recallB1"; else RAW_LABELS="$RAW_LABELS recallB"; fi
for n in $RAW_LABELS; do run_raw "$n"; done
OUT_WRITE="$(answer_box write)"; OUT_R1="$(answer_box recall1)"; OUT_R2="$(answer_box recall2)"
LOG_R1="$(run_log recall1)"
has "$OUT_WRITE" STORED && pass "write run said STORED" || fail "write run did not say STORED"
has "$OUT_R1" "$MARKER" && pass "recall1 returned the exact marker" || fail "recall1 did not return the marker"
has "$OUT_R2" "$MARKER" && pass "recall2 returned the exact marker" || fail "recall2 did not return the marker"
has "$LOG_R1" "with runtime memory" && pass "company A got a runtime memory config" || fail "company A had no runtime memory config"
# Native tool proof: typed `tool <name> completed` logger records from EACH run's own log (not model text).
tool_ok write mem0_add "company A write run: typed mem0_add completed record"
tool_ok recall1 mem0_search "company A fresh recall run: typed mem0_search completed record"
tool_ok recall2 mem0_search "company A post-restart recall run: typed mem0_search completed record"
[ "$(Q "select status from company_memory_databases where company_id='$COMPANY_A'")" = ready ] && pass "company A memory database ready" || fail "company A memory database not ready"
if [ "$SCOPE" != all ]; then
  OUT_B="$(answer_box recallB)"; LOG_B="$(run_log recallB)"
  has "$OUT_B" "$MARKER" && fail "company B saw company A's marker" || pass "company B answer has no marker"
  has "$LOG_B" "with runtime memory" && fail "company B got a runtime memory config" || pass "company B had no runtime memory config"
  [ "$(typed_tool_calls recallB mem0_add)$(typed_tool_calls recallB mem0_search)" = 00 ] && pass "company B run has no typed mem0 tool records" || fail "company B run has typed mem0 tool records"
  [ "$(Q "select count(*) from company_memory_databases where company_id='$COMPANY_B'")" = 0 ] && pass "no memory row for company B" || fail "memory row exists for company B"
  [ "$(Q "select count(*) from pg_database where datname like 'pcmem%'")" = 1 ] && pass "exactly one tenant database" || fail "unexpected tenant database count"
fi
IFS='|' read -r TENANT_DB TENANT_ROLE <<<"$(Q "select database_name, database_role from company_memory_databases where company_id='$COMPANY_A'")"
if [ -z "${TENANT_DB:-}" ] || [ -z "${TENANT_ROLE:-}" ]; then
  fail "company A has no tenant database/role row; skipping the checks that need it"
else
  MARKER_ROWS="$(Q "select count(*) from mem0_memories where payload::text like '%$MARKER%'" "$TENANT_DB" || echo 0)"
  [ "${MARKER_ROWS:-0}" -ge 1 ] 2>/dev/null && pass "marker row present in tenant database" || fail "marker row missing from tenant database"
  [ "$(Q "select count(*) from pg_database where datname <> '$TENANT_DB' and datallowconn and has_database_privilege('$TENANT_ROLE',datname,'CONNECT')")" = 0 ] \
    && pass "tenant role cannot connect to any other connectable database" || fail "tenant role can reach another database"
  [ "$(Q "select rolsuper::int+rolcreatedb::int+rolcreaterole::int from pg_roles where rolname='$TENANT_ROLE'")" = 0 ] \
    && pass "tenant role is unprivileged" || fail "tenant role has elevated attributes"
fi
if [ "$SCOPE" = all ]; then
  # ---- universal scope: company B is a full tenant with its own database -------------------------------------
  OUT_WB="$(answer_box writeB)"; OUT_RB1="$(answer_box recallB1)"
  LOG_RB1="$(run_log recallB1)"
  has "$OUT_WB" STORED && pass "company B write run said STORED" || fail "company B write run did not say STORED"
  has "$OUT_RB1" "$MARKER_B" && pass "company B fresh recall returned B's own marker" || fail "company B fresh recall did not return B's marker"
  has "$OUT_RB1" "$MARKER" && fail "company B fresh reader saw company A's marker" || pass "company B fresh reader has no marker from A"
  has "$OUT_R1$OUT_R2" "$MARKER_B" && fail "company A fresh reader saw company B's marker" || pass "company A fresh readers have no marker from B"
  has "$RECALL_TASK" "$MARKER" || has "$RECALL_TASK" "$MARKER_B" && fail "a recall task text carries a marker" || pass "recall task text carries no marker"
  has "$LOG_RB1" "with runtime memory" && pass "company B got a runtime memory config" || fail "company B had no runtime memory config"
  tool_ok writeB mem0_add "company B write run: typed mem0_add completed record"
  tool_ok recallB1 mem0_search "company B fresh recall run: typed mem0_search completed record"
  IFS='|' read -r DB_B ROLE_B <<<"$(Q "select database_name, database_role from company_memory_databases where company_id='$COMPANY_B'")"
  if [ -z "${DB_B:-}" ] || [ -z "${ROLE_B:-}" ] || [ -z "${TENANT_DB:-}" ]; then
    fail "company B has no tenant database/role row; skipping the checks that need it"
  else
    [ "$(Q "select status from company_memory_databases where company_id='$COMPANY_B'")" = ready ] && pass "company B memory database ready" || fail "company B memory database not ready"
    [ "$DB_B" != "$TENANT_DB" ] && [ "$ROLE_B" != "$TENANT_ROLE" ] && pass "A and B have distinct databases and roles" || fail "A and B share a database or role"
    # Only the two databases this run owns are inspected (a shared/hosted server may hold other tenants).
    [ "$(Q "select count(*) from company_memory_databases where company_id in ('$COMPANY_A','$COMPANY_B') and status='ready'")" = 2 ] && pass "both owned companies are ready" || fail "owned ready count is not 2"
    [ "$(Q "select count(*) from mem0_memories where payload::text like '%$MARKER_B%'" "$DB_B" || echo ERR)" -ge 1 ] 2>/dev/null && pass "B's marker row present in B's database" || fail "B's marker row missing from B's database"
    [ "$(Q "select count(*) from mem0_memories where payload::text like '%$MARKER_B%'" "$TENANT_DB" || echo ERR)" = 0 ] && pass "B's marker absent from A's database" || fail "B's marker found in (or unreadable from) A's database"
    [ "$(Q "select count(*) from mem0_memories where payload::text like '%$MARKER%'" "$DB_B" || echo ERR)" = 0 ] && pass "A's marker absent from B's database" || fail "A's marker found in (or unreadable from) B's database"
    [ "$(Q "select has_database_privilege('$ROLE_B','$TENANT_DB','CONNECT')::int + has_database_privilege('$TENANT_ROLE','$DB_B','CONNECT')::int")" = 0 ] \
      && pass "each tenant role is denied the other tenant's database" || fail "a tenant role can reach the other tenant's database"
    [ "$(Q "select count(*) from pg_database where datname <> '$DB_B' and datallowconn and has_database_privilege('$ROLE_B',datname,'CONNECT')")" = 0 ] \
      && pass "company B role cannot connect to any other connectable database" || fail "company B role can reach another database"
    [ "$(Q "select rolsuper::int+rolcreatedb::int+rolcreaterole::int from pg_roles where rolname='$ROLE_B'")" = 0 ] \
      && pass "company B role is unprivileged" || fail "company B role has elevated attributes"
  fi
fi
snap_logs
# The self-check must come from the final (post-recreate) container: earlier containers' lines are in
# server-all.log and would mask a regression there. Also fail if any container ever reported inspectable.
bounded 60 docker logs "$APP_NAME" > final-container.log 2>&1 || true
grep -Eq '"inspectability":[[:space:]]*"protected"' final-container.log && pass "startup self-check: final container protected" || fail "final container did not report protected"
if [ "$SCOPE" = all ]; then
  grep -Eq '"companyScope":[[:space:]]*"all"' final-container.log && grep -Eq '"pilotCompanyCount":[[:space:]]*0' final-container.log \
    && pass "boot log reports companyScope=all with no pilot list (no DSN fields)" || fail "boot log did not report companyScope=all / pilotCompanyCount=0"
fi
grep -Eq '"inspectability":[[:space:]]*"inspectable"' server-all.log && fail "a container reported its server process as inspectable" || pass "no container reported inspectable"
# The run-log API redacts secrets before returning them, so scanning it alone cannot catch a leak into the
# stored log. Scan the raw on-disk run logs too, and fail if there are none (a vacuous scan proves nothing).
: > runlogs.txt
RUN_LABELS="write recall1 recall2 recallB"
[ "$SCOPE" = all ] && RUN_LABELS="write recall1 writeB recallB1 recall2"
for n in $RUN_LABELS; do run_log "$n" >> runlogs.txt; echo >> runlogs.txt; done
bounded 120 docker exec "$APP_NAME" sh -c 'find /paperclip -name "*.ndjson" -exec cat {} +' > rawrunlogs.txt 2>/dev/null || true
bounded 60 docker logs "$PG_NAME" > pglogs.txt 2>&1 || true
[ -s rawrunlogs.txt ] && pass "raw on-disk run logs found ($(wc -c < rawrunlogs.txt) bytes)" || fail "no raw on-disk run logs found to scan"
LEAK_OK=1
python3 - <<'PY' || LEAK_OK=0
import os, re, sys
text = "".join(open(f, errors="ignore").read() for f in ("server-all.log", "bootstrap.log", "pglogs.txt", "runlogs.txt", "rawrunlogs.txt"))
needles = {"anthropic key": os.environ["E2E_ANTHROPIC_KEY"], "openai key": os.environ["E2E_OPENAI_KEY"],
           "pg password": os.environ["E2E_PG_PW"], "admin password": os.environ["E2E_ADMIN_PW"],
           "auth secret": os.environ["E2E_AUTH_SECRET"], "master key": os.environ["E2E_MASTER_KEY"]}
hits = [k for k, v in needles.items() if v and v in text]
placeholder = re.compile(r"^(\*+|<?redacted>?|\[?redacted\]?|\*{3}redacted\*{3})$", re.I)
dsn = [m for m in re.findall(r'postgres(?:ql)?://[^\s"\\]*:([^\s"\\@]+)@', text) if not placeholder.match(m)]
bad = bool(hits or dsn or "SCRAM-SHA-256$" in text)
print(("FAIL" if bad else "PASS"), "leak scan: secret values:", hits or "none", "| unmasked DSN passwords:", len(dsn))
sys.exit(1 if bad else 0)
PY
[ "$LEAK_OK" = 1 ] || FAILURES=$((FAILURES + 1))

echo
if [ "$FAILURES" -eq 0 ]; then echo "E2E RESULT: PASS (image $IMAGE)"; else echo "E2E RESULT: FAIL ($FAILURES failing checks, image $IMAGE)"; fi
exit "$([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)"

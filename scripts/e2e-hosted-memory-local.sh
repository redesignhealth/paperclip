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
#   IMAGE=<image ref or digest ref> scripts/e2e-hosted-memory-local.sh
#
# Provider keys (never printed, never written outside a mode-0700 work dir that is deleted on exit):
#   TEST_ANTHROPIC_API_KEY / TEST_OPENAI_API_KEY      the key values, or
#   E2E_ANTHROPIC_SSM / E2E_OPENAI_SSM                SSM parameter names (uses `aws ssm get-parameter`,
#                                                     honours AWS_PROFILE / AWS_REGION)
#
# Optional: PORT (default 3131), E2E_PG_IMAGE (default pgvector/pgvector:pg17), E2E_KEEP=1 (keep containers and work dir for debugging; the work dir then
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
redact() { sed -E 's#(postgres(ql)?://[^:@/ ]*:)[^@ ]*@#\1<redacted>@#g'; }

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
ssm_value() { aws ssm get-parameter --with-decryption --name "$1" --query Parameter.Value --output text; }
ANTHROPIC_KEY="${TEST_ANTHROPIC_API_KEY:-}"
OPENAI_KEY="${TEST_OPENAI_API_KEY:-}"
if [ -z "$ANTHROPIC_KEY" ] && [ -n "${E2E_ANTHROPIC_SSM:-}" ]; then need aws; ANTHROPIC_KEY="$(ssm_value "$E2E_ANTHROPIC_SSM")"; fi
if [ -z "$OPENAI_KEY" ] && [ -n "${E2E_OPENAI_SSM:-}" ]; then need aws; OPENAI_KEY="$(ssm_value "$E2E_OPENAI_SSM")"; fi
if [ -z "$ANTHROPIC_KEY" ] || [ -z "$OPENAI_KEY" ]; then
  echo "provider keys missing: set TEST_ANTHROPIC_API_KEY/TEST_OPENAI_API_KEY or E2E_ANTHROPIC_SSM/E2E_OPENAI_SSM" >&2
  exit 2
fi
AUTH_SECRET="$(openssl rand -hex 32)"
MASTER_KEY="$(openssl rand -hex 32)"
PG_PW="$(openssl rand -hex 16)"
ADMIN_PW="$(openssl rand -hex 16)"
MARKER="MK-$(openssl rand -hex 8)"
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
  docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && sleep 2 && break
  sleep 1
done
PSQL() { docker exec -i -e PGPASSWORD="$PG_PW" "$PG_NAME" psql -U postgres -v ON_ERROR_STOP=1 -q; }
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
snap_logs() { docker logs "$APP_NAME" >> server-all.log 2>&1 || true; }

start_server() { # $1 = comma separated pilot company ids, empty = memory disabled
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
      echo "PAPERCLIP_MEMORY_PILOT_COMPANIES=$pilot"
    fi
  } > app.env
  docker run -d --name "$APP_NAME" -p "127.0.0.1:$PORT:3100" --env-file app.env -v "$HOME_VOL:/paperclip" "$IMAGE" >/dev/null
  local waited=0
  until curl -fsS "$BASE/api/health" >/dev/null 2>&1; do
    sleep 3; waited=$((waited + 3))
    if [ "$waited" -ge "$WAIT_HEALTH" ]; then
      echo "server not healthy after ${WAIT_HEALTH}s" >&2; docker logs --tail 40 "$APP_NAME" 2>&1 | redact >&2; exit 1
    fi
  done
}

api() { # method path [json]
  local m="$1" p="$2" b="${3:-}"
  # The body goes over stdin: request bodies carry provider keys and argv is visible in `ps`.
  if [ -n "$b" ]; then
    printf '%s' "$b" | curl -sS -X "$m" -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $BASE" "$BASE$p" --data-binary @-
  else
    curl -sS -X "$m" -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $BASE" "$BASE$p"
  fi
}
jid() { python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id") or "ERR:"+json.dumps(d)[:300])'; }
must() { case "$1" in ERR*|"") echo "API call failed: $1" >&2; exit 1;; esac; }

start_server ""

# ---- bootstrap the first admin: invite via the image's own CLI, sign up, accept ------------------------
BOOT_OUT="$(docker exec -u node --env-file app.env "$APP_NAME" sh -c 'mkdir -p /paperclip/instances/default && cat > /paperclip/instances/default/config.json <<J
{"\$meta":{"version":1,"updatedAt":"2026-01-01T00:00:00.000Z","source":"onboard"},"database":{"mode":"postgres"},"logging":{"mode":"file"},"server":{"deploymentMode":"authenticated","exposure":"private","host":"0.0.0.0","port":3100},"telemetry":{"enabled":false}}
J
cd /app/cli && timeout 240 /usr/local/bin/node --import ../server/node_modules/tsx/dist/loader.mjs src/index.ts auth bootstrap-ceo --force --data-dir /paperclip --base-url '"$BASE"' 2>&1')"
# Keep the CLI output for the leak scan (it runs with the server's full environment). It also holds the
# one-time invite URL, which is why the work dir is mode 0700 and deleted on exit.
printf '%s\n' "$BOOT_OUT" > bootstrap.log
INVITE="$(printf '%s\n' "$BOOT_OUT" | grep -o 'invite/pcp_bootstrap_[a-z0-9]*' | tail -1 | cut -d/ -f2 || true)"
[ -n "$INVITE" ] || { echo "bootstrap-ceo produced no invite" >&2; exit 1; }
post_plain() { printf '%s' "$2" | curl -sS -o last.json -w "%{http_code}" -c cookies.txt -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $BASE" -X POST "$1" --data-binary @-; }
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
print(json.dumps({"name": name, "role": "general", "adapterType": "hermes_local",
  "adapterConfig": {"provider": "anthropic", "model": "claude-haiku-4-5-20251001", "persistSession": False,
    "timeoutSec": 240, "maxTurnsPerRun": 8,
    "env": {"ANTHROPIC_API_KEY": {"type": "secret_ref", "secretId": anth, "version": "latest"},
            "OPENAI_API_KEY": {"type": "secret_ref", "secretId": oai, "version": "latest"}}},
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
AGENT_B="$(mkagent "$COMPANY_B" e2e-b "$STANDING" "$SB_ANTH" "$SB_OAI")"; must "$AGENT_B"
echo "companies and agents created"

# Memory is allowlisted per company id and ids are server generated, so restart with the allowlist now.
start_server "$COMPANY_A"

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
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("executionRunId") or d.get("id") or "ERR:"+json.dumps(d)[:300])')"
  must "$run"
  for _ in $(seq 1 $((WAIT_RUN / 5))); do
    api GET "/api/heartbeat-runs/$run" > "run-$label.json"
    st="$(python3 -c 'import json; print(json.load(open("run-'"$label"'.json")).get("status"))')"
    case "$st" in succeeded|failed|cancelled|timed_out|interrupted) break;; esac
    sleep 5
  done
  echo "$label run=$run status=$st"
  [ "$st" = succeeded ] || { python3 -c 'import json; print((json.load(open("run-'"$label"'.json")).get("error") or "")[:300])'; return 1; }
}
answer_box() { python3 - "$1" <<'PY'
import json, sys
t = str((json.load(open(f"run-{sys.argv[1]}.json")).get("resultJson") or {}).get("result") or "")
# Hermes prints one boxed message per assistant turn; the answer is the last box, and the box can be long.
i = t.rfind("Hermes ─")
print(t[i:] if i >= 0 else t[-800:])
PY
}
run_log() { local r; r="$(python3 -c "import json;print(json.load(open('run-$1.json'))['id'])")"; api GET "/api/heartbeat-runs/$r/log"; }

RECALL_TASK="Search your semantic memory for the exact company marker you were previously asked to remember. Return only the marker, or NONE if you cannot find one."
run_task write "$AGENT_WRITE" "$COMPANY_A" "Store company marker" \
  "Use your semantic memory tool to store this exact company marker for future fresh runs: $MARKER . Reply STORED only after the memory tool confirms it stored the marker." || fail "write run did not succeed"
run_task recall1 "$AGENT_RECALL" "$COMPANY_A" "Recall company marker" "$RECALL_TASK" || fail "fresh recall run did not succeed"
OLD_ID="$(docker inspect -f '{{.Id}}' "$APP_NAME" | cut -c1-12)"
start_server "$COMPANY_A"   # snapshots the old container's logs, removes it, starts a new one
echo "container recreated: $OLD_ID -> $(docker inspect -f '{{.Id}}' "$APP_NAME" | cut -c1-12)"
run_task recall2 "$AGENT_RECALL" "$COMPANY_A" "Recall company marker after restart" "$RECALL_TASK" || fail "post-restart recall run did not succeed"
run_task recallB "$AGENT_B" "$COMPANY_B" "Company marker lookup" \
  "Search your semantic memory for any company marker. Return only the marker, or NONE if unavailable." || fail "company B run did not succeed"

# ---- assertions -------------------------------------------------------------------------------------------
Q() { docker exec -e PGPASSWORD="$PG_PW" "$PG_NAME" psql -U postgres -d "${2:-paperclip}" -Atc "$1"; }
# Capture before matching: `producer | grep -q` can fail spuriously under pipefail when grep exits early.
has() { [[ "$1" == *"$2"* ]]; }
OUT_WRITE="$(answer_box write)"; OUT_R1="$(answer_box recall1)"; OUT_R2="$(answer_box recall2)"; OUT_B="$(answer_box recallB)"
LOG_B="$(run_log recallB)"; LOG_R1="$(run_log recall1)"
has "$OUT_WRITE" STORED && pass "write run said STORED" || fail "write run did not say STORED"
has "$OUT_R1" "$MARKER" && pass "recall1 returned the exact marker" || fail "recall1 did not return the marker"
has "$OUT_R2" "$MARKER" && pass "recall2 returned the exact marker" || fail "recall2 did not return the marker"
has "$OUT_B" "$MARKER" && fail "company B saw company A's marker" || pass "company B answer has no marker"
has "$LOG_B" "with runtime memory" && fail "company B got a runtime memory config" || pass "company B had no runtime memory config"
has "$LOG_R1" "with runtime memory" && pass "company A got a runtime memory config" || fail "company A had no runtime memory config"
[ "$(Q "select count(*) from company_memory_databases where company_id='$COMPANY_B'")" = 0 ] && pass "no memory row for company B" || fail "memory row exists for company B"
[ "$(Q "select status from company_memory_databases where company_id='$COMPANY_A'")" = ready ] && pass "company A memory database ready" || fail "company A memory database not ready"
[ "$(Q "select count(*) from pg_database where datname like 'pcmem%'")" = 1 ] && pass "exactly one tenant database" || fail "unexpected tenant database count"
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
snap_logs
# The self-check must come from the final (post-recreate) container: earlier containers' lines are in
# server-all.log and would mask a regression there. Also fail if any container ever reported inspectable.
docker logs "$APP_NAME" > final-container.log 2>&1
grep -Eq '"inspectability":[[:space:]]*"protected"' final-container.log && pass "startup self-check: final container protected" || fail "final container did not report protected"
grep -Eq '"inspectability":[[:space:]]*"inspectable"' server-all.log && fail "a container reported its server process as inspectable" || pass "no container reported inspectable"
# The run-log API redacts secrets before returning them, so scanning it alone cannot catch a leak into the
# stored log. Scan the raw on-disk run logs too, and fail if there are none (a vacuous scan proves nothing).
: > runlogs.txt
for n in write recall1 recall2 recallB; do run_log "$n" >> runlogs.txt; echo >> runlogs.txt; done
docker exec "$APP_NAME" sh -c 'find /paperclip -name "*.ndjson" -exec cat {} +' > rawrunlogs.txt 2>/dev/null || true
docker logs "$PG_NAME" > pglogs.txt 2>&1 || true
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

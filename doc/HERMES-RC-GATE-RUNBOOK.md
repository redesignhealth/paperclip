# Hermes release-candidate gate (TECH-7089)

Integration gate for the combined Hermes changes before any hosted agent is resumed:
PR #29 (governed MCP projection + fail-closed preflight), PR #30 (Hermes 0.21.3 + model/default
compatibility), PR #31 (child-process environment isolation; merged as `47568f409`), TECH-7095 (hosted
managed-only auth policy; open, not merged), and the production Docker image built from the combined
heads. The matrix below was re-run against master `47568f409`.

This document is the **coverage matrix**, the **reproducible command set**, and the **backend-only
canary runbook**. It adds no new test framework: every automated check below is an existing test or
the existing fixture. Anything the matrix marks `GATED` is not covered yet and must not be reported
as passing.

Ownership: the orchestrator owns image publication, credentials, scheduler control, synthetic
resource creation, the hosted canary, evidence capture, cleanup and the final PASS/FAIL. No step
here needs the product owner to click through a UI; if a step turns out to need one, that is an
automation defect to fix with a backend path, not a request to the product owner.

## 0. Preconditions for building the release image

1. `pnpm-lock.yaml` must be in sync with every `package.json`. PR #29 added
   `@modelcontextprotocol/sdk` and `zod` to `packages/adapters/hermes` without a lockfile (CI policy:
   PRs may not commit it), so `docker build` fails at `pnpm install --frozen-lockfile` until the
   lockfile refresh PR (head branch must be exactly `chore/refresh-lockfile`) has merged. The
   automated refresh and Docker workflows are disabled on this fork, so the refresh is manual.
2. Build on a runner/Docker VM with **at least 16 GB** of memory. The server build runs the native
   TypeScript 7 compiler, which is killed on an 8 GB Docker VM (`Killed` / `ResourceExhausted`).
3. Build the exact release artifact and record its digest:

   ```bash
   docker build --target production \
     --build-arg PAPERCLIP_BUILD_COMMIT="$(git rev-parse HEAD)" \
     -t paperclip:rc-"$(git rev-parse --short HEAD)" .
   docker image inspect paperclip:rc-"$(git rev-parse --short HEAD)" --format '{{.Id}}'
   ```

   Publish by immutable digest only. Rollback is by digest only; the pre-#31 image is
   credential-vulnerable, so any rollback keeps the scheduler disabled and agents paused.

### Combined-head / image digest manifest (fill in at execution time)

| Item | Value |
|---|---|
| paperclip master SHA (merge of #29, #30, #31, lockfile refresh) | |
| rh-paperclip main SHA (deployment wiring) | |
| Hermes version in image (`hermes --version`) | expected `v0.21.3 (2026.9.14)` |
| `docker/hermes/source.lock` sha256 | `47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834` |
| Image digest (`sha256:...`) | |
| Build host memory | >= 16 GB |

## 1. Layer 1: deterministic acceptance (real Hermes, offline)

The fixture `server/src/__tests__/fixtures/hermes-chat-mcp-fixture.py` runs the real
`hermes chat -q` against a fake streamable-HTTP MCP server (one allowed tool, one forbidden tool) and
a fake OpenAI-compatible model that records every request. It needs no network and no credentials.
It prints one sanitized `EVIDENCE {...}` JSON line (no URLs, tokens or prompts) and exits non-zero
on any failed assertion.

Run each scenario inside the **built production image** (the fixture only needs `/opt/hermes`):

```bash
IMAGE=paperclip:rc-<sha>   # or the immutable digest reference
FX="$PWD/server/src/__tests__/fixtures"
for scenario in auto off roundtrip forbidden; do
  docker run --rm --user node -v "$FX:/fx:ro" "$IMAGE" \
    /opt/hermes/bin/python3 /fx/hermes-chat-mcp-fixture.py "$scenario"
done
```

| Scenario | Proves (real Hermes 0.21.3) | Expected evidence |
|---|---|---|
| `auto` | default `tools.tool_search`: MCP tools are deferred behind `tool_search`/`tool_describe`/`tool_call`; the allowed tool is in the turn-1 manifest; forbidden tool is absent | `bridge_tools_present` has the 3 bridge tools, `allowed_in_tool_search_manifest: true` |
| `off` | `tool_search` disabled: allowed tool is a direct `mcp__fixture__allowed_tool` schema entry on turn 1; forbidden tool absent from the schema | `mcp_tool_schema_name: mcp__fixture__allowed_tool`, `bridge_tools_present: []` |
| `roundtrip` | deterministic model tool call: the MCP server executes the allowed tool exactly once, the result arrives as a `role:tool` message with the matching `tool_call_id` in the next model request, exit 0, no `ExceptionGroup`/`Traceback`, no leftover Hermes process | `mcp_calls_executed: ["allowed_tool"]`, `tool_result_reached_model: true`, `exit_code: 0` |
| `forbidden` | hallucinated call to the non-allowlisted tool: it never executes; only allowlisted tools can run | `mcp_calls_executed` never contains `forbidden_tool` |

Every scenario also asserts `hermes --version` output is captured and that no process whose program
is `hermes` remains after exit. The scan matches the `hermes` program only; orphaned grandchildren
(for example an MCP subprocess) are not scanned.

**Known Hermes 0.21.x behaviors to keep in mind**

- *Tool deferral*: with the default `tools.tool_search.enabled`, MCP tools are not direct schema
  entries. Paperclip's generated isolated profile sets `enabled: "off"` (PR #29); the YAML forms
  `off`, `false` and `'off'` all behave identically.
- *Tool-name repair*: Hermes remaps an unknown/hallucinated tool name onto a registered tool
  (case/separator/`_tool`-suffix normalisation, then fuzzy match;
  `agent/agent_runtime_helpers.py` `repair_tool_call`). In the `forbidden` scenario the call to
  `mcp__fixture__forbidden_tool` was executed as `mcp__fixture__allowed_tool`. This is not an
  allowlist bypass (only registered, i.e. allowlisted, tools can run) but the executed tool name can
  differ from the requested one; audit tooling must key on the executed name.
- *Dependency*: Hermes 0.21.3 pulls `mcp` 2.0.0 (server API is `mcp.server.MCPServer`, not
  `FastMCP`); `mem0ai==2.0.10` and the psycopg closure are unchanged.

Scoped test commands (run from the repository root):

```bash
# adapter unit + real-preflight/execute tests
pnpm --filter @paperclipai/hermes-paperclip-adapter exec tsc --noEmit
pnpm --filter @paperclipai/hermes-paperclip-adapter exec vitest run
# Dockerfile / lock contract (offline)
pnpm --filter @paperclipai/server exec vitest run src/__tests__/docker-hermes-cli.test.ts
python3 scripts/compile-hermes-requirements.py --check
# gated live Docker test (builds --target base, installs Hermes from source.lock, security/immutability
# checks, mem0 provider, and all four fixture scenarios above)
PAPERCLIP_RUN_DOCKER_HERMES_TESTS=true \
  pnpm --filter @paperclipai/server exec vitest run src/__tests__/docker-hermes-cli.test.ts -t "live container"
```

## 2. Layer 2: fail-closed matrix (real preflight + execute path)

`packages/adapters/hermes/src/server/execute.mcp.real-preflight.test.ts` drives the REAL MCP
preflight through the REAL `execute()` against a local gateway; only `runChildProcess` is mocked, so
"`runChildProcess` not called" is the assertion that model execution never began. Diagnostics are
asserted to contain neither the bearer token, the credential-bearing URL, nor the redirect target.
The redirect case counts every request (any method, any headers) that reaches the redirect target, so a
followed redirect cannot pass unnoticed; the pagination cases pin the failure to `failed tools/list` (not
a missing/unexpected-tool failure) with the allowlisted tool on the first page. Both were verified by
mutation: following redirects, or raising the page cap, makes the corresponding test fail.
A missing/empty bearer is rejected earlier, by config validation (`token must be non-empty`), before the
preflight runs; the no-spawn result is the same.

## 3. Coverage matrix

Status: `COVERED` (automated, asserts the property), `PARTIAL` (asserts part; the gap is stated),
`GATED` (depends on an unmerged change or a builder; not passing yet), `NO FEATURE` (the behavior
does not exist in any merged or pending change; a product blocker, not a harness gap).
Paths are relative to `packages/adapters/hermes/src/server/` (A), `server/src/__tests__/` (S).

| ID | Assertion | Evidence | Status / what is NOT proven |
|---|---|---|---|
| L1.1 | no literal `-m auto` | A `execute.model.test.ts`, `model-arg.test.ts` | PARTIAL: spawn mocked; real argv from a real run needs G2 |
| L1.2 | allowed tool direct on turn 1 | S `fixtures/hermes-chat-mcp-fixture.py` `off`/`roundtrip` | PARTIAL: hand-written config, not Paperclip's generated profile (G2) |
| L1.3 | forbidden absent from schema AND execution | fixture `off` (schema), `forbidden` (execution) | COVERED (schema + never-executes invariant; name repair noted above) |
| L1.4 | deterministic tool call, result reaches model | fixture `roundtrip` | COVERED |
| L1.5 | exit 0, no teardown ExceptionGroup/false failure | fixture `roundtrip` (rc 0, output scanned) | COVERED for the real CLI; Paperclip's own result classification of real output needs G2 |
| L1.6 | temp homes deleted, no Hermes child | fixture (/proc scan of `hermes` processes only); A `execute.mcp.real-preflight.test.ts` `leftoverProfiles()` | PARTIAL: Paperclip-generated home after a REAL Hermes run needs G2 |
| L1.7 | mem0ai/psycopg imports intact | `Dockerfile` build-time `import mcp, mem0, psycopg, psycopg2`; S `docker-hermes-cli.test.ts` live | PARTIAL: not run against the published image; run the fixture command above plus `docker run ... python3 -c 'import mcp, mem0, psycopg, psycopg2'` against the digest |
| L1.img | production image, not base | none automated | GATED: needs a >= 16 GB builder and the lockfile refresh PR (#32) merged (section 0) |
| L1.combined | Paperclip-generated profile accepted by real Hermes in one run | none | GATED (G2): written against TECH-7095's final env/HOME behavior (PR #31 is merged but did not deliver it) |
| L2.2 | MCP bearer missing/invalid | A `execute.mcp.real-preflight.test.ts` (invalid: 401 through the real preflight; missing/empty: rejected by config validation before the preflight) | COVERED |
| L2.3 | cross-origin redirect | same file (redirect: target receives 0 requests/0 auth headers); A `mcp-preflight.test.ts` | COVERED (Hermes' own client redirect behavior after spawn not tested) |
| L2.4 | missing/unexpected callable tools | same file; A `mcp-preflight.test.ts` | COVERED (fake gateway, not the real Paperclip gateway) |
| L2.5 | malformed/incomplete pagination | same file (endless pages, non-array `tools`, non-advancing cursor) | COVERED |
| L2.6 | host config overrides `tools.include`/tool-search | A `mcp-config.test.ts` | COVERED as **strip + warn + continue with the exact generated config** (orchestrator decision D1; not "abort") |
| L2.13 | diagnostics names/reasons only | same preflight tests assert token/URL/redirect target absent | PARTIAL: generated `config.yaml`/`.env` on disk and real Hermes stderr not scanned (G2) |
| L2.7 | ambient provider/DB/auth/AWS/GitHub/Paperclip secrets in the parent | A `execute.env-isolation.test.ts` (3 tests), `adapter-utils` `agent-child-env.test.ts`, `server-utils.test.ts`, acpx `execute-identity.test.ts`, spawn guards (all merged in #31) | PARTIAL: the Hermes child env now starts from the strict `buildAgentChildBaseEnv` base. The Hermes test mocks `fs` and spawn and never takes the isolated-home/MCP branch, and host `~/.hermes/.env` provider keys are still injected (`execute.mcp.test.ts` asserts it). A real-Hermes run with fake ambient secrets seeded in the parent is still G2 |
| L2.1 | no managed AI binding under hosted managed-only policy | none | NO FEATURE (TECH-7095) |
| L2.8 | shared HOME login/config without a managed binding | none; master tests assert the opposite (host `~/.hermes/.env` key injected) | NO FEATURE (TECH-7095) |
| L2.9 | hosted acpx terminal disabled | none | NO FEATURE (TECH-7095) |
| L2.10 | ambient GitHub fallback refused | none; `git-credentials.test.ts` asserts the server-env fallback | NO FEATURE (TECH-7095) |
| L2.11 | board chat fails closed without managed auth | none | NO FEATURE (TECH-7095) |
| L2.12 | readiness/billing reflects child-visible credentials only | none; `test.ts` reads `process.env` and `~/.hermes/.env` | NO FEATURE (TECH-7095) |

### Dependency-gated assertions

PR #31 is merged and its tests are mapped above; it did **not** deliver the hosted product behaviors
(rows L2.1, L2.8-L2.12). Those are owned by TECH-7095 and are not harness gaps.

1. When TECH-7095 merges, re-run sections 1 and 2 on the merged head and map each of L2.1/L2.8-L2.12
   to that PR's own tests; do not assume the behavior exists before then.
2. G2 (a gated driver that runs Paperclip's real `prepareHermesMcpHome` + `execute()` with the real
   `runChildProcess` against real Hermes and the fixture, with fake ambient secrets seeded in the
   parent, asserting real argv has no `-m auto`, the generated YAML is accepted, the Paperclip profile is
   deleted and no secret value reaches logs or the profile) is intentionally not written yet: its
   assertions must be written against TECH-7095's final env/HOME behavior, otherwise they would assert
   behavior that is about to change.
3. The hosted canary (section 4) may not report PASS on L2.1/L2.8-L2.12 until those rows are
   `COVERED` by merged tests.

## 4. Layer 3: isolated hosted canary (backend only)

Run by the orchestrator after: the image is built and published by digest (section 0), TECH-7095 is
merged, all real agents are paused and `HEARTBEAT_SCHEDULER_ENABLED=false`, and the operator gives an
explicit go. Every call below is a backend API call authenticated with a board API key
(`Authorization: Bearer $BOARD_KEY`); no UI step is required **if** the key already exists. If the key is
expired or missing, report an operator-bootstrap blocker; board keys can only be minted by an
already-authenticated board actor (`POST /api/board-api-keys`) or a human-approved CLI-auth challenge,
and this runbook does not add a UI flow or any secret-reading code.

All routes are mounted under `/api`. `BASE` is the hosted base URL. Never print `BOARD_KEY`, the AI
provider key, or the ReClaw credential; pass them from the operator secret store via the environment.

### 4.0 Blockers found by reading the handlers (resolve before this canary can PASS)

These are facts about master `47568f409`, verified against the code, not assumptions:

1. **Managed AI connections cannot be bound to `hermes_local`.** `AI_CONNECTION_CAPABILITIES`
   (`packages/shared/src/ai-connections.ts`) lists only `claude_local`, `codex_local`,
   `opencode_local`, `grok_local`; a binding on a Hermes agent is rejected with `422
   ai_connection_incompatible` (`server/src/services/ai-connections.ts`). Hermes instead copies host
   `~/.hermes/.env` provider keys. So step 3 ("bind a dedicated managed model connection") and the
   hosted managed-only policy cannot both hold for Hermes today: TECH-7095's `managed_only` pre-spawn
   failure would block every Hermes run unless `hermes_local` also gains a managed-AI capability.
   **Needs an owner decision (TECH-7095 scope).**
2. **The callable set is not exactly `comms_whoami`.** For adapters with `native_mcp` delivery
   (`hermes_local`), any run with a `responsibleUserId` (board wakes always set one) also gets a
   "Paperclip connections" MCP server exposing `connections_search` and `connection_request`
   (`server/src/services/heartbeat.ts`, `runtimeMcpServers.unshift`). The preflight is exact *per server*,
   so the run passes while the agent sees two servers. The ticket's "exact callable set is only
   `comms_whoami`" needs either a per-agent opt-out (for example
   `runtimeConfig.runtimeConnectionTools:false`) or a ticket wording change.
3. **Negative canaries cannot be produced through the API for Hermes.**
   - *Unbound managed auth*: impossible to configure (blocker 1); for supported adapters it fails before the
     model with `ai_connection_unavailable`.
   - *Mismatched tool profile*: the preflight allowlist is built from the same profile the gateway
     serves, so they agree by construction; an empty or bad profile yields zero MCP servers and the run
     proceeds without MCP instead of failing. Preflight failure paths are only reachable in tests
     (section 2). A fail-closed `adapterConfig.requiredMcpTools` check would make this canary-testable.
4. **No server-side proof of the turn-1 tool schema.** Provider-trace capture exists only on the native
   runner path. For Hermes the evidence is the preflight line plus `tools.tool_search.enabled: "off"`;
   section 1 proves the schema shape in an offline run of the same image, not in the hosted run.
5. **No API for a name-only environment probe or for OS processes.** The probe must be performed by the
   operator on the task (outside this API), and orphan processes can only be inferred from
   `processPid`/`status`/`live-runs`.
6. **ReClaw MCP auth mode is not determined.** A static bearer works via `credentialRefs`; an OAuth
   method returns a browser consent URL (a UI step) and is out of scope for this gate.
7. **Company creation** needs an instance-admin board key on a non-cloud-managed instance
   (`POST /api/companies` returns `403 cloud_managed` when `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` or
   `PAPERCLIP_MANAGED_CONFIG` is set). If the hosted instance is cloud-managed, use an existing disposable
   synthetic company instead.

### 4.1 Request sequence (steps 1-8 of the ticket)

Field names come from the zod schemas cited; enums are exact. `jq -r` extracts ids.

```bash
H=(-H "Authorization: Bearer $BOARD_KEY" -H "Content-Type: application/json")
```

1. **Keep real agents paused / scheduler off.** `HEARTBEAT_SCHEDULER_ENABLED` is read once at boot
   (`config.ts`; on unless the literal string `"false"`) and is not visible through any API: the
   operator sets it in the task definition and verifies via deployment config. With it off, manual
   `wakeup`/`heartbeat/invoke` still run, **and so do assignment/comment wakes from issue routes**, so
   also pause every real agent: `POST /api/agents/:id/pause` (this cancels in-flight runs; do not pause
   a busy agent). Verify with `GET /api/instance/scheduler-heartbeats` (instance admin; lists only
   non-paused agents) that no real agent is listed.
2. **Synthetic company and agent.**
   `POST /api/companies` body `{"name":"rc-gate-canary-<date>"}` (`createCompanySchema`) -> `id`.
   `POST /api/companies/:companyId/agents` body (`createAgentSchema`)
   `{"name":"rc-canary","adapterType":"hermes_local","adapterConfig":{"timeoutSec":300,"maxTurnsPerRun":4},"runtimeConfig":{"heartbeat":{"enabled":false}}}` -> agent `id`.
3. **Managed model connection.** `POST /api/companies/:companyId/ai-connections` body
   (`createAiConnectionSchema`) `{"provider":"openrouter","method":"api_key","name":"rc-canary-model","ownership":"shared","apiKey":"$AI_KEY","agentIds":["<agentId>"]}` -> `connectionId`,
   `grantId`. The server validates the key against the real provider. **Binding it to `hermes_local` is
   rejected today (blocker 1).**
4. **ReClaw MCP connection and exact profile.**
   `POST /api/companies/:companyId/secrets` body `{"name":"reclaw-canary","value":"$RECLAW_TOKEN"}` -> secret `id`.
   `POST /api/companies/:companyId/tools/connections` body (`createToolConnectionSchema`)
   `{"name":"reclaw-canary","transport":"mcp_remote","authKind":"api_key","status":"active","enabled":true,"config":{"url":"$RECLAW_MCP_URL"},"credentialRefs":[{"name":"reclaw","secretId":"<secretId>","placement":"header","key":"Authorization","prefix":"Bearer "}]}` -> connection `id`
   (`status`/`enabled` default to `draft`/`false` and must be set).
   `POST /api/tool-connections/:id/health-check` (must report `ok`/`healthy`, else the gateway skips it),
   `POST /api/tool-connections/:id/catalog/refresh`, `GET /api/tool-connections/:id/catalog` -> the
   `catalogEntryId` for `comms_whoami`.
   `PUT /api/tool-connections/:id/installs` body `{"installs":[{"targetType":"agent","targetId":"<agentId>"}]}`
   (agent-level only; never `targetType:"company"`).
   `POST /api/companies/:companyId/tools/profiles` body (`createToolProfileWithEntriesSchema`)
   `{"profileKey":"rc-canary","name":"rc-canary","status":"active","defaultAction":"deny","entries":[{"selectorType":"catalog_entry","effect":"include","connectionId":"<connId>","catalogEntryId":"<entryId>"}]}`;
   never a `connection` selector (it exposes every tool) or `defaultAction:"allow"`.
   `POST /api/companies/:companyId/tools/profiles/:profileId/bind` body `{"targetType":"agent","targetId":"<agentId>"}`.
   Verify with `GET /api/companies/:companyId/tools/profiles/effective/agents/:agentId` that no
   company-level binding widens the set. The projected tool name is `mcp.<app-slug>-<shortId>:comms-whoami` (the gateway slug converts `_` to `-`)
   at the gateway; Hermes sees the server as `paperclip_assigned`. See blocker 2 for the extra
   "Paperclip connections" server.
5. **Trigger exactly one run.** `POST /api/agents/:id/wakeup` body (`wakeAgentSchema`)
   `{"source":"on_demand","triggerDetail":"manual","reason":"rc-gate canary","idempotencyKey":"rc-gate-<date>-1"}`;
   omit `payload.issueId` (an issue adds a "Paperclip projects" MCP server). Response 202 -> run `id`. Poll
   `GET /api/heartbeat-runs/:runId` for `status`, `exitCode`, `errorCode`, `resultJson`, `processPid`.
6. **Collect sanitized evidence** (all read endpoints redact before returning, so the API cannot prove
   the *stored* output is clean; that needs log-store/DB access by the operator):
   - `GET /api/heartbeat-runs/:runId/log?offset=0&limitBytes=...` -> JSON envelope `{content,nextOffset}` whose `content` holds NDJSON lines `{ts,stream,chunk}` (`seq` is optional). Grep for
     `[hermes] MCP preflight ok: 'paperclip_assigned' lists exactly 1 allowlisted tool(s).` (failure form:
     `[hermes] MCP preflight failed:`), `[hermes] Prepared isolated HERMES_HOME with N runtime MCP server(s).` (with company memory enabled the line reads `... with runtime memory and N runtime MCP server(s).`)
     (N reveals blocker 2), a tool-call line containing the tool name and a duration, and
     `[hermes] Exit code: 0, timed out: false`.
   - `GET /api/heartbeat-runs/:runId/events`, `GET /api/companies/:id/tools/runs/:runId/decisions`,
     `GET /api/tool-connections/:id/activity`, `GET /api/tool-gateway/audit?companyId=&agent=` (needs
     `tools:view_audit`) for the server-side record of the single `comms_whoami` call.
   - Secret scan: for every secret value held by the operator (`BOARD_KEY`, `AI_KEY`, `RECLAW_TOKEN`, run
     bearer), `grep -F` the saved log/events/run JSON and fail on any hit. Report names only.
   - Orphans: `GET /api/companies/:id/live-runs` must be empty after the run.
7. **Negative canaries.** Unbound managed auth and mismatched profile are **not producible through the
   API for Hermes** (blocker 3). Do not claim them; mark them `BLOCKED` with the blocker reference until
   the product change lands. For a supported adapter (for example `claude_local`) unbound auth fails
   before the model with `ai_connection_unavailable`.
8. **Cleanup and revocation.** `POST /api/companies/:id/tools/profiles/:pid/unbind` with body `{"targetType":"agent","targetId":"<agentId>"}`,
   `DELETE /api/tool-profiles/:pid`, `DELETE /api/tool-connections/:id/grants/:grantId`,
   `DELETE /api/tool-connections/:id` (archives; whether it archives an AI connection is not determined),
   `DELETE /api/secrets/:id`, `POST /api/agents/:id/terminate` (or `DELETE /api/agents/:id`), then
   `POST /api/companies/:id/archive`. Verify revocation: run tokens show `revokedAt` in
   `GET /api/companies/:id/tools/gateways` (`tools:admin`), the connection is archived, and
   `GET /api/companies/:id/ai-connections` no longer lists the model connection.

**Never call** `DELETE /api/companies/:id` (hard delete that also wipes company memory), `/smoke-lab/reset`,
company-level installs, or pause on a busy real agent.

### 4.2 PASS / FAIL decision

PASS requires every row of sections 1-2 `COVERED` (the section 1 fixture only exercises the offline image; it is not hosted evidence) on the merged heads, rows L2.1/L2.8-L2.12 `COVERED` by
TECH-7095's merged tests, blockers 1-3 resolved or explicitly waived in writing by the owner, all
section 4.1 evidence recorded without secrets, and cleanup verified. Any `BLOCKED`, `GATED` or
`NO FEATURE` row is FAIL for release purposes. The decision and the digest manifest (section 0) are linked
from the parent launch ticket. A failed canary never falls back to ambient credentials or the host HOME;
rollback is by immutable digest with the scheduler off and agents paused.

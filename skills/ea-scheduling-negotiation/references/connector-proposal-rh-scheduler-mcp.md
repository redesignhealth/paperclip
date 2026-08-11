# Connector Proposal: rh-scheduler-mcp

Filled in from `doc/connections/CONNECTOR-PLAYBOOK.md`'s template. This is
the first connector proposal referencing `rh-scheduler-mcp`; there is no
prior entry to reconcile against.

## Vendor

- App key: `rh-scheduler-mcp`
- App name: RH Scheduler Mediator
- Owner: Redesign Health platform engineering (the same org that owns
  `rh-scheduler-mcp` itself; not a third-party vendor).
- First-30 classification: **MCP-direct**. `rh-scheduler-mcp` exposes a
  stable, official `mcp.server.fastmcp.FastMCP` server whose 4 tools map
  cleanly to Paperclip grants with no shim needed.
- Reason for classification: the server already speaks MCP over
  `streamable-http` (see its `server.py` `main()`), and every tool's
  input/output is a typed Pydantic model — no OpenAPI-shim or
  vendor-deep-wrapper machinery is needed to make this callable.
- Security tier: **S2**. Read-only in this phase, but every tool touches
  real employees' calendar/availability data (a form of PII/business-
  sensitive data), which is more sensitive than a pure S1 dev-tool
  connector even with no write path.
- Plugin needed? No. This is a plain transport + governed connection; no
  plugin-owned tables, workers, or custom UI are needed for the read-only
  shadow-mode tool surface this ticket covers.

## Transport And Auth

- Transport: `mcp_remote` (`streamable-http`, per `rh-scheduler-mcp`'s
  `server.py` `main()` transport flag).
- Endpoint: an internal Tailscale-tailnet hostname
  (`terraform/main.tf`: no ALB, no public IP — the client-facing endpoint
  is `https://<tailnet-hostname>/mcp`, reached over the RH tailnet only).
  The placeholder used in `packages/shared/src/app-definitions/rh-scheduler-mcp.json`
  (`https://scheduler-mcp.internal.tailnet.redesignhealth.com/mcp`) must be
  replaced with the real provisioned tailnet hostname before this
  connection is actually activated for any company.
- Auth mode: modeled as **API key** in the AppDefinition schema — and as of
  TECH-5043 landing on `rh-scheduler-mcp` (PR #24, merged to `main`), this is
  now the CORRECT shape for the one credential Paperclip must hold
  statically, not an interim placeholder. What changed is what that single
  credential actually is and how it gets used. Read
  `~/repos/rh-scheduler-mcp/src/scheduler_mcp/token_minting.py` and the
  `mint_token_for_subject` tool in `server.py` directly before touching this
  section again — this summary is deliberately self-contained but the real
  code is the source of truth.

  **The real mechanism (verified against `token_minting.py`/`server.py`,
  not assumed):**
  - `rh-scheduler-mcp` now exposes a fifth MCP tool,
    `mint_token_for_subject(bearer_token, target_subject, scopes=None) ->
    {token}`. Calling it requires the CALLER's own `bearer_token` to verify
    (via the same `resolve_caller_identity` path every other tool uses) to
    an identity whose `scopes` include `token_minting.MINT_SCOPE`
    (`"mint:on_behalf_of"`).
  - Paperclip holds exactly ONE static credential for this connector: a
    long-lived `rh-auth` JWT for a service-principal identity (e.g.
    `sub="paperclip-gateway"`) carrying `MINT_SCOPE`, issued once
    out-of-band by RH platform engineering (Paperclip never mints this
    itself and never sees `RH_AUTH_SECRET` — that secret stays inside
    `rh-scheduler-mcp`'s own deployment). This is the `api_key` field in
    the manifest below.
  - At actual tool-call time, the real flow is two hops:
    1. Call `mint_token_for_subject` with `bearer_token` = the static
       service-principal credential, `target_subject` = the specific RH
       employee's Okta-verified identity for the run's
       `responsibleUserId`, and `scopes` = whichever of
       `token_minting.MINTABLE_SCOPES`
       (`scheduler:check_availability`, `scheduler:find_mutual_availability`,
       `scheduler:propose_times`, `scheduler:check_conflicts`) the actual
       call needs. `TokenMinter.mint` denies a request for any scope the
       service principal's own token doesn't carry or that falls outside
       `MINTABLE_SCOPES` — it cannot be used to self-escalate.
    2. `mint_token_for_subject` returns a token with a 10-minute TTL
       (`DEFAULT_MINT_TTL`), scoped to that one employee.
    3. THAT returned token, not the static credential, is the
       `bearer_token` passed to the actual `check_availability` /
       `find_mutual_availability` / `propose_times` / `check_conflicts`
       call.
  - The static service-principal credential must never be presented
    directly to the four real tools — their caller-identity resolution
    expects a token scoped to the employee being asked about, and doing
    otherwise is exactly the scope-widening the minting design exists to
    prevent, not merely an auth failure to work around.

  **Whether Paperclip's gateway supports this two-hop shape — verified
  against the built adapter, not assumed:** Paperclip has an existing
  pre-call-token-exchange concept: `connection_token.mint` (see
  `mintConnectionTokenForAgent` and `mintExchangeConnectionToken` in
  `server/src/services/tool-access.ts`), gated behind a per-connection
  `tokenBroker`/`broker` config (`connectionTokenBrokerEnabled`,
  `inferConnectionTokenPath`), already used in production for
  `paperclip-pages`. It threads a `responsibleUserId` through as
  `actor.onBehalfOf`/an on-behalf-of argument, enforces a scope subset
  check against the connection's `parentScopes`, requires an explicit
  broker-mint profile grant, rate-limits per connection/agent, and audits
  every mint attempt — functionally, the same shape TECH-5043's mint step
  needs. As of TECH-4951's follow-up, `mintExchangeConnectionToken` has a
  **third exchange protocol**, `protocol: "mcp_tool"`, that speaks MCP
  JSON-RPC `tools/call` for the exchange leg instead of assuming a plain
  HTTP endpoint (the two prior protocols, `rfc8693` and a generic REST
  JSON POST, still exist unchanged and still assume a plain HTTP endpoint
  — this is an addition, not a replacement).

  **How the `mcp_tool` protocol works (generic, not `rh-scheduler-mcp`-
  specific):** it reuses the same MCP JSON-RPC `tools/call` request
  builder and result extractor `executeRemoteHttpTool` uses for ordinary
  tool calls (`buildMcpToolCallRequest`/`extractMcpToolCallResult` in
  `server/src/services/mcp-http.ts` — a single shared implementation, not
  a second MCP client), and reads its target tool name and field mapping
  entirely from config under `tokenBroker.mcpTool`:

  ```json
  "tokenBroker": {
    "enabled": true,
    "path": "exchange",
    "protocol": "mcp_tool",
    "tokenUrl": "https://<tailnet-hostname>/mcp",
    "parentCredentialConfigPath": "credentials.authorization",
    "parentScopes": [
      "scheduler:check_availability",
      "scheduler:find_mutual_availability",
      "scheduler:propose_times",
      "scheduler:check_conflicts"
    ],
    "rateLimitPerHour": 30,
    "mcpTool": {
      "toolName": "mint_token_for_subject",
      "requestFieldMap": {
        "credential": "bearer_token",
        "onBehalfOf": "target_subject",
        "scopes": "scopes"
      },
      "responseTokenPath": "token"
    }
  }
  ```

  - `tokenUrl` is the same tailnet `/mcp` endpoint the connection's
    `serverUrl` already points at — `mint_token_for_subject` is invoked
    exactly like every other tool on that server, over `tools/call`.
  - `parentCredentialConfigPath` is the static service-principal `rh-auth`
    JWT credential field already described above; the broker resolves it
    from `company_secrets` the same way it resolves the pages deploy
    token, and passes it as the `bearer_token` MCP tool-call argument
    (via `requestFieldMap.credential`) — never to the calling agent.
  - `requestFieldMap.onBehalfOf` maps the run's `responsibleUserId`
    (the RH employee whose calendar the call concerns) onto
    `mint_token_for_subject`'s `target_subject` parameter.
  - `requestFieldMap.scopes` maps the broker's already-scope-subset-
    checked `issuedScope` onto `mint_token_for_subject`'s `scopes`
    parameter — an agent can never request a scope outside
    `parentScopes` above, which itself must stay a subset of what the
    service-principal token can mint (`token_minting.MINTABLE_SCOPES`
    server-side).
  - `responseTokenPath` is a dot-path read against whichever of
    `result.structuredContent` or a JSON-parsed `result.content` text
    part the response actually used (some MCP servers emit structured
    output, some only emit a text-content JSON blob) — for
    `mint_token_for_subject`'s `{token: str}` return shape this is just
    `"token"`, but the field is config so a future MCP-tool-shaped broker
    target with a different return shape (`{data: {token}}`, etc.) does
    not need a second protocol adapter, just a different
    `responseTokenPath`.

  All of the existing broker security properties apply unchanged to this
  protocol, because the protocol dispatch lives inside
  `mintExchangeConnectionToken`, which every caller reaches only after
  the scope-subset check, the explicit `connection_token.mint` profile
  grant check, the per-connection/agent rate limit, and the policy
  decision + audit already ran in `mintConnectionTokenForAgent` — the new
  protocol branch does not, and structurally cannot, skip any of that; it
  only changes how the exchange leg itself is dispatched. See
  `server/src/__tests__/tool-access-service.test.ts` (the `mcp_tool`-
  tagged tests) for coverage of a successful mint, the text-content JSON
  fallback path, an upstream tool-error result failing closed with an
  audited failure, and the explicit-grant requirement still applying.

  This connector's tool catalog and this skill's instructions now call the
  four real tools by first requesting a broker-minted token for this
  connection (the same generic `connection_token.mint` mechanism any
  other broker-backed connector uses) and passing the result as
  `bearer_token` — see `SKILL.md`'s step 2. No agent-visible knowledge of
  `mint_token_for_subject`'s own two-hop mechanics is required; that
  detail is now fully absorbed into the connection's `tokenBroker` config.
- OAuth scopes or key scope: N/A (not OAuth). The 4 read-only tool names
  (`check_availability`, `find_mutual_availability`, `propose_times`,
  `check_conflicts`) are recorded as `scopesHint` for documentation, not as
  an enforced OAuth scope list. `mint_token_for_subject` is deliberately
  NOT added to `scopesHint` — it is not one of the four tools an agent
  invokes directly; it is only ever reached indirectly, through the
  connection's `tokenBroker` config, by Paperclip's own broker
  (`mintExchangeConnectionToken`'s `mcp_tool` protocol), not by an agent
  choosing to call it as a catalog tool.
- Credential owner: platform. RH platform engineering mints the
  service-principal `rh-auth` JWT once, out-of-band, via `rh-scheduler-mcp`'s
  own operator tooling, and provisions it as part of standing up this
  connection instance-wide — not customer-supplied, and not something
  Paperclip itself mints (Paperclip never sees `RH_AUTH_SECRET`).
- Secret storage: `company_secrets` ref only, per the playbook's standing
  rule — never in agent env, project env, adapter config, or logs. This
  matters more than usual here: the whole point of the mint step is that
  the calling agent never needs to see the static service-principal
  credential's raw value, only the short-lived per-employee token
  `mint_token_for_subject` returns.
- Revocation behavior: disabling the connection removes the 4 tools from
  every agent's session and denies brokered execution on the next gateway
  check, same as any other connection (`tool-gateway.ts`'s generic
  revocation path — no vendor-specific revocation code needed).

## Resource Filters

- Required filters: none formally modeled on the Paperclip side today.
  `rh-scheduler-mcp` enforces its own disclosure policy, rate limiting, and
  audit internally (per its README's "Mediator requirements") — the
  connection does not need Paperclip-side resource filters to make its
  read calls safe, because the mediator itself is the enforcement boundary
  for "whose calendar can be seen."
- Optional filters: none proposed in this pass.
- Write-enabling filters: N/A — there are no write actions in this tool
  surface (see Actions table below).
- Filters enforced by: the mediator service itself (disclosure policy,
  rate limiting, audit — all internal to `rh-scheduler-mcp`), not by a
  Paperclip-side wrapper. This is a deliberate difference from the
  Linear dry run in the playbook, which does enforce filters at the
  gateway/wrapper layer — `rh-scheduler-mcp` is designed so the mediator
  is the one component that needs to see both sides of a query, precisely
  so Paperclip does not have to re-implement per-attendee disclosure
  logic on its side.

## Manifest

See `packages/shared/src/app-definitions/rh-scheduler-mcp.json` for the
full, schema-validated manifest (validated by
`packages/shared/src/app-definitions-rh-scheduler-mcp.test.ts`). Summary:

- key: `rh-scheduler-mcp`
- name: RH Scheduler Mediator
- tagline/description: read-only mutual-availability, slot-proposal, and
  conflict checks brokered without exposing raw calendars to the caller.
- authKind: `api_key` (correct shape as of TECH-5043 — see Transport And
  Auth above for what it actually holds and how it's used)
- transportTemplate: `mcp_remote`, tailnet `serverUrl`
- credentialFields: one service-principal-token field, `secret: true`
- oauth: none
- urlPatterns: the tailnet hostname pattern
- recommendedDefaults: `platform_provisioned` ownership only;
  `askFirstRiskLevels` would be `["write", "destructive"]` by the shared
  helper `recommendedDefaultsForApp`, but there is nothing to ask-first
  today since every action is `read`.
- availability: not yet marked generally available. The `mcp_tool` broker
  exchange protocol adapter is now built and tested (this document's
  Transport And Auth section), and this connector's tool catalog and
  skill instructions are updated to use it (`SKILL.md` step 2). One thing
  remains before this connection can be marked generally available: the
  placeholder tailnet hostname (`https://scheduler-mcp.internal.tailnet.redesignhealth.com/mcp`)
  must be replaced with the real provisioned hostname, and the connection
  actually stood up against it (see Validation Hook below — this has not
  been smoke-tested against a live deployment).

## Actions

| Tool | Risk | Default status | Filters | Approval default | Audit fields | Negative case |
| --- | --- | --- | --- | --- | --- | --- |
| `check_availability` | read | active | none (caller's own calendar only) | allow | requester, date range | Caller with no linked Google credential gets `NotConnectedError`, not a disclosure leak. |
| `find_mutual_availability` | read | active | none (mediator-enforced) | allow | requester, attendee set (hashed/canonical), disclosure level applied | Attendee with no linked credential fails the whole query closed, never a silent partial intersection. |
| `propose_times` | read | active | none | allow | requester, duration, window | Malformed/unparseable duration or window is rejected, not silently defaulted. |
| `check_conflicts` | read | active | none | allow | requester, subject set, clean/conflict slot counts (no per-attendee attribution) | A caller cannot see which named attendee caused a conflict — only that one exists. |

"Default status: active" above describes the catalog classification (read,
allow, no ask-first) these four tools get once this connection is
provisioned with the `tokenBroker` config in Transport And Auth above.
`mint_token_for_subject` itself is deliberately NOT one of the tools an
agent's profile grants access to — the default profile (see Governance
Defaults below) must include only the four read tools plus the
`connection_token.mint` broker-mint grant, never a direct grant to call
`mint_token_for_subject` as an ordinary catalog tool. That keeps the
two-hop mechanics entirely inside the broker, where the scope-subset,
rate-limit, and audit checks already run, instead of leaving a second,
ungoverned path for an agent to mint its own on-behalf-of tokens directly.

No write or destructive action exists in this tool surface. If
`rh-scheduler-mcp` later exposes `book_meeting`, `send_scheduling_email`, or
the autonomy-gate-evaluation tool referenced in
`references/autonomy-gate-stub.md`, each must go through this same
playbook's action-catalog step from scratch — including changed-action
quarantine — not be silently activated because "the connection already
existed."

## Wizard Path

- User path: N/A for self-serve — this is `platform_provisioned`, not
  `customer`-connectable. An operator/platform engineer provisions it once
  per Paperclip instance; individual companies do not see a "Connect"
  button/OAuth flow for it.
- Configuration steps: platform engineering stores the service-principal
  bearer token as a `company_secrets` ref at provisioning time and sets
  the connection's `config.tokenBroker` block to the `mcp_tool`
  configuration shown in Transport And Auth above (protocol, tool name,
  field mapping, response token path); no per-company wizard step.
- Error states: connection health check fails closed if the tailnet
  endpoint is unreachable or the bearer token is rejected — same generic
  `mcp_remote` health-check path every other `mcp_remote` connection uses,
  no vendor-specific error handling needed.
- Redacted metadata shown: connection status/health only; never the bearer
  token value.

## Governance Defaults

- Default profile: read-only profile including all 4 read tools plus the
  `connection_token.mint` broker-mint grant for this connection; no write
  profile exists to opt into. `mint_token_for_subject` itself must NOT be
  granted to any agent profile as a directly callable tool — it is reached
  only through the broker (see Actions above and Transport And Auth's
  `mcp_tool` protocol section).
- Policy defaults: no ask-first policy needed today (nothing but `read`
  actions exist); this will need to change the moment any write or
  gate-evaluation tool is added — do not treat "read-only today" as
  license to skip that step later.
- Quarantine: N/A today (no write/destructive actions); the standard
  changed-action quarantine rule applies automatically to any future
  tool-catalog change once `rh-scheduler-mcp` adds one.
- Rate limits: not modeled on the Paperclip side — `rh-scheduler-mcp`'s own
  `RateLimiter`/anti-probing logic (per its README's requirement 3) is the
  enforcement point; a Paperclip-side rate limit would be redundant unless
  a future review decides otherwise.

## Validation Hook

- Real-vendor smoke issue: not yet filed; this proposal has not gone
  through the production-validation pass this playbook's Step 9
  describes (connect against the real tailnet endpoint, catalog
  discovery, allowed read call, revoke, audit evidence). Flagging this
  explicitly rather than claiming it as done: **this connector has not yet
  been smoke-tested against a live `rh-scheduler-mcp` deployment.**
- Connect evidence: pending — requires the real tailnet hostname and a
  real provisioned service-principal bearer token, neither of which this
  ticket has.
- Broker adapter evidence: the `mcp_tool` exchange protocol is covered by
  unit/integration tests in `server/src/__tests__/tool-access-service.test.ts`
  (successful mint against a mocked MCP `tools/call` response, the
  structuredContent-absent text-content JSON fallback, an upstream
  tool-error result failing closed with an audited failure, and the
  explicit broker-mint profile grant requirement still applying) and
  `server/src/__tests__/mcp-http.test.ts` (the shared request-building/
  result-extraction helpers). This is mocked-transport coverage, not a
  live call against a real `rh-scheduler-mcp` deployment.
- Catalog evidence: the AppDefinition JSON validates against the shared
  schema (`appDefinitionSchema`) and is covered by
  `packages/shared/src/app-definitions-rh-scheduler-mcp.test.ts`, which is
  static-schema validation, not a live catalog-discovery smoke test.
- Allowed read / denied case / revoke / audit: all pending the real-
  deployment smoke pass; the broker-mint leg specifically is exercised
  only against a mocked upstream so far (see Broker adapter evidence
  above).

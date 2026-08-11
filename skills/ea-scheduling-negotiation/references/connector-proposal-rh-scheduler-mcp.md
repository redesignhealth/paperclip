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

  **Whether Paperclip's gateway already supports this two-hop shape —
  investigated, not assumed:** Paperclip does have an existing
  pre-call-token-exchange concept: `connection_token.mint` (see
  `mintConnectionTokenForAgent` and `mintExchangeConnectionToken` in
  `server/src/services/tool-access.ts`), gated behind a per-connection
  `tokenBroker`/`broker` config (`connectionTokenBrokerEnabled`,
  `inferConnectionTokenPath`), already used in production for
  `paperclip-pages`. It already threads a `responsibleUserId` through as
  `actor.onBehalfOf`, enforces a scope subset check against the
  connection's `parentScopes`, requires an explicit broker-mint profile
  grant, rate-limits per connection/agent, and audits every mint attempt —
  functionally, the same shape TECH-5043's mint step needs. **However**,
  `mintExchangeConnectionToken` only implements two exchange protocols
  today (`rfc8693`, an RFC 8693 token-exchange form-POST; and a generic
  REST JSON POST used by the pages path), and both assume the exchange
  target is a plain HTTP endpoint reachable via `fetch`. `rh-scheduler-mcp`
  deliberately did NOT expose `mint_token_for_subject` as an HTTP route —
  it is an MCP tool, invoked the same way every other tool on that server
  is (`tools/call` over JSON-RPC, per `executeRemoteHttpTool`'s dispatch
  path in `server/src/services/tool-gateway.ts`), specifically for
  transport consistency with the rest of the service (see that tool's own
  docstring). Neither existing broker protocol can drive that call.

  **The concrete gap, scoped precisely:** wiring this connector into the
  existing broker requires one new exchange protocol adapter in
  `mintExchangeConnectionToken` (e.g. `protocol: "mcp_tool"`) that speaks
  MCP JSON-RPC `tools/call` for the exchange leg — POST the same
  `{jsonrpc, method: "tools/call", params: {name: "mint_token_for_subject",
  arguments: {bearer_token: <parent credential>, target_subject, scopes}}}`
  shape `executeRemoteHttpTool` already builds for ordinary tool calls, and
  parse `result.token` out of the JSON-RPC response the same way
  `normalizeMcpToolResult` already does — plus resolving `target_subject`
  from the run's `responsibleUserId` to that employee's Okta-verified
  email. This is a bounded extension of infrastructure that already exists
  and is already load-bearing in production, not a request for brand-new
  generic gateway machinery — but it is real, not-yet-written code, and is
  NOT attempted in this pass (TECH-4951/4952/4953's scope). Once it lands,
  no second piece of new gateway machinery is needed: an agent naturally
  chains "call `mint_token_for_subject` (bearer_token auto-filled by the
  broker from the static credential), read `token` from the result, pass
  it as `bearer_token` to the real tool call" the same way it already
  chains `check_availability` → `propose_times` → `check_conflicts` today
  — that's ordinary multi-step tool composition, not something needing new
  Paperclip infrastructure.

  Until that adapter exists, this connector's tool catalog and this
  skill's instructions must NOT attempt to call the four real tools at
  all — see `SKILL.md`'s updated step 2 and `warnings` above.
- OAuth scopes or key scope: N/A (not OAuth). The 4 read-only tool names
  (`check_availability`, `find_mutual_availability`, `propose_times`,
  `check_conflicts`) are recorded as `scopesHint` for documentation, not as
  an enforced OAuth scope list. `mint_token_for_subject` is deliberately
  NOT added to `scopesHint` in this pass — it is not yet callable through
  this connection (see the gap above), and listing it before the broker
  adapter exists would imply a working capability that isn't there.
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
- availability: not yet marked generally available. Three things must be
  true first, not just one: (1) the placeholder tailnet hostname replaced
  with the real one, (2) the `mint_token_for_subject` MCP-tool exchange
  protocol adapter described above built and tested on the Paperclip
  gateway side, and (3) this connector's tool catalog and skill
  instructions updated to actually call the mint step before the four real
  tools once (2) exists. None of the four real tools should be treated as
  reachable through this connection until all three are done.

## Actions

| Tool | Risk | Default status | Filters | Approval default | Audit fields | Negative case |
| --- | --- | --- | --- | --- | --- | --- |
| `check_availability` | read | active | none (caller's own calendar only) | allow | requester, date range | Caller with no linked Google credential gets `NotConnectedError`, not a disclosure leak. |
| `find_mutual_availability` | read | active | none (mediator-enforced) | allow | requester, attendee set (hashed/canonical), disclosure level applied | Attendee with no linked credential fails the whole query closed, never a silent partial intersection. |
| `propose_times` | read | active | none | allow | requester, duration, window | Malformed/unparseable duration or window is rejected, not silently defaulted. |
| `check_conflicts` | read | active | none | allow | requester, subject set, clean/conflict slot counts (no per-attendee attribution) | A caller cannot see which named attendee caused a conflict — only that one exists. |

"Default status: active" above describes the catalog classification (read,
allow, no ask-first) these four tools would get once reachable, not a claim
that they are callable today. As of this pass they are NOT actually
callable through this connection: calling any of them with the static
service-principal credential would fail auth (or misattribute the call),
and there is no `mint_token_for_subject` exchange adapter yet to obtain the
per-employee token they actually require. See Transport And Auth above and
`SKILL.md`'s workflow notes.

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
- Configuration steps: platform engineering stores the bearer token as a
  `company_secrets` ref at provisioning time; no per-company wizard step.
- Error states: connection health check fails closed if the tailnet
  endpoint is unreachable or the bearer token is rejected — same generic
  `mcp_remote` health-check path every other `mcp_remote` connection uses,
  no vendor-specific error handling needed.
- Redacted metadata shown: connection status/health only; never the bearer
  token value.

## Governance Defaults

- Default profile: read-only profile including all 4 tools; no write
  profile exists to opt into.
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
  been smoke-tested against a live `rh-scheduler-mcp` deployment as part of
  this ticket.**
- Connect evidence: pending — requires the real tailnet hostname and a
  real provisioned bearer token, neither of which this ticket has.
- Catalog evidence: the AppDefinition JSON validates against the shared
  schema (`appDefinitionSchema`) and is covered by
  `packages/shared/src/app-definitions-rh-scheduler-mcp.test.ts`, which is
  static-schema validation, not a live catalog-discovery smoke test.
- Allowed read / denied case / revoke / audit: all pending the same
  real-deployment smoke pass.

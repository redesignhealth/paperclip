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
- Auth mode: modeled as **API key** in the AppDefinition schema (the
  closest fit of the three modes the schema supports), but this is a
  known-imperfect fit — flagged explicitly, not silently accepted:
  - Every `rh-scheduler-mcp` tool takes an explicit `bearer_token`
    parameter and resolves caller identity **per call**, from that token
    (an rh-auth JWT), specifically because it is a multi-tenant mediator —
    "whose calendar" and "who's asking" must come from the call itself,
    never from ambient/process identity (see `server.py`'s module
    docstring).
  - A single static `company_secrets`-backed bearer credential — the
    shape this connector currently uses — means every call through this
    connection is attributed to one identity, regardless of which EA
    agent actually made the call. That is an accepted interim
    simplification for this ticket, not a solved problem; see the
    `warnings` array in the AppDefinition JSON and
    `references/autonomy-gate-stub.md`-adjacent follow-up needs.
  - A real fix requires either (a) minting a distinct rh-auth JWT per EA
    agent identity and storing each as its own `company_secrets` ref, or
    (b) extending the connection/gateway model to resolve a per-agent
    token at call time rather than a single connection-level secret. Both
    are out of scope for this ticket.
- OAuth scopes or key scope: N/A (not OAuth). The 4 tool names
  (`check_availability`, `find_mutual_availability`, `propose_times`,
  `check_conflicts`) are recorded as `scopesHint` for documentation, not as
  an enforced OAuth scope list.
- Credential owner: platform (RH platform engineering provisions the
  bearer token as part of standing up this connection instance-wide), not
  customer-supplied.
- Secret storage: `company_secrets` ref only, per the playbook's standing
  rule — never in agent env, project env, adapter config, or logs.
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
- authKind: `api_key` (see the caveat above)
- transportTemplate: `mcp_remote`, tailnet `serverUrl`
- credentialFields: one bearer-token field, `secret: true`
- oauth: none
- urlPatterns: the tailnet hostname pattern
- recommendedDefaults: `platform_provisioned` ownership only;
  `askFirstRiskLevels` would be `["write", "destructive"]` by the shared
  helper `recommendedDefaultsForApp`, but there is nothing to ask-first
  today since every action is `read`.
- availability: not yet marked generally available; the placeholder
  tailnet hostname must be replaced with the real one, and the shared
  vs. per-agent bearer-token question above resolved, before this should
  be treated as production-ready rather than a scoped proposal.

## Actions

| Tool | Risk | Default status | Filters | Approval default | Audit fields | Negative case |
| --- | --- | --- | --- | --- | --- | --- |
| `check_availability` | read | active | none (caller's own calendar only) | allow | requester, date range | Caller with no linked Google credential gets `NotConnectedError`, not a disclosure leak. |
| `find_mutual_availability` | read | active | none (mediator-enforced) | allow | requester, attendee set (hashed/canonical), disclosure level applied | Attendee with no linked credential fails the whole query closed, never a silent partial intersection. |
| `propose_times` | read | active | none | allow | requester, duration, window | Malformed/unparseable duration or window is rejected, not silently defaulted. |
| `check_conflicts` | read | active | none | allow | requester, subject set, clean/conflict slot counts (no per-attendee attribution) | A caller cannot see which named attendee caused a conflict — only that one exists. |

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

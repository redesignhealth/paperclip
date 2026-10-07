# Default MCP spec

Every new agent can be offered a short list of MCP apps. The apps start OFF. This feature is off by default.

## Turn it on

Set `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED=true`. When the flag is not `true`, agent creation does not change.
Defaults are not applied retroactively to agents that already exist. Legacy agents with an absent or null `defaultMcp` value remain unmanaged; existing managed or corrupted state is still enforced independently of the feature flag.

## The spec

`server/src/services/default-mcp-spec.ts` holds the list. Each entry names an org connection (the template) and a `defaultEnabled` value.
To add an app, add one entry. Only an entry with special auth needs a `setupHook`.

- **Ordinary entry (for example Google):** the agent toggles the org connection itself. OAuth consent is never started at create time.
- **Dedicated entry (comms board):** the org connection is a read-only template. Setup creates one connection per agent, named `<template>:<agentId>`. Only that connection can be installed or used by the agent. The org template and the connections of other agents are refused.

The current spec includes ReClaw Comms Board and RH Google MCP, both with `defaultEnabled: false`, so neither is installed by default. Enabling the spec may still run the Comms Board's dedicated provisioning hook when its prerequisites are present; Google consent is never started by agent creation. No production authorization or new auth/IAM setup is implied. A third RH MCP entry is queued separately and is not part of this spec.

## What OFF means

An app is ON for an agent only with an explicit per-agent install row. A company-wide install, a company profile, or an organization grant does not turn it on. The gateway, token mint, effective profiles and the run projection use one rule.
An agent whose row is missing or belongs to another company is caller-specific: gateway listing/search returns `404 agent_not_found`; the run projection is `null`. It is not silently treated as a legacy agent. A present but corrupted protected `defaultMcp` key fails closed: gateway dispatch and token mint return `403 installation_required`, and the effective installed set is empty. The same refusal is used by the heartbeat projection and effective-profile path.

An absent `defaultMcp` key, an empty metadata object, or `defaultMcp: null` is intentionally legacy/unmanaged behavior. The server never writes `null`; this compatibility distinction must not be described as the feature silently changing legacy agents. The refusal checks are independent of the feature flag: turning the feature off stops new snapshots and the sweep, but does not make an existing malformed state usable.

A managed per-agent connection cannot change its credential policy or arbitrary credential references. `credentialSecretRefs` are compared by canonical value, so equivalent key/reference ordering changes are accepted; values must remain unchanged. Non-header `credentialRefs` remain equal, while the single header reference may move only to the same secret and its path/key/prefix representation. The managed grant and connection bindings are updated atomically, without an outer duplicate sync.

Removing the install blocks the next session and the next call. It does not cancel a call that is already running, revoke a valid already-issued token, or remove installed access merely because the feature flag is later turned off. Per-agent disable controls runtime access; external token revocation remains a separate concern.

## Provisioning and identity checks

The setup hook provisions only after the agent row, company membership, template, and owner prerequisites have been checked. The stored `ownerUserId` is resolved to an active, verified human company member. Paperclip validates the ownership reply's `owner_email` after trimming and case-folding against that verified human email. Agent actors, built-ins, and plugins wait for `owner_required` rather than being provisioned as a human.

New comms-board credentials use a fresh bare-per-bot signed-token subject, `paperclip-agent-<agent UUID>`, with `agentKey: null`; callers do not need to supply a per-call `agent_key`. Existing registered keyed bindings are left exactly as they are: setup does not re-register, rewrite, migrate, fork, or claim that a no-key runtime path works for those legacy keyed bindings.

The setup checkpoints the non-idempotent register and mint calls before making them. A missing response is therefore an unknown result (`board_unknown` or `mint_unknown`), not permission to retry or mint a replacement. Do not document an exact HTTP status for a missing mint result unless the current source explicitly establishes one.

For a dedicated entry, the org connection is a read-only template. Setup creates or reuses the deterministic per-agent connection, copies its catalog/access configuration, and grants only that agent access. A fresh dedicated clone has `mcpSessionRequired: true` for normal gateway use; the org template is not mutated. The template and other agents' dedicated connections remain forbidden even if an install row exists for them. A ready entry is trusted only when the persisted binding, one header reference, active agent grant, usable vault secret, and non-expired token agree.

The comms-board client performs the MCP session sequence before tool use: `initialize` negotiates the protocol version and receives any optional session id; `initialized` and `tools/call` then carry the protocol/session headers, followed by a best-effort `DELETE` for the session. Handshake failure occurs before the tool-call checkpoint and is safely retryable. Once the external register or mint request has been sent, a lost response remains an unknown result and is never retried. `registerAttemptedAt` is checkpointed after a successful handshake and before `tools/call`. Replies are bounded and must match the request id; SSE session notifications are handled as protocol messages. Plaintext `ToolError` handling maps only the narrow classified prefixes and never persists or exposes upstream error text.

The control-plane scopes are explicit: board registration requires `comms:write` plus `comms:admin`, while ownership provisioning uses an ownership token with `ownership:write`. An operator may use an existing profile that denies `comms_register` as a fork-hazard mitigation; this is operator guidance, not a claim that provisioning code enforces that profile.

Before first enablement, run a read-only pre-deploy audit for existing agent metadata containing the protected `defaultMcp` key. It should find zero rows before this rollout; once the feature has created snapshots, nonzero rows are expected. This audit is observational only and must not rewrite absent or null legacy metadata.

## Runtime enforcement and rollback

`loadAgentDefaultMcpState` and `agentInstallsRefused` are the shared enforcement seam used by heartbeat projection, token mint, effective profiles, and gateway access. Missing/foreign agents and malformed metadata are handled as described above; valid managed entries require an explicit agent install, while dedicated templates and other agents' dedicated connections remain forbidden. Runtime projection yields `null` for both missing/foreign agents and malformed metadata; the effective installed set is empty for a refused, valid agent row.

A runtime test call must exercise the managed OFF gate before policy evaluation, rate limiting, upstream invocation, or approval side effects. This route uses `runId: null` and does not create a heartbeat or require one. To prepare the canary, create an agent with `runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }`; agent creation forces it idle, and the operator should immediately pause that agent. The test call itself does not create a run or heartbeat. The test may use scoped instrumentation to show that no secret was decrypted; that evidence is distinct from a live `403 installation_required` and from audit records, and this spec does not promise zero-decrypt behavior based on logs alone.

Protocol request IDs and response IDs must match in both type and value; a numeric or string id is valid only when the response preserves that same type and value.

If an older image is rolled back, its code may no longer enforce the OFF gate. Revoke or clean up affected installs/tokens before rolling back the image; this is an operational warning, not a new lifecycle framework. Disabling the feature flag does not itself revoke a valid ready token or installed access.

## Comms board identity (operator prerequisites)

Setup calls two existing APIs. It needs these server settings:

- `PAPERCLIP_COMMS_BOARD_MCP_URL` and `PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN` (board `comms_admin_register`).
- `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL` and `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN` (ownership `POST /agents`).

All four must be in the initial process environment before the server or Paperclip CLI starts. The CLI deliberately skips these four variables when loading its env file, so a file-only value is not available to the first capture. If tokens are supplied in the environment but either endpoint is absent from that environment, setup remains visibly pending with `provisioner_not_configured` and makes no HTTP request; it does not crash server startup. Put the four values in the launch environment and restart after changing them. The first bootstrap capture is the only source of truth. The server freezes all four captured values, unconditionally deletes both token variables from the live environment during bootstrap, after each supported dotenv load, and after final config loading, and ignores later URL changes for the snapshot. Captured URLs remain in the live environment and may be inherited by default-environment children. The feature flag itself is still read live.

Each URL must be `https` (any host, so a private tailnet works). Plain `http` is allowed only for `127.0.0.1`, `localhost` or `[::1]`. A URL with a user name, a query or a fragment is refused, and the entry waits as `provisioner_config_invalid`. Redirects are never followed.
The ownership reply must name the same token base, be active, and be owned by the verified owner. Any other reply is an unknown result.

The admin and ownership tokens are control-plane credentials. They are never given to an agent.
The agent token has only `comms:read` and `comms:write`. It lives in the company secret store and is bound to the agent connection.
The org must also provide an active `api_key` template connection named `rh-comms-board` with one header credential. Until it exists, the entry stays `pending` and retries.

## Setup state

State is in `agents.metadata.defaultMcp`. Only the server writes it. Setup is durable: a 60-second sweep resumes pending work.
A lost register or mint response is an unknown result. It is never repeated and never rotated automatically.
Newly provisioned per-bot credentials request 365 days (TECH-7268); this default applies to newly issued tokens only, and existing token expirations are unchanged. Automatic rotation is not part of this feature. The existing backend rejects an expired token.

Security and revocation caveats:
- Uninstalling a connection, turning the feature flag OFF, or suspending an agent on the board does not fully revoke a signed JWT offline or invalidate in-flight Bearer tokens.
- Registry deactivation (by a human via Okta) blocks downstream token verification, but is subject to a positive caching window (~300s) and stale-on-outage fallback (up to 24h).
- Manually rotating a credential leaves the old JWT valid until its stored expiration, and reactivating a previously retired sub revives any unexpired tokens minted for that identity.

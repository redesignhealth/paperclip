# Default MCP spec

Every new agent can be offered a short list of MCP apps. The apps start OFF. This feature is off by default.

## Turn it on

Set `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED=true`. When the flag is not `true`, agent creation does not change.
Defaults are not applied retroactively to agents that already exist, *unless* an operator explicitly runs legacy enrollment (TECH-7339, below). Without that explicit step, legacy agents with an absent or null `defaultMcp` value remain unmanaged; existing managed or corrupted state is still enforced independently of the feature flag.

For the RH OAuth entries, also configure the public MCP endpoint variables described in
[Environment Variables](../../docs/deploy/environment-variables.md). The seed sweep only creates
discovery records for valid configured endpoints; it does not contact the endpoint, discover tools,
start OAuth, grant access, wake an agent, or create a credential.

## The spec

`server/src/services/default-mcp-spec.ts` holds the list. Each entry names an org connection (the template) and a `defaultEnabled` value.
To add an app, add one entry. Only an entry with special auth needs a `setupHook`.

- **Ordinary entry:** the agent toggles its eligible connection itself. OAuth consent is never started at create time. OAuth entries with `oauthSeed` first expose a protected discovery seed and require a human's personal connect flow.
- **Dedicated entry (comms board):** the org connection is a read-only template. Setup creates one connection per agent, named `<template>:<agentId>`. Only that connection can be installed or used by the agent. The org template and the connections of other agents are refused.

The current spec includes ReClaw Comms Board, RH Google MCP, and RH MCP. All three have `defaultEnabled: false`, so none is installed by default. Enabling the spec may still run the Comms Board's dedicated provisioning hook when its prerequisites are present; OAuth consent is never started by agent creation. No production authorization or new auth/IAM setup is implied.

### RH Google MCP

RH Google MCP is an OAuth, personal-only entry. When the feature is enabled and
`PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL` is valid, Paperclip creates one protected,
discovery-only seed per eligible company. The seed is a server-managed `draft` connection with
`enabled: false`; it is not installable or callable and has no grants, profile, credential, or
secret. It has no agent metadata, install row, catalog, or profile, and the seeder performs no
network request or agent wake. Its server marker and deterministic UID are implementation
identifiers; the displayed application/connection name is not a canonical identity. The seed is
immutable except for archive (`409 managed_seed_immutable`); its operation is idempotent under a
company/entry advisory lock, and an archived seed is an organization opt-out that is not recreated.
After the consenting owner creates a personal Google instance, that instance's newly discovered
catalog entries remain quarantined until the owner reviews them.

RH MCP uses the same protected seed and personal-connect lifecycle, but its new personal instance
auto-approves only the five Granola read tools listed below; every other discovered tool remains
quarantined. Reconnect preserves existing reviewed or denied choices and does not restore the five
tools after they have been changed. Existing manually created canonical Google or RH MCP
connections, profiles, credentials, and installs are preserved and are not adopted by a seed.
There is no silent OAuth, company-wide binding, or automatic agent grant; new agents remain OFF
until an explicit per-agent install.

The Apps UI's **Connect** action is the only normal path from the seed to a usable connection.
It requires a signed-in human who is an active member of the company and runs the existing OAuth
flow as that user. Paperclip creates or revives that user's personal instance, preserving its
existing grants and reviewed choices when reconnecting. The personal instance cannot be installed
company-wide; only its owner can add it to an agent, and an agent cannot receive two personal
instances for the same entry from different owners. Agent actors and borrowed/admin credentials
are not substitutes for the consenting user.

At runtime, the responsible user for an agent is selected by the existing trusted runtime context.
That user's active membership and personal grant are required; a grant belonging to another user
does not authorize the agent and requires user authorization instead. This is separate from the
agent's creator or owner identity.

The OAuth client, callback, PKCE, and refresh-token handling remain the existing trusted OAuth
path. The public endpoint must not be used to mutate credentials, callback URLs, or auth policy.
Dynamic client registration is the intended first-connect path when the endpoint advertises it;
Paperclip does not require an operator to copy a client secret manually. The configured public
RH endpoint contract exposes protected-resource metadata, authorization-server metadata, and
dynamic registration, with authorization-code and refresh support using S256 PKCE. The production
endpoint examples and first-connect browser flow still require deployment verification; this
spec does not claim that end-to-end OAuth has been exercised merely because the seed exists.

### RH MCP / Granola

The RH MCP entry is `rh-mcp`, displayed as **RH MCP**, and refers to the `rh-mcp-personal` connection. It is an ordinary OAuth entry: it has no setup hook, does not mint an upfront machine JWT or Comms token, and uses the existing per-user OAuth credential vault. A valid template must be an `mcp_remote` + `oauth` + `per_user` connection with `config.identityModel: "personal_only"` and `config.paperclipDefaultMcpEntry: "rh-mcp"`. Once valid, classification-breaking updates to its name, transport, auth kind, or credential policy are rejected before mutation. The protected `config.identityModel` and `config.paperclipDefaultMcpEntry` markers are pinned: attempts to change, clear, or omit them are silently ignored and the existing values are preserved. Benign enabled and URL updates remain allowed for manual canonical connections; the new server-managed seed and personal instance keep their endpoint configuration immutable. These rules preserve the existing classification and add no new security semantics. A missing, ambiguous, or invalid template is treated as unavailable: new agents remain OFF and receive no RH MCP binding or access. A same-named connection without these template properties remains an ordinary connection and is not capped by this entry.

Onboarding has three separate steps:

1. **Operator:** enable the feature and configure the RH MCP endpoint variable. Paperclip creates the protected `rh-mcp-personal` discovery seed when the company is eligible. This is endpoint configuration, not a Granola API-key setup; the upstream URL is not the Paperclip API base. A pre-existing manual canonical `rh-mcp-personal` profile or credential is preserved and is not adopted by the seeder.
2. **Human:** complete the one-time MDM Granola sync at <https://api.core.redesignhealth.com/granola/connect> by signing in with Google, entering a Granola API key on the authenticated key-only page, and selecting **Connect Granola**. Granola access covers `personal` and `public` categories, not workspace data. MDM stores the key encrypted for ingestion; it is not exposed to agents, chat, or prompts.
3. **User:** select **Connect your account** for RH MCP through the normal existing OAuth flow. Native personal OAuth issues access and refresh tokens into the existing vault and uses the user's personal grant; no custom setup or profile wizard is introduced.

For agent access, the effective permission surface is capped to these five read tools: `mdm_granola_status`, `mdm_list_my_granola_notes`, `mdm_list_shared_granola_notes`, `mdm_get_granola_note`, and `mdm_get_granola_transcript`. The ceiling applies to effective agent access, not user sessions. Profile details may still show configured catalog entries; that does not mean every entry is effective or callable. For snapshot-managed agents, company installs, organization grants, and other agents' bindings do not authorize this personal template: access still requires the agent's explicit install and the responsible user's personal grant, membership, and vault-backed credential. Existing legacy rows and bindings are retained for compatibility rather than revoked; a legacy agent may continue to receive these five capped reads only through its typed responsible user's personal grant, membership, and vault-backed credential, never through a shared-organization fallback. No new company-wide promotion is created after personal consent/callback/finalization. Note and transcript visibility are independent server-checked permissions; transcript access is read-only, and a privacy refusal has no fallback to another provider. Existing user controls, custom connections, and legacy Group A entries remain unchanged.

Catalog/profile bindings and scoped fixture tests establish source behavior only; they do not prove that a seed is deployed, that a user has completed consent, that the provider's public endpoint is reachable, or that provider content access is qualified. In particular, direct `*.core.redesignhealth.com` aliases are not documented defaults unless their TLS/SNI configuration is independently validated; use the validated public endpoint values in the environment-variable reference.

## What OFF means

For snapshot-managed agents, an app is ON only with an explicit per-agent install row. A company-wide install, a company profile, or an organization grant does not turn it on. The gateway, token mint, effective profiles and the run projection use one rule. Legacy agents and pre-existing legacy bindings retain their compatibility behavior; this feature does not retroactively revoke them or grant them a shared-organization credential.
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
The company needs an active `api_key` template connection named `rh-comms-board` with one header credential. Paperclip provisions it automatically (see "Company template bootstrap"); an org-authored one with exactly that name and shape is trusted unchanged. Until a usable template exists, the entry stays `pending` (`template_not_found` or `template_provisioning`) and retries.

## Setup state

State is in `agents.metadata.defaultMcp`. Only the server writes it. Setup is durable: a 60-second sweep resumes pending work.
A lost register or mint response is an unknown result. It is never repeated and never rotated automatically.
Newly provisioned per-bot credentials request 365 days (TECH-7268); this default applies to newly issued tokens only, and existing token expirations are unchanged. Automatic rotation is not part of this feature. The existing backend rejects an expired token.

Security and revocation caveats:
- Uninstalling a connection, turning the feature flag OFF, or suspending an agent on the board does not fully revoke a signed JWT offline or invalidate in-flight Bearer tokens.
- Registry deactivation (by a human via Okta) blocks downstream token verification, but is subject to a positive caching window (~300s) and stale-on-outage fallback (up to 24h).
- Manually rotating a credential leaves the old JWT valid until its stored expiration, and reactivating a previously retired sub revives any unexpired tokens minted for that identity.

## Company template bootstrap (TECH-7271)

Per-agent comms identities are cloned from the company's read-only `rh-comms-board` template. Paperclip now provisions that template itself, for every non-archived company, so an operator no longer hand-authors it. This runs under the same `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` flag and needs no new route, table or migration. It reuses the same two server settings as the per-agent setup (`PAPERCLIP_COMMS_BOARD_MCP_URL` for the endpoint and `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_*` for the mint); there is no per-bot or per-company SSM entry, and no board admin credential is used.

### What is created

- One application `rh-comms-board` and one connection with the fixed uid `rh-comms-board/default-mcp-template` (unique per company, unforgeable: client-created uids always carry a random id suffix), `mcp_remote`, `api_key`, `shared`, `mcpSessionRequired`, `quarantineNewEntries`. The endpoint is the frozen boot-time board URL.
- Server-owned markers on `config`: `defaultMcpManaged: "template"` and the durable claim `defaultMcpTemplate` (state `pending`/`in_progress`/`ready`/`error`, frozen owner, `mintAttemptedAt`, `secretId`, `tokenExpiresAt`, `allowlistVersion`, lease and attempt counters). Public create/update payloads have these keys stripped, so a client can never forge, adopt or remove them. The managed template cannot be edited (409 `managed_template_immutable`); archiving it is the one allowed change.
- A per-agent clone of it is marked `defaultMcpManaged: "dedicated"`, keeps `quarantineNewEntries`, and never inherits the claim. A client replacing a dedicated clone's config cannot remove either.

### The credential: 365 days, read-only, discovery only

The template token is minted through the existing ownership API `POST /agents` with the server's existing ownership token: scopes exactly `["comms:read"]`, `expires_in_days: 365`, subject `paperclip-company-template-<company uuid>` (63 characters, no `::`). The scopes come from a closed typed purpose table (`bot` = read+write, `template` = read); there is no caller-supplied scope list, so no code path can request `comms:admin` or `ownership:*`. The per-bot mint is unchanged. The token is stored only in the encrypted vault (deterministic key `default_mcp.comms_board.template`) and is never logged, written to activity, or placed in the claim or connection row. Only ids and closed reason codes are recorded.

The owner it is registered to is an ACTIVE `owner` membership of that company whose user is human with a verified, non-empty email: `defaultResponsibleUserId` when eligible, otherwise the earliest owner (ties by principal id). It is frozen before the first mint. Nobody is invented: with no eligible owner the company waits at `owner_required` and nothing external is called. If an eligible owner's verified-email data would block a real owner, that is reported as a source/read-only data gap; it is not relaxed here. A company's creator becomes its owner right after creation, so an ensure that wins that race waits and the durable sweep completes it.

### Reviewed allowlist (mandatory)

The board catalog lists every board tool regardless of the token's scope. So discovery runs once, then only an exact allowlist is made usable: version 1 is `comms_whoami`, `comms_list_agents`, `comms_lookup_agent_by_email`, `comms_list_conversations`, `comms_get_conversation`, `comms_inbox`, `comms_get_hold_status`, `comms_start_conversation`, `comms_post_message`, `comms_accept`, `comms_decline_invite`, `comms_invite`, `comms_rename_conversation`, `comms_leave`, `comms_extend_conversation`. Those become ACTIVE with `reviewedAt`; every other discovered action is DISABLED. This deliberately excludes `comms_register` (identity fork hazard), the admin tools (`comms_admin_register`, `comms_deregister_agent`, `comms_set_agent_shared`), `proposals_*`, and permanent or privileged conversation operations (`comms_archive_conversation`, `comms_reopen_conversation`). The template's default-deny `app:<id>` profile includes the allowlisted actions only. If discovery finds none of them, the template waits as `catalog_unreviewed`. New tools found later are quarantined by the existing refresh; they are never enabled automatically.

### No company-wide access, ever

The template is provisioning-only and has no install rows and no profile bindings. Every company, agent and gallery install path refuses it with 409 `managed_template_not_installable`, and the runtime install check is false for it regardless of the agent's state, including legacy agents with no `defaultMcp` state, an explicit install row, a company profile binding or a default organization grant. The generic "enable everything for the whole company" profile sync never runs for a managed template or a dedicated clone, on any refresh path (the 15-minute cache, UI refresh, gallery refresh). An install row or binding that appears later is reported as `template_drift` and is NEVER deleted automatically (those are user grants). Existing legacy agents are not retrofitted: no snapshot, install or permission is added to any agent that already exists.

### Flow, collisions and failure policy

1. **Find / adopt / create** (one local transaction, advisory-locked per company). Exactly one valid user-managed `rh-comms-board` (active, `api_key`, `mcp_remote`, one header credential) is trusted unchanged (its token scope and tool review are not inspected here and should be audited separately), with no writes, secrets, profiles, bindings or install changes. More than one, or a malformed one, or a reserved uid without the marker, or a conflicting application, fails closed: nothing is inserted or minted. Our own template archived by an operator is `template_revoked` and is never recreated.
2. **Mint** (the only external write): the checkpoint (`mintAttemptedAt`) is written BEFORE the POST. A 409, any 5xx, a network failure or a contradictory reply is terminal (`ownership_conflict` / `mint_unknown`) and is never retried or rotated. Only a definitive 400/401/403/422 of a locally validated request cannot have created a row; it clears the checkpoint and retries with capped backoff (bounded to 8 attempts). A taken vault key refuses before minting. If the process dies after storing the token but before recording its id, a later claim adopts only the provably owned secret (this company, the fixed key, local-encrypted, our own description, created at or after the checkpoint); anything else is a terminal `mint_unknown`. A store failure after a successful mint is terminal `secret_store_failed`.
3. **Credential + discovery**: a header `Authorization: Bearer` reference to the latest secret version and its bindings (the connection is still a draft), then the existing catalog refresh outside any transaction.
4. **Review + activation** (one local transaction, claim re-checked): the allowlist is applied, the profile reconciled, drift checked, then the connection is activated and the claim is `ready`.

Every checkpoint is a path-scoped write guarded by a random `claimId` (10-minute lease). A stale or losing worker changes nothing, and a stale catalog refresh cannot write back the claim.

A ready template is trusted only while its token is unexpired, its single header credential, vault secret, active/enabled state, empty installs/bindings and the allowlist version agree. A newer allowlist version re-runs discovery and review only (no new mint).

### Expiry is honest, not automatic

The template token lives 365 days. Nothing re-issues it silently. When it expires, or when the template drifts, the claim becomes terminal (`template_expired` / `template_drift`) and NEW agents wait with `template_expired` / `template_failed` instead of cloning a bad template. Existing per-agent clones are unaffected because each has its own token. Re-issuing the template credential is an explicit operator action, and standing issuance infrastructure is a separate ticket (TECH-7269). The same holds for every terminal template state (`mint_unknown`, `ownership_conflict`, `secret_store_failed`, `secret_unavailable`, `template_drift`, `template_expired`, `template_revoked`): the sweep never retries them, archiving the template does not recreate it, and recovery is an explicit operator action outside this feature (an unknown mint may have left a live registry row, which is why it is never repeated). Agents waiting on a template that has just become ready (`template_not_found`, `template_provisioning`, `template_unsupported`, `template_ambiguous`) get a path-only `nextAttemptAt` nudge so the next sweep picks them up; no other agent metadata is touched.

### Scope and rollout

The sweep (25 companies per 60-second tick, running before the per-agent sweep under the same flag and the same running guard) plus a create hook and a reactivate hook (both scheduled after their commit, never inside a transaction, tracked until finished) cover every `active` or `paused` company. Archived companies are excluded until reactivated; paused companies are eligible. Outcomes with no durable state (no eligible owner, collisions) are re-tried with in-process spacing (30 seconds doubling to 10 minutes) so they can never starve the sweep.

`PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS` is the single rollout scope for the whole default-MCP provisioning feature (the name says "template" for historical reasons; there is no second knob). It bounds BOTH the company template provisioning AND every per-agent claim, register and mint. It is parsed from the deployment environment once at the first bootstrap import and frozen (the CLI `.env` preload reserves the key, like the provisioner settings): unset = every company; set to an empty string = no company; a comma-separated UUID list = exactly those companies; anything malformed (a wildcard, a non-UUID, an empty entry) = NO company. Malformed input never widens the scope. Before the bootstrap capture the scope is also none. The final state is to leave it unset (all companies); no pilot company ids are hardcoded.

The same frozen predicate is applied before the eager per-agent claim, the agent sweep query and every external register/mint call. A company outside the scope is left completely untouched: no claim, no register, no mint, no verify-ready repair, no activity, and no `nextAttemptAt` change, even when it already has a valid template. In particular an existing valid USER-managed `rh-comms-board` template outside the scope yields NO register and NO mint for any agent of that company, so an empty scope is true containment and not only a template-provisioning stop. Ready entries, installs and metadata outside the scope are preserved exactly as they are. Agent creation still takes the local default-OFF snapshot (nothing external), so an agent created while its company is out of scope simply stays `pending` until the scope includes it. Per-agent behavior inside the scope is unchanged. Test suites that exercise per-agent setup therefore freeze an "unset" scope (all companies) at the start of each test.

After the pre-production tests pass, the intended rollout is the global default ON for every non-archived existing and future company, with per-agent access still OFF until an explicit install. This feature never installs, wakes or creates agent rows.

### Review hardening details (TECH-7271)

- **Immutable profile and exact allowlist.** The managed template's `app:<id>` access profile refuses every service mutation with 409 `managed_template_immutable`: add/update/delete of entries, the new-tools "allow" review, `updateProfile` (including `defaultAction`, `entries` and a `profileKey` re-key that would otherwise silently disable the guard), `deleteProfile` (including `force`, and as a `reassignToProfileId` target) and `bindProfile`. Unmanaged profiles are unaffected. A ready template is also verified against the EXACT reviewed allowlist: an ACTIVE action outside it, a profile entry that is not an include of an allowlisted action of this connection, an empty allowlist or an empty profile are all `template_drift` (terminal, reported, never auto-repaired). The per-agent clone repeats the filter and fails closed: non-allowlisted actions are cloned disabled, only allowlisted includes are copied, an existing clone re-run is narrowed the same way, and a managed template with no reviewed allowlist in the spec clones nothing usable (`template_unsupported`).
- **Owned-secret recovery.** After a crash between storing the token and recording its id, only a secret that is provably ours is adopted: this company, the fixed key, `local_encrypted`, our description, created by the frozen owner, and created at or after the checkpoint minus a bounded 30-second tolerance for app/database clock skew. Minting is refused while any active secret holds the key, so a foreign or pre-existing secret can never fall inside that window.
- **Same-name ambiguity.** The fixed-uid template is not exempt: a second unarchived `rh-comms-board` connection is reported as `template_ambiguous` (nothing claimed, minted or changed), and per-agent setup waits with the same reason until the operator archives the stray connection.
- **Agent setup after the credential exists.** If the template becomes unusable after an agent's register/mint, only transient reasons (`template_not_found`, `template_provisioning`, `template_ambiguous`) wait without budget. For a Paperclip-managed template the terminal reasons (`template_failed`, `template_expired`, `template_unsupported`) are bounded by the retry budget and end in `error`. An org-authored (user-managed) template is never terminal in that sense: while it is temporarily disabled or edited the agent keeps waiting (for example `template_unsupported`), and it resumes when the template is restored. Neither case repeats register or mint, and the stored credential and binding are kept. The 8-attempt budget is the entry's single `attemptCount`, which every claim increments, including the uncapped waiting ones, and it is checked when a retry result is stored. So the budget is SHARED, not a fresh 8: an agent that waited 9 or more times before a managed terminal state gets `error` on its first terminal result. An unexpected local failure is retried as `binding_failed` and logged by error class only.
- A `waiting` or `error` state does not revoke the retained JWT: it remains until actual expiry or explicit issuer-side revocation. Local disable/install-OFF state, secret deletion, and board `isSuspended` status are not full offline-JWT revocation.
- **Claim format and compatibility.** The claim is `version: 1` with the full structure validated on read (non-empty `entryKey`, `principalSub`, `ownerUserId`, `ownerEmailNorm`, `updatedAt`; a non-negative integer `attemptCount`; a positive integer `allowlistVersion` when set; string-or-null elsewhere). A claim that fails validation is never trusted (`template_unsupported` / `template_failed`). This is the first build that writes any managed template claim: none was ever deployed before it, so no older claim format exists and no migration or backfill is provided. If an operator ever finds a malformed row, the supported action is to quarantine it (archive it), which is terminal and never recreated, and then repair manually.
- **Rollout implication.** With the scope unset (the final target: every non-archived company; any staged pilot list is only an intermediate step) each company gets exactly one 365-day, `comms:read`-only template credential, minted through the existing ownership API. Per-agent access stays OFF until an explicit install, and the template is never installable.

## Legacy agent enrollment (TECH-7339)

`server/src/services/default-mcp-legacy-enrollment.ts` is the supported path for bringing agents
created before this feature existed up to the same state as a new agent. It reuses
`snapshotDefaultMcpForNewAgent`/`scheduleDefaultMcpSetup` verbatim: an enrolled legacy agent is not
distinguishable from one created after the feature shipped, and no client metadata PATCH, direct SQL
edit or one-off token script is involved.

It is invoked per company via `POST /companies/:companyId/default-mcp/legacy-enrollment`
(`dryRun`, `limit`, `afterId` in the body), gated the same way agent creation is: the feature flag
must be on, and the company must be inside `PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS`. Only a
company connection manager (owner/admin membership, `tools:manage_connections`, or an instance admin)
may call it.

Only an agent whose `defaultMcp` key is absent or null is eligible; this is the same legacy/unmanaged
definition used everywhere else in this document. An agent whose key is present but fails validation
is reported as `corrupted_existing_state` and left untouched rather than silently replaced -- that
state already fails closed at runtime (see "What OFF means" above), and enrollment does not
second-guess it. An already-enrolled agent is a silent no-op on a repeat pass: no duplicate identity,
connection, binding or credential is created. A row lock around the read-classify-write step makes
two overlapping enrollment calls on the same agent resolve to exactly one enrollment.

The owner recorded on a newly enrolled agent's entries is `resolveLegacyResponsibleUser`'s result:
the earliest verified-human actor on that specific agent's own `agent.created`/`agent.hire_created`
activity, or (if it was created by an agent or built-in) its earliest `agent.approved` activity.
There is no company-wide fallback -- a known candidate who isn't an active, verified-email company
member is treated the same as no candidate at all (`owner_required`), never silently substituted
with the company's owner/admin. Comms-board credential issuance still goes through the existing
`commsBoardIdentityHook`, which independently re-resolves and verifies that owner against active
company membership before minting; enrollment does not shortcut that check.

This endpoint only ever sets `agents.metadata.defaultMcp` and schedules the existing setup hooks. For
a genuinely legacy agent it goes through the identical install/curated-profile logic
`snapshotDefaultMcpForNewAgent` already applies to new agents; it never touches an agent that already
has a `defaultMcp` snapshot, so existing per-agent install choices made through any other path are
never overwritten by this endpoint.

Becoming snapshot-managed changes which installs count for an ordinary (non-dedicated) entry: see
"What OFF means" above -- only an explicit per-agent install applies once an agent has `defaultMcp`
state, where before enrollment a company-wide install applied too. Left alone, enrollment would
silently revoke access a company-wide install was granting a legacy agent, with no row ever changing.
Before snapshotting, enrollment inspects each ordinary entry's existing agent-or-company install: an
existing install that maps unambiguously to one valid template is carried forward as an explicit
per-agent install (the entry comes up ON, through the same reviewed install path a default-ON entry
uses); an existing install that can't be safely attributed to one valid template (an ambiguous
same-name collision, or a connection that fails the entry's template requirements) is never guessed
at -- the whole agent is skipped and reported as `legacy_access_conflict` rather than partially
enrolled.

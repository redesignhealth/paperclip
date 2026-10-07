/**
 * Default MCP spec (TECH-7204).
 *
 * A declarative list of MCP connections every NEW agent is offered. It reuses the
 * existing company tool-connection machinery: an entry names a company
 * `tool_connections` row (by connection name); nothing here is a parallel registry.
 *
 * Adding another ordinary MCP is one more entry. Only an entry that needs special
 * auth names a `setupHook`, and hooks are looked up by key, so creation stays generic.
 *
 * Applies only to agents created after the feature is enabled. Existing agents are
 * never read or written by this module.
 */

/** `managed_token`: Paperclip provisions + stores a per-agent token. `oauth`/`none`: no provisioning. */
export type DefaultMcpAuthKind = "managed_token" | "oauth" | "none";

export type DefaultMcpSetupHookKey = "comms_board_identity";

export interface DefaultMcpEntrySpec {
  /** Stable MCP identifier. Persisted on the agent, never derived from a display name. */
  key: string;
  displayName: string;
  /**
   * Exact `tool_connections.name` of the company's org connection this entry refers to. That
   * connection is a READ-ONLY template: it is never modified, and for `managed_token` entries
   * a dedicated per-agent connection is derived from it.
   */
  connectionName: string;
  authKind: DefaultMcpAuthKind;
  /** When false the agent gets the entry OFF: recorded, but no install row is created. */
  defaultEnabled: boolean;
  /** Optional per-MCP setup run after the agent row commits. Only special auth needs one. */
  setupHook?: DefaultMcpSetupHookKey;
  /**
   * When true, Paperclip itself provisions the company's read-only template connection (TECH-7271,
   * `default-mcp-template.ts`) instead of requiring an operator-authored one. Requires `reviewedTools`.
   */
  templateBootstrap?: boolean;
  /**
   * The reviewed action allowlist for a bootstrapped template. The board's catalog lists EVERY tool
   * regardless of token scope, so the allowlist is mandatory: only the exact names below become ACTIVE;
   * every other discovered action is DISABLED. Bump `version` when the list changes.
   */
  reviewedTools?: { version: number; allow: readonly string[] };
}

/**
 * Reviewed comms-board actions an agent may use (version 1). Deliberately excludes `comms_register`
 * (identity fork hazard), the admin tools (`comms_admin_register`, `comms_deregister_agent`,
 * `comms_set_agent_shared`), the `proposals_*` tools, and the permanent/privileged conversation
 * operations (`comms_archive_conversation`, `comms_reopen_conversation`).
 */
export const COMMS_BOARD_REVIEWED_TOOLS_VERSION = 1;
export const COMMS_BOARD_REVIEWED_TOOLS: readonly string[] = Object.freeze([
  "comms_whoami",
  "comms_list_agents",
  "comms_lookup_agent_by_email",
  "comms_list_conversations",
  "comms_get_conversation",
  "comms_inbox",
  "comms_get_hold_status",
  "comms_start_conversation",
  "comms_post_message",
  "comms_accept",
  "comms_decline_invite",
  "comms_invite",
  "comms_rename_conversation",
  "comms_leave",
  "comms_extend_conversation",
]);

export const DEFAULT_MCP_SPEC_ENABLED_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

export const DEFAULT_MCP_SPEC: readonly DefaultMcpEntrySpec[] = [
  {
    key: "comms-board",
    displayName: "ReClaw Comms Board",
    connectionName: "rh-comms-board",
    authKind: "managed_token",
    defaultEnabled: false,
    setupHook: "comms_board_identity",
    templateBootstrap: true,
    reviewedTools: { version: COMMS_BOARD_REVIEWED_TOOLS_VERSION, allow: COMMS_BOARD_REVIEWED_TOOLS },
  },
  {
    // OAuth is left to the existing per-user consent flow. Creating an agent never starts it.
    key: "rh-google-mcp",
    displayName: "RH Google MCP",
    connectionName: "rh-google-mcp",
    authKind: "oauth",
    defaultEnabled: false,
  },
];

/** Feature guard. Default OFF: unless explicitly "true", agent creation is unchanged. */
export function isDefaultMcpSpecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEFAULT_MCP_SPEC_ENABLED_ENV]?.trim().toLowerCase() === "true";
}

export type DefaultMcpSetupState =
  | "not_required"
  | "pending"
  | "in_progress"
  | "ready"
  | "error";

/** Closed set of non-secret reason codes. Free-form upstream text is never persisted. */
export type DefaultMcpSetupReason =
  // Waiting (nothing external attempted yet): retried automatically.
  | "provisioner_not_configured"
  | "provisioner_config_invalid"
  | "owner_required"
  | "awaiting_approval"
  | "template_not_found"
  | "template_ambiguous"
  | "template_unsupported"
  // Managed company template (TECH-7271) not usable yet: retried automatically, never cloned while bad.
  | "template_provisioning"
  | "template_failed"
  | "template_expired"
  // Definitive refusals (no state was created): terminal, operator action needed.
  | "board_conflict"
  | "board_rejected"
  | "board_failed"
  | "ownership_conflict"
  | "ownership_rejected"
  | "ownership_failed"
  | "invalid_subject"
  // Managed company template (TECH-7271) terminal/operator states.
  | "template_revoked"
  | "template_drift"
  | "template_discovery_failed"
  | "catalog_unreviewed"
  // Unknown outcome of a non-idempotent POST: terminal, never retried or rotated blindly.
  | "board_unknown"
  | "mint_unknown"
  // Token lost after a successful mint, or its vault secret was deleted/disabled: terminal, never re-minted.
  | "secret_store_failed"
  | "secret_unavailable"
  // Retryable once a secret exists (bounded).
  | "binding_failed"
  | "provisioner_failed"
  | "interrupted"
  | "attempts_exhausted";

/** Retry policy for automatic setup. */
export const DEFAULT_MCP_LEASE_MS = 10 * 60_000;
export const DEFAULT_MCP_MAX_ATTEMPTS = 8;
export const DEFAULT_MCP_BACKOFF_BASE_MS = 60_000;
export const DEFAULT_MCP_BACKOFF_MAX_MS = 60 * 60_000;

export function defaultMcpBackoffMs(attemptCount: number): number {
  return Math.min(DEFAULT_MCP_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1), DEFAULT_MCP_BACKOFF_MAX_MS);
}

// ---------------------------------------------------------------------------
// Managed company template (TECH-7271)
// ---------------------------------------------------------------------------

/**
 * Server-owned markers on `tool_connections.config`. They are stripped from every public create/update
 * payload, so a client can never forge, adopt or remove them.
 *  - `defaultMcpManaged: "template"`: the Paperclip-provisioned company template (never installable).
 *  - `defaultMcpManaged: "dedicated"`: a per-agent clone of a managed template (refresh never widens it).
 *  - `defaultMcpTemplate`: the durable provisioning claim of the template (see `DefaultMcpTemplateClaim`).
 */
export const DEFAULT_MCP_MANAGED_CONFIG_KEY = "defaultMcpManaged";
export const DEFAULT_MCP_TEMPLATE_CONFIG_KEY = "defaultMcpTemplate";
/** Fixed, unforgeable `tool_connections.uid` (client-created uids always carry a random id suffix). */
export const DEFAULT_MCP_TEMPLATE_UID = "rh-comms-board/default-mcp-template";
export const DEFAULT_MCP_PROTECTED_CONFIG_KEYS = [DEFAULT_MCP_MANAGED_CONFIG_KEY, DEFAULT_MCP_TEMPLATE_CONFIG_KEY] as const;

function managedMarker(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  return (config as Record<string, unknown>)[DEFAULT_MCP_MANAGED_CONFIG_KEY];
}

/** True for the Paperclip-provisioned company template, regardless of any agent's legacy/managed state. */
export function isManagedTemplate(config: unknown): boolean {
  return managedMarker(config) === "template";
}

/** True for a per-agent clone of a managed template. */
export function isManagedDedicated(config: unknown): boolean {
  return managedMarker(config) === "dedicated";
}

/** Copy of `config` without the server-owned markers (for public create/update payloads). */
export function stripDefaultMcpProtectedConfigKeys<T extends Record<string, unknown>>(config: T): T {
  const next = { ...config };
  for (const key of DEFAULT_MCP_PROTECTED_CONFIG_KEYS) delete next[key];
  return next;
}

export type DefaultMcpTemplateClaimState = "pending" | "in_progress" | "ready" | "error";

/** The durable provisioning claim stored at `config.defaultMcpTemplate` of the template row. */
export interface DefaultMcpTemplateClaim {
  version: 1;
  entryKey: string;
  /** `paperclip-company-template-<company uuid>`: the comms:read-only token subject. */
  principalSub: string;
  /** Verified human owner, frozen before the first mint. */
  ownerUserId: string;
  ownerEmailNorm: string;
  state: DefaultMcpTemplateClaimState;
  reason: DefaultMcpSetupReason | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  claimId: string | null;
  /** Written BEFORE the ownership mint POST. Present without a stored secret means outcome unknown. */
  mintAttemptedAt: string | null;
  secretId: string | null;
  tokenExpiresAt: string | null;
  allowlistVersion: number | null;
  readyAt: string | null;
  updatedAt: string;
}

/** Lenient read of the claim: null unless the stored value is an object with a valid `state`. */
export function readTemplateClaim(config: unknown): DefaultMcpTemplateClaim | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const raw = (config as Record<string, unknown>)[DEFAULT_MCP_TEMPLATE_CONFIG_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const claim = raw as Partial<DefaultMcpTemplateClaim>;
  if (claim.version !== 1) return null;
  if (!["pending", "in_progress", "ready", "error"].includes(String(claim.state))) return null;
  return claim as DefaultMcpTemplateClaim;
}

/**
 * Non-secret reference to the provisioned comms identity. Holds ids and the secret
 * reference only. Identity binding is not proof of token possession.
 */
export interface DefaultMcpBindingRef {
  /** Board agent UUID, captured from `comms_admin_register`'s result. Never guessed from the token. */
  boardAgentId: string | null;
  /** Board token base subject (`paperclip-agent-<agentId>`, never contains "::"). */
  baseSub: string;
  /** Fixed agent key, persisted once at registration and never re-derived from a mutable name. */
  agentKey: string | null;
  /** Board subject: bare baseSub for fresh registrations, or legacy composed `<baseSub>::<agentKey>`. */
  boardSub: string | null;
  secretId: string | null;
  secretVersion: number | "latest" | null;
  /** Dedicated per-agent connection (also on the entry as `connectionId`). */
  connectionId: string | null;
  grantId: string | null;
  tokenExpiresAt: string | null;
}

export interface DefaultMcpEntryState {
  key: string;
  /**
   * The spec's `connectionName` frozen at creation. Matching a connection later (including a template
   * created AFTER this agent) uses this, never the current global spec, so a spec edit can't re-scope old agents.
   */
  templateKey: string;
  /** Whether the entry gets a dedicated per-agent connection (named `<templateKey>:<agentId>`). Frozen at creation. */
  dedicated: boolean;
  /** The default the agent was given at creation. Effective install state is derived from install rows. */
  enabled: boolean;
  /** Org template connection found at creation (read-only; null when absent). */
  templateConnectionId: string | null;
  /**
   * The connection the agent's install toggle governs: the template itself for ordinary entries, or
   * the dedicated per-agent connection once setup created it.
   */
  connectionId: string | null;
  /**
   * Verified human owner, frozen at creation from the server-side actor. Null for agent actors,
   * built-ins and plugins (setup then waits at `owner_required`).
   */
  ownerUserId: string | null;
  setup: {
    state: DefaultMcpSetupState;
    reason: DefaultMcpSetupReason | null;
    attemptCount: number;
    /** Earliest time the sweep may claim this entry again while `pending`. */
    nextAttemptAt: string | null;
    /** A claim is stale once this has passed. */
    leaseUntil: string | null;
    /** Random id of the current claim. Checkpoint and final writes only land while it still matches. */
    claimId: string | null;
    /** Written BEFORE the board register POST. Present without a board UUID means outcome unknown. */
    registerAttemptedAt: string | null;
    /** Written BEFORE the ownership mint POST. Present without a stored secret means outcome unknown. */
    mintAttemptedAt: string | null;
    updatedAt: string;
  };
  binding: DefaultMcpBindingRef | null;
}

export interface DefaultMcpAgentState {
  version: 1;
  entries: Record<string, DefaultMcpEntryState>;
}

/** Reserved agent.metadata key. Server-managed: user-supplied values are discarded. */
export const DEFAULT_MCP_METADATA_KEY = "defaultMcp";

export function stripReservedDefaultMcpMetadata(
  incoming: unknown,
  existing?: unknown,
): Record<string, unknown> | null | undefined {
  const preserved =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)[DEFAULT_MCP_METADATA_KEY]
      : undefined;
  if (incoming === undefined) return undefined;
  if (incoming === null) return preserved === undefined ? null : { [DEFAULT_MCP_METADATA_KEY]: preserved };
  if (typeof incoming !== "object" || Array.isArray(incoming)) return incoming as never;
  const next = { ...(incoming as Record<string, unknown>) };
  delete next[DEFAULT_MCP_METADATA_KEY];
  if (preserved !== undefined) next[DEFAULT_MCP_METADATA_KEY] = preserved;
  return next;
}

export function readDefaultMcpState(metadata: unknown): DefaultMcpAgentState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[DEFAULT_MCP_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Partial<DefaultMcpAgentState>;
  if (state.version !== 1 || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) return null;
  // Malformed (non-object / setup-less) entries are ignored, never trusted and never allowed to throw.
  const entries: Record<string, DefaultMcpEntryState> = {};
  for (const [key, entry] of Object.entries(state.entries)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const setup = (entry as { setup?: unknown }).setup;
    if (!setup || typeof setup !== "object" || Array.isArray(setup)) continue;
    entries[key] = entry as DefaultMcpEntryState;
  }
  return { version: 1, entries };
}

/**
 * Metadata-only (ADVISORY) read of the persisted board binding: null unless the entry is marked ready
 * and the token has not expired. It does not look at the grant, connection or vault, so it is never
 * authoritative; use `resolveCommsBoardBinding` (default-mcp-setup.ts) for a validated, fail-closed
 * lookup. Contains no secret value.
 */
export function readCommsBoardBindingReference(metadata: unknown): DefaultMcpBindingRef | null {
  const entry = readDefaultMcpState(metadata)?.entries["comms-board"];
  if (!entry || entry.setup.state !== "ready" || !entry.binding) return null;
  // An expired token is not ready. Rotation is out of scope: this only stops advertising a dead credential.
  if (entry.binding.tokenExpiresAt && Date.parse(entry.binding.tokenExpiresAt) <= Date.now()) return null;
  const { boardAgentId, baseSub, agentKey, boardSub, secretId, secretVersion, connectionId, grantId, tokenExpiresAt } = entry.binding;
  return { boardAgentId, baseSub, agentKey, boardSub, secretId, secretVersion, connectionId, grantId, tokenExpiresAt };
}

export type ManagedConnectionRole = "managed" | "forbidden" | null;

/**
 * How this agent's default-MCP state classifies a connection (company-scoped; another company's
 * connection is never classified):
 *  - `managed`: the agent's own connection for an entry (the org template for an ORDINARY entry, the
 *    STORED dedicated connection id for a dedicated entry). Needs an explicit per-agent install.
 *  - `forbidden`: for a DEDICATED entry the org template is provisioning-only, and so is any other
 *    `<templateKey>:` dedicated connection (another agent's). Never installable or usable by this
 *    agent, even with an explicit install, and even before its own connection is provisioned.
 *  - `null`: unrelated to the default-MCP state (legacy agents always get this).
 */
export function managedConnectionRole(
  state: DefaultMcpAgentState | null,
  agentCompanyId: string,
  connection: { id: string; companyId: string; name: string; config?: unknown },
): ManagedConnectionRole {
  if (!state || connection.companyId !== agentCompanyId) return null;
  let role: ManagedConnectionRole = null;
  for (const entry of Object.values(state.entries ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const key = typeof entry.templateKey === "string" && entry.templateKey.length > 0 ? entry.templateKey : null;
    if (entry.dedicated) {
      // Ownership is the STORED binding id only; the frozen name prefix never authorizes anything.
      if (entry.connectionId && connection.id === entry.connectionId) return "managed";
      if (
        connection.id === entry.templateConnectionId ||
        (key !== null && (connection.name === key || connection.name.startsWith(`${key}:`)))
      ) {
        role = "forbidden";
      }
    } else if (
      connection.id === entry.connectionId ||
      connection.id === entry.templateConnectionId ||
      (key !== null && connection.name === key)
    ) {
      role ??= "managed";
    }
  }
  return role;
}

/** Whether the connection is related to the agent's default-MCP state at all (managed or forbidden). */
export function managedConnectionMatch(
  state: DefaultMcpAgentState | null,
  agentCompanyId: string,
  connection: { id: string; companyId: string; name: string },
): boolean {
  return managedConnectionRole(state, agentCompanyId, connection) !== null;
}

/**
 * The single install-eligibility rule shared by the runtime projection, token mint, effective
 * profiles and the gateway. Callers must check agent refusal first (missing agent or malformed
 * metadata fails closed; see `agentInstallsRefused`). A `managed` connection needs an EXPLICIT
 * per-agent install (a company install never authorizes it); a `forbidden` one is never authorized
 * by any install. Agents without `defaultMcp` state and unrelated connections are unchanged.
 */
export function installAppliesToAgent(
  install: { targetType: string },
  agent: { companyId: string; state: DefaultMcpAgentState | null },
  connection: { id: string; companyId: string; name: string; config?: unknown },
): boolean {
  // The Paperclip-provisioned company template is never installable, for ANY agent: legacy agents with
  // no `defaultMcp` state included, and regardless of company-wide or per-agent install rows.
  if (isManagedTemplate(connection.config)) return false;
  const role = managedConnectionRole(agent.state, agent.companyId, connection);
  if (role === "forbidden") return false;
  return install.targetType !== "company" || role === null;
}

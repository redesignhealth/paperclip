import { badRequest } from "../errors.js";

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
  /**
   * Optional declarative template check (TECH-7276). When present, a same-named connection is only
   * this entry's template if it ALSO is an `mcp_remote` + `oauth` + `per_user` connection pinned
   * `config.identityModel === identityModel` and tagged `config.paperclipDefaultMcpEntry === key`.
   * Anything else is not a valid personal template for new snapshot-managed state: it receives no valid
   * personal-template binding, curated profile, install, or read ceiling at creation. Existing state still
   * uses its frozen templateKey/name matching for the default-OFF gate, including the compatibility case
   * where a same-named connection is invalid or untagged; this does not create a valid personal-template
   * binding or a six-fact read ceiling.
   */
  templateRequirements?: { identityModel: "personal_only" };
  /**
   * Optional raw upstream tool names an AGENT may use on a VALID template (TECH-7276). It only ever
   * removes permissions (it never adds a tool to a profile) and never applies to user sessions.
   */
  readCeiling?: readonly string[];
  /** Optional OAuth discovery-only seed configuration (TECH-7340). */
  oauthSeed?: {
    urlEnv: string;
  };
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
    oauthSeed: {
      urlEnv: "PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL",
    },
  },
  {
    // Personal-only OAuth (per-user grant for valid snapshot-managed state). Agents get only the read ceiling
    // below on a template that passes `templateRequirements`; same-named invalid/untagged connections do not
    // qualify for the personal binding, curated profile, install, or ceiling, while legacy name matching is
    // retained for the existing default-OFF compatibility gate.
    key: "rh-mcp",
    displayName: "RH MCP",
    connectionName: "rh-mcp-personal",
    authKind: "oauth",
    defaultEnabled: false,
    templateRequirements: { identityModel: "personal_only" },
    readCeiling: [
      "mdm_granola_status",
      "mdm_list_my_granola_notes",
      "mdm_list_shared_granola_notes",
      "mdm_get_granola_note",
      "mdm_get_granola_transcript",
    ],
    oauthSeed: {
      urlEnv: "PAPERCLIP_DEFAULT_MCP_RH_MCP_URL",
    },
  },
];

/** Connection config key an operator sets to mark a connection as the template of a default-MCP entry. */
export const DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY = "paperclipDefaultMcpEntry";

export type TemplateFacts = {
  name: string;
  transport: string;
  authKind: string;
  credentialPolicy: string;
  config: unknown;
};

/**
 * Whether a connection is a VALID template for a spec entry that declares `templateRequirements`:
 * the exact name AND transport, auth kind, credential policy, pinned identity model and entry tag.
 * A name alone never qualifies. Entries without requirements are always valid (existing behavior).
 */
export function isValidDefaultMcpTemplate(
  entry: Pick<DefaultMcpEntrySpec, "key" | "connectionName" | "templateRequirements">,
  connection: TemplateFacts,
): boolean {
  if (connection.name !== entry.connectionName) return false;
  const requirements = entry.templateRequirements;
  if (!requirements) return true;
  const config =
    connection.config && typeof connection.config === "object" && !Array.isArray(connection.config)
      ? (connection.config as Record<string, unknown>)
      : {};
  return (
    connection.transport === "mcp_remote" &&
    connection.authKind === "oauth" &&
    connection.credentialPolicy === "per_user" &&
    config.identityModel === requirements.identityModel &&
    config[DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY] === entry.key
  );
}

/**
 * The raw upstream tool names an AGENT may use on this connection, or null when no ceiling applies
 * (not a valid template of an entry that declares `readCeiling`; user sessions never call this).
 */
export function agentReadCeilingForConnection(
  connection: TemplateFacts,
  spec: readonly DefaultMcpEntrySpec[] = DEFAULT_MCP_SPEC,
): ReadonlySet<string> | null {
  for (const entry of spec) {
    if (!entry.readCeiling) continue;
    if (entry.templateRequirements && isValidDefaultMcpTemplate(entry, connection)) {
      return new Set(entry.readCeiling);
    }
    const config =
      connection.config && typeof connection.config === "object" && !Array.isArray(connection.config)
        ? (connection.config as Record<string, unknown>)
        : {};
    if (
      isPersonalDefaultMcpInstance(connection, spec) &&
      config[DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY] === entry.key
    ) {
      return new Set(entry.readCeiling);
    }
  }
  return null;
}

/**
 * Whether the connection is a VALID template of a spec entry that declares `templateRequirements` (a
 * personal default-MCP template) or a strict personal default-MCP instance (TECH-7340). Callers use it
 * to avoid company-wide defaults for such a connection.
 */
export function isPersonalDefaultMcpTemplate(
  connection: TemplateFacts,
  spec: readonly DefaultMcpEntrySpec[] = DEFAULT_MCP_SPEC,
): boolean {
  return (
    spec.some((entry) => Boolean(entry.templateRequirements) && isValidDefaultMcpTemplate(entry, connection)) ||
    isPersonalDefaultMcpInstance(connection, spec)
  );
}

/**
 * Asserts that an update to a currently-valid personal default-MCP template does not break its
 * template classification (name, transport, authKind, credentialPolicy, identityModel, and entry tag).
 *
 * In service callers such as updateConnection, identityModel and the entry tag are authoritative
 * in connection.config and pinned from the existing connection, while transportConfig is ignored by
 * template classification. Direct callers with candidate must still satisfy all classification
 * requirements. Non-templates and benign updates pass through without error.
 */
export function assertPersonalDefaultMcpTemplateUpdateValid(
  existing: TemplateFacts,
  candidate: TemplateFacts,
  spec: readonly DefaultMcpEntrySpec[] = DEFAULT_MCP_SPEC,
): void {
  for (const entry of spec) {
    if (!entry.templateRequirements) continue;
    if (isValidDefaultMcpTemplate(entry, existing) && !isValidDefaultMcpTemplate(entry, candidate)) {
      throw badRequest(
        `Personal default-MCP template '${existing.name}' classification fields are immutable (name, transport, auth kind, credential policy, identity model, and entry tag must match default entry '${entry.key}').`,
      );
    }
  }
}

/** Whether an agent may see or call `upstreamToolName` on `connection` (true when no ceiling applies). */
export function agentMayUseConnectionTool(
  connection: TemplateFacts,
  upstreamToolName: string | null | undefined,
  spec: readonly DefaultMcpEntrySpec[] = DEFAULT_MCP_SPEC,
): boolean {
  const ceiling = agentReadCeilingForConnection(connection, spec);
  return !ceiling || (typeof upstreamToolName === "string" && ceiling.has(upstreamToolName));
}

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
  const marker = (config as Record<string, unknown>)[DEFAULT_MCP_MANAGED_CONFIG_KEY];
  if (marker !== undefined) return marker;
  if ("config" in config && config.config && typeof config.config === "object" && !Array.isArray(config.config)) {
    return (config.config as Record<string, unknown>)[DEFAULT_MCP_MANAGED_CONFIG_KEY];
  }
  return undefined;
}

/** True for the Paperclip-provisioned company template, regardless of any agent's legacy/managed state. */
export function isManagedTemplate(config: unknown): boolean {
  return managedMarker(config) === "template";
}

/** True for a per-agent clone of a managed template. */
export function isManagedDedicated(config: unknown): boolean {
  return managedMarker(config) === "dedicated";
}

/** True for a discovery-only seed row (TECH-7340). Non-installable and non-callable. */
export function isDefaultMcpSeed(config: unknown): boolean {
  return managedMarker(config) === "seed";
}

/**
 * True for a strict personal default-MCP instance row (TECH-7340):
 * mcp_remote + oauth + per_user + identityModel personal_only + tagged with defaultMcp entry key
 * + defaultMcpManaged === "personal".
 */
export function isPersonalDefaultMcpInstance(
  connection: TemplateFacts | { transport?: string; authKind?: string; credentialPolicy?: string; config?: unknown },
  spec: readonly DefaultMcpEntrySpec[] = DEFAULT_MCP_SPEC,
): boolean {
  if (!connection) return false;
  const config =
    connection.config && typeof connection.config === "object" && !Array.isArray(connection.config)
      ? (connection.config as Record<string, unknown>)
      : {};
  if (config[DEFAULT_MCP_MANAGED_CONFIG_KEY] !== "personal") return false;
  if (connection.transport !== "mcp_remote") return false;
  if (connection.authKind !== "oauth") return false;
  if (connection.credentialPolicy !== "per_user") return false;
  if (config.identityModel !== "personal_only") return false;
  const entryTag = config[DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY];
  if (typeof entryTag !== "string" || !entryTag) return false;
  return spec.some((entry) => entry.key === entryTag && entry.authKind === "oauth");
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

const CLAIM_STATES = ["pending", "in_progress", "ready", "error"];
const CLAIM_REQUIRED_STRINGS = ["entryKey", "principalSub", "ownerUserId", "ownerEmailNorm"] as const;
const CLAIM_NULLABLE_STRINGS = ["reason", "nextAttemptAt", "leaseUntil", "claimId", "mintAttemptedAt", "secretId", "tokenExpiresAt", "readyAt"] as const;

/**
 * Structural read of the claim, failing closed: null unless the stored value is a versioned object with a known
 * state, non-empty string identity fields (entry key, principal sub, owner id and email) and `updatedAt`, a
 * non-negative integer attempt count, a positive integer allowlist version when set, and string-or-null for every
 * nullable field. Callers assume those fields, so a malformed (forged or corrupted)
 * claim is never trusted: it reads as "no valid claim" (template_unsupported / template_failed). A legitimate
 * claim, in any state including pending/retry, always carries all of them.
 */
export function readTemplateClaim(config: unknown): DefaultMcpTemplateClaim | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const raw = (config as Record<string, unknown>)[DEFAULT_MCP_TEMPLATE_CONFIG_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const claim = raw as Record<string, unknown>;
  if (claim.version !== 1) return null;
  if (!CLAIM_STATES.includes(String(claim.state))) return null;
  for (const key of CLAIM_REQUIRED_STRINGS) {
    if (typeof claim[key] !== "string" || (claim[key] as string).length === 0) return null;
  }
  if (typeof claim.updatedAt !== "string" || claim.updatedAt.length === 0) return null;
  if (!Number.isInteger(claim.attemptCount) || (claim.attemptCount as number) < 0) return null;
  for (const key of CLAIM_NULLABLE_STRINGS) {
    const value = claim[key];
    if (value !== null && value !== undefined && typeof value !== "string") return null;
  }
  const version = claim.allowlistVersion;
  if (version !== null && version !== undefined && !(Number.isInteger(version) && (version as number) > 0)) return null;
  return claim as unknown as DefaultMcpTemplateClaim;
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
 *  - `null`: unrelated to the default-MCP state (agents without a snapshot always get this; legacy
 *    compatibility behavior is intentionally preserved).
 */
export function managedConnectionRole(
  state: DefaultMcpAgentState | null,
  agentCompanyId: string,
  connection: { id: string; companyId: string; name: string; config?: unknown },
): ManagedConnectionRole {
  if (!state || connection.companyId !== agentCompanyId) return null;
  if (isDefaultMcpSeed(connection.config)) return "forbidden";
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
    } else {
      const connectionConfig =
        connection.config && typeof connection.config === "object" && !Array.isArray(connection.config)
          ? (connection.config as Record<string, unknown>)
          : {};
      if (
        isPersonalDefaultMcpInstance(connection) &&
        connectionConfig[DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY] === entry.key
      ) {
        role ??= "managed";
      } else if (
        connection.id === entry.connectionId ||
        connection.id === entry.templateConnectionId ||
        (key !== null && connection.name === key)
      ) {
        role ??= "managed";
      }
    }
  }
  return role;
}

/** Whether the connection is related to the agent's default-MCP state at all (managed or forbidden). */
export function managedConnectionMatch(
  state: DefaultMcpAgentState | null,
  agentCompanyId: string,
  connection: { id: string; companyId: string; name: string; config?: unknown },
): boolean {
  return managedConnectionRole(state, agentCompanyId, connection) !== null;
}

/**
 * The single install-eligibility rule shared by the runtime projection, token mint, effective
 * profiles and the gateway. Callers must check agent refusal first (missing agent or malformed
 * metadata fails closed; see `agentInstallsRefused`). A `managed` connection needs an EXPLICIT
 * per-agent install (a company install never authorizes it); a `forbidden` one is never authorized
 * by any install. Agents without `defaultMcp` state and unrelated connections retain their legacy
 * behavior; this rule does not revoke existing legacy rows or bindings.
 */
export function installAppliesToAgent(
  install: { targetType: string },
  agent: { companyId: string; state: DefaultMcpAgentState | null },
  connection: { id: string; companyId: string; name: string; config?: unknown },
): boolean {
  // The Paperclip-provisioned company template and discovery-only seeds are never installable, for ANY agent:
  // this includes legacy agents with no `defaultMcp` state, and is distinct from the compatibility behavior
  // of legacy bindings for ordinary personal-template connections.
  if (isManagedTemplate(connection.config) || isDefaultMcpSeed(connection.config)) return false;
  const role = managedConnectionRole(agent.state, agent.companyId, connection);
  if (role === "forbidden") return false;
  return install.targetType !== "company" || role === null;
}

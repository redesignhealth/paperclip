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

export type DefaultMcpSetupHookKey = "comms_board_identity" | "arcana_brain";

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
  /**
   * Dedicated (`setupHook`) entries only. The entry is ON by default for every agent with no operator step: a NEW
   * agent's own dedicated connection is installed in the same transaction that makes it, and
   * `default-mcp-install-reconcile.ts` does the same once for existing agents. `defaultEnabled` stays false (the org
   * template is never installed and legacy/unmanaged agents are untouched). The install gate itself is unchanged, so
   * an owner who removes the install afterwards is not overridden: the reconcile is one-shot per entry.
   */
  installByDefault?: boolean;
  /** Optional per-MCP setup run after the agent row commits. Only special auth needs one. */
  setupHook?: DefaultMcpSetupHookKey;
  /**
   * When true, Paperclip itself provisions the company's read-only template connection (TECH-7271,
   * `default-mcp-template.ts`) instead of requiring an operator-authored one. Requires `reviewedTools`.
   */
  templateBootstrap?: boolean | "static";
  /**
   * The reviewed action allowlist for a bootstrapped template. The board's catalog lists EVERY tool
   * regardless of token scope, so the allowlist is mandatory: only the exact names below become ACTIVE;
   * every other discovered action is DISABLED. Bump `version` when the list changes.
   */
  reviewedTools?: { version: number; allow: readonly string[] };
  /**
   * Optional per-tool gateway execution timeout (ms) for tools of this entry's connection, keyed by upstream tool
   * name. Tools not listed keep the gateway default. Values are clamped to `MAX_TOOL_TIMEOUT_MS` when resolved.
   */
  toolTimeoutMs?: Readonly<Record<string, number>>;
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
 * Reviewed comms-board actions an agent may use (version 2). Deliberately excludes `comms_register`
 * (identity fork hazard), the admin tools (`comms_admin_register`, `comms_deregister_agent`,
 * `comms_set_agent_shared`), the `proposals_*` tools other than submit/get (version 2 adds `proposals_submit` and
 * `proposals_get` so an agent can propose an Arcana source and poll its outcome; both need `comms:proposals:write`),
 * and the permanent/privileged conversation operations (`comms_archive_conversation`, `comms_reopen_conversation`).
 */
export const COMMS_BOARD_REVIEWED_TOOLS_VERSION = 2;
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
  "proposals_submit",
  "proposals_get",
]);

/** Reviewed Arcana brain verbs an agent may use (version 1): read-only; no write verb exists on the MCP. */
export const ARCANA_BRAIN_REVIEWED_TOOLS_VERSION = 1;
export const ARCANA_BRAIN_REVIEWED_TOOLS: readonly string[] = Object.freeze([
  "recall",
  "search_pages",
  "read_page",
  "coverage",
  "open_source",
]);

/**
 * Argus review service tools (TECH-7792, version 1). Shared service-token connection, deliberately separate from the
 * personal OAuth `rh-mcp` read ceiling: `argus_start_review`/`argus_cancel_review` act (they enqueue and cancel a job),
 * so they never belong in a read ceiling. `argus_get_proxy_token` is intentionally absent: it mints credentials.
 */
export const ARGUS_REVIEW_REVIEWED_TOOLS_VERSION = 1;
export const ARGUS_REVIEW_REVIEWED_TOOLS: readonly string[] = Object.freeze([
  "argus_start_review",
  "argus_get_review",
  "argus_cancel_review",
]);

/** Hard ceiling for any per-call or per-tool gateway timeout (matches the gateway's per-call clamp). */
export const MAX_TOOL_TIMEOUT_MS = 60_000;
/** api-main (Lambda) can take 8-15 s on a cold start, so the Argus verbs get 30 s instead of the 10 s default. */
export const ARGUS_REVIEW_TOOL_TIMEOUT_MS = 30_000;

/** Fixed, unforgeable uid of the Paperclip-created static Arcana template (client uids always carry a random suffix). */
export const ARCANA_STATIC_TEMPLATE_UID = "rh-arcana-brain/default-mcp-template";

/**
 * The static Arcana template is a clone source, never a callable connection: its header ref is a placeholder
 * secret by design, so any health write against it would read as a broken connector. Operator-facing listings and
 * health surfaces skip it; per-agent clones (which carry their own uid and key secret) are unaffected.
 */
export function isArcanaStaticTemplate(connection: { uid?: string | null }): boolean {
  return connection.uid === ARCANA_STATIC_TEMPLATE_UID;
}

/** Health columns to persist for a connection: the static template is always recorded healthy (see above). */
export function connectionHealthColumns<S extends string>(
  connection: { uid?: string | null },
  status: S,
  message: string | null,
): { healthStatus: S | "ok"; healthMessage: string | null; lastError: string | null } {
  if (isArcanaStaticTemplate(connection)) return { healthStatus: "ok", healthMessage: null, lastError: null };
  return { healthStatus: status, healthMessage: message, lastError: status === "ok" ? null : message };
}

export const DEFAULT_MCP_SPEC_ENABLED_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

export const DEFAULT_MCP_SPEC: readonly DefaultMcpEntrySpec[] = [
  {
    key: "comms-board",
    displayName: "ReClaw Comms Board",
    connectionName: "rh-comms-board",
    authKind: "managed_token",
    defaultEnabled: false,
    // ON by default for every agent (see `installByDefault`). Per-agent identity, owner, visibility and the setup
    // state machine are unchanged, so an agent without a board identity yet (owner_required, pending, error) has no
    // dedicated connection and therefore nothing to call.
    installByDefault: true,
    setupHook: "comms_board_identity",
    templateBootstrap: true,
    reviewedTools: { version: COMMS_BOARD_REVIEWED_TOOLS_VERSION, allow: COMMS_BOARD_REVIEWED_TOOLS },
  },
  {
    // Arcana private brain (TECH-7252/7253). Paperclip creates the `rh-arcana-brain` template connection itself in
    // static-catalog mode (`default-mcp-static-template.ts`: no discovery call, because Arcana has no company-level
    // credential); each new agent gets its own exchange key (vault secret) and brain.
    key: "arcana-brain",
    displayName: "Arcana Brain",
    connectionName: "rh-arcana-brain",
    authKind: "managed_token",
    // Default ON (TECH-7253, explicitly requested): every new agent in a rollout-scoped company gets a brain. For a
    // dedicated (`setupHook`) entry this is declarative: the hook, not the ordinary install helper, provisions it, and
    // it is inert until the feature flag AND the Arcana server settings are configured (unconfigured waits, never fails).
    defaultEnabled: true,
    setupHook: "arcana_brain",
    templateBootstrap: "static",
    reviewedTools: { version: ARCANA_BRAIN_REVIEWED_TOOLS_VERSION, allow: ARCANA_BRAIN_REVIEWED_TOOLS },
  },
  {
    // Argus review service (TECH-7792). An ORDINARY (non-dedicated) entry: the company's operator-authored
    // `mcp_remote` + `api_key` connection is used as-is, so every agent that opts in shares the one rh-auth service
    // token (`sub=rh-mcp`-scoped `argus:review`) stored in the vault secret its header ref points at. Nothing is
    // minted per agent and nothing is installed by default. `reviewedTools` bounds the profile offered to agents to
    // the three review verbs even if the connection's catalog lists more.
    key: "argus-review",
    displayName: "Argus Review",
    connectionName: "rh-mcp-argus-review",
    authKind: "managed_token",
    defaultEnabled: false,
    reviewedTools: { version: ARGUS_REVIEW_REVIEWED_TOOLS_VERSION, allow: ARGUS_REVIEW_REVIEWED_TOOLS },
    toolTimeoutMs: Object.fromEntries(ARGUS_REVIEW_REVIEWED_TOOLS.map((tool) => [tool, ARGUS_REVIEW_TOOL_TIMEOUT_MS])),
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
      "argus_get_proxy_token",
      "zoom__get_transcript",
      "zoom__get_meeting_transcript",
      "zoom__get_meeting",
      "zoom__list_my_meetings",
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
  // An ordinary (non-dedicated, non-personal) entry's reviewed allowlist is also a ceiling for agents. The
  // curated profile alone is not enough: an agent holding an unscoped `tools:use` grant (every newly activated
  // standard agent does) is allowed before profiles are consulted, so it would otherwise be offered tools the
  // review excluded, such as a credential-minting verb. Users never reach this function.
  for (const entry of spec) {
    if (!entry.reviewedTools || entry.setupHook || entry.templateRequirements) continue;
    if (connection.name === entry.connectionName) return new Set(entry.reviewedTools.allow);
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
  | "provision_conflict"
  | "provision_rejected"
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
/**
 * Server-owned marker, value = the spec entry key (`arcana-brain`), on the Paperclip-created static-catalog template
 * and on every per-agent clone of it. A catalog refresh of a marked connection only ever accepts the entry's reviewed
 * verbs (it never quarantines them on descriptor drift and never adds any other tool).
 */
export const DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY = "defaultMcpStaticCatalog";
/** Fixed, unforgeable `tool_connections.uid` (client-created uids always carry a random id suffix). */
export const DEFAULT_MCP_TEMPLATE_UID = "rh-comms-board/default-mcp-template";
export const DEFAULT_MCP_PROTECTED_CONFIG_KEYS = [
  DEFAULT_MCP_MANAGED_CONFIG_KEY,
  DEFAULT_MCP_TEMPLATE_CONFIG_KEY,
  DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY,
] as const;

/** The reviewed verbs a static-catalog-marked connection may expose, or null when the connection carries no valid marker. */
export function staticCatalogAllowlist(config: unknown): ReadonlySet<string> | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const key = (config as Record<string, unknown>)[DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY];
  if (typeof key !== "string") return null;
  const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === key && candidate.templateBootstrap === "static");
  return entry?.reviewedTools ? new Set(entry.reviewedTools.allow) : null;
}

/** The spec-declared timeout for one tool of a default-MCP connection, clamped to the ceiling; undefined = gateway default. */
export function defaultToolTimeoutMs(
  connectionName: string,
  toolName: string,
  spec: readonly DefaultMcpEntrySpec[] = DEFAULT_MCP_SPEC,
): number | undefined {
  const timeouts = spec.find((entry) => entry.connectionName === connectionName)?.toolTimeoutMs;
  const value = timeouts && Object.hasOwn(timeouts, toolName) ? timeouts[toolName] : undefined;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(MAX_TOOL_TIMEOUT_MS, Math.floor(value)));
}

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

/** True for a discovery-only seed row (TECH-7340). Non-installable and non-callable. */
export function isDefaultMcpSeed(config: unknown): boolean {
  return managedMarker(config) === "seed";
}

/**
 * Lighter role helper for partial connection identity objects:
 * checks top-level protected `defaultMcpManaged === "personal"` and a valid non-empty entry tag.
 */
export function isProtectedPersonalDefaultMcpMarker(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const rec = config as Record<string, unknown>;
  return (
    rec[DEFAULT_MCP_MANAGED_CONFIG_KEY] === "personal" &&
    typeof rec[DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY] === "string" &&
    Boolean(rec[DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY])
  );
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
  /**
   * `COMMS_BOARD_TOKEN_SCOPES_VERSION` the stored token was minted or rotated with. Absent on bindings minted before
   * the marker existed (those carry the v1 scopes). Server-written only (the whole `defaultMcp` metadata key is reserved).
   */
  commsScopeVersion?: number | null;
  /**
   * The board `is_shared` value the shared-sync job last wrote for this agent. Absent until the first sync (which then
   * makes one idempotent call). Server-written only.
   */
  commsSharedSynced?: boolean | null;
  /**
   * Arcana entry only (TECH-7693): what provisioning used and Arcana returned, persisted instead of only recomputed.
   * `arcanaRecipeVersion` is the identity recipe in `composeArcanaBrainIdentity`; the recipe stays a check on writes.
   */
  arcanaRuntimeId?: string | null;
  arcanaBrainId?: string | null;
  arcanaRecipeVersion?: number | null;
  /**
   * Arcana entry only: the settled result of registering this agent's brain directory row in ACA for the comms board sub
   * named here. Absent means "not yet attempted"; transient failures never write it, so the sweep retries them.
   */
  brainBinding?: { state: "bound" | "conflict" | "rejected"; boardSub: string; generation: number; at: string } | null;
  /** Set by the rescope job when a rotation did not complete. Ids/codes only; cleared on success. */
  rescope?: { state: "failed"; reason: string; tokenMinted: boolean; at: string } | null;
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
  /**
   * Set at agent creation for a dedicated entry whose spec is `defaultEnabled` or `installByDefault` (and by the
   * install reconcile for existing agents still waiting on setup): when setup creates the
   * agent's own dedicated connection it also installs it for that agent (same transaction), then clears this and
   * sets `enabled`. Absent only until the install reconcile (`installByDefault` entries) settles an entry that predates it; for entries without `installByDefault` it stays absent, so backfilled and legacy-enrolled agents are never installed implicitly.
   */
  installOnReady?: boolean;
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
  /**
   * Comms-board identity generation. Absent/0 uses the original `paperclip-agent-<agentId>` board sub; N >= 1 uses
   * `paperclip-agent-<agentId>-r<N>`. Server-written only, by the identity-reissue operator route (the whole
   * `defaultMcp` metadata key is reserved and stripped from client updates).
   */
  identityGeneration?: number | null;
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
  const { boardAgentId, baseSub, agentKey, boardSub, secretId, secretVersion, connectionId, grantId, tokenExpiresAt, commsScopeVersion } = entry.binding;
  return { boardAgentId, baseSub, agentKey, boardSub, secretId, secretVersion, connectionId, grantId, tokenExpiresAt, ...(commsScopeVersion === undefined ? {} : { commsScopeVersion }) };
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
 *  - `null`: unrelated to the default-MCP state. Agents without a snapshot (legacy agents) get this
 *    only for non-seed connections; credentialless discovery seeds are `forbidden` for every agent.
 *    Legacy compatibility behavior remains preserved for ordinary non-seed connections.
 */
export function managedConnectionRole(
  state: DefaultMcpAgentState | null,
  agentCompanyId: string,
  connection: { id: string; companyId: string; name: string; config?: unknown },
): ManagedConnectionRole {
  if (connection.companyId !== agentCompanyId) return null;
  if (isDefaultMcpSeed(connection.config)) return "forbidden";
  if (!state) return null;
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
        isProtectedPersonalDefaultMcpMarker(connection.config) &&
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

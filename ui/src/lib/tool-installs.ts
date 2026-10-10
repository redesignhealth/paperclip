import type { ToolConnectionInstall } from "@paperclipai/shared";

/**
 * Shared "Permitted vs Installed" helpers (Phase 3b, PAP-13618).
 *
 * The one mental model: `installed ⊆ permitted`. **Access** = who may use an
 * app (zero context cost). **Installed** = whose harness actually carries the
 * app's tools on every run (a real per-run context cost). These helpers derive
 * the install state from a connection's `installs` rows and centralize the
 * copy so every surface (app detail, agent Tools tab, connect flow) speaks the
 * same language.
 */

export interface InstallState {
  /** A `company` install row: the app is installed on every agent. */
  onAll: boolean;
  /** Explicit per-agent install rows. */
  agentIds: Set<string>;
  /**
   * A company install row that this agent does NOT inherit (default-MCP agents only receive explicit
   * per-agent installs). Kept so a save writes the company row back unchanged.
   */
  ignoredCompanyInstall?: boolean;
}

export function installStateFrom(
  installs: ToolConnectionInstall[] | undefined,
  options?: { ignoreCompanyInstall?: boolean },
): InstallState {
  const agentIds = new Set<string>();
  let onAll = false;
  let ignoredCompanyInstall = false;
  for (const install of installs ?? []) {
    if (install.targetType === "company") {
      if (options?.ignoreCompanyInstall) ignoredCompanyInstall = true;
      else onAll = true;
    } else if (install.targetType === "agent") agentIds.add(install.targetId);
  }
  return ignoredCompanyInstall ? { onAll, agentIds, ignoredCompanyInstall } : { onAll, agentIds };
}

export type DefaultMcpConnectionRole = "managed" | "forbidden" | null;

type DefaultMcpEntryLike = Record<string, unknown>;

function defaultMcpEntries(metadata: Record<string, unknown> | null | undefined): DefaultMcpEntryLike[] {
  const state = metadata?.defaultMcp as { version?: unknown; entries?: Record<string, DefaultMcpEntryLike> } | undefined;
  if (!state || state.version !== 1 || !state.entries || typeof state.entries !== "object") return [];
  return Object.values(state.entries);
}

/**
 * How an agent's server-written `metadata.defaultMcp` state classifies a connection. Mirrors the
 * server's `managedConnectionRole`: `managed` = the agent's own connection for an entry (the org
 * connection for an ordinary entry, the STORED dedicated connection for a dedicated one);
 * `forbidden` = a dedicated entry's org template, another agent's dedicated connection, or a
 * credentialless discovery seed (never installable by this agent); `null` = unrelated. Legacy
 * agents return `null` only for non-seed connections; discovery seeds are forbidden for every agent.
 */
export function defaultMcpConnectionRole(
  metadata: Record<string, unknown> | null | undefined,
  connection: { id: string; name: string; companyId?: string | null; config?: unknown },
  agentCompanyId?: string | null,
): DefaultMcpConnectionRole {
  if (agentCompanyId && connection.companyId && connection.companyId !== agentCompanyId) return null;
  const config =
    connection.config && typeof connection.config === "object" && !Array.isArray(connection.config)
      ? (connection.config as Record<string, unknown>)
      : {};
  if (config.defaultMcpManaged === "seed") return "forbidden";
  if (!metadata?.defaultMcp) return null;
  let role: DefaultMcpConnectionRole = null;
  for (const entry of defaultMcpEntries(metadata)) {
    const key = typeof entry.templateKey === "string" && entry.templateKey.length > 0 ? entry.templateKey : null;
    if (entry.dedicated === true) {
      if (typeof entry.connectionId === "string" && connection.id === entry.connectionId) return "managed";
      if (connection.id === entry.templateConnectionId || (key !== null && (connection.name === key || connection.name.startsWith(`${key}:`)))) {
        role = "forbidden";
      }
    } else {
      if (
        config.defaultMcpManaged === "personal" &&
        config.paperclipDefaultMcpEntry === entry.key
      ) {
        role ??= "managed";
      } else if (connection.id === entry.connectionId || connection.id === entry.templateConnectionId || (key !== null && connection.name === key)) {
        role ??= "managed";
      }
    }
  }
  return role;
}

/** Back-compat helper: any relation to the agent's default-MCP state. */
export function isDefaultMcpManagedConnection(
  metadata: Record<string, unknown> | null | undefined,
  connection: { id: string; name: string; companyId?: string | null; config?: unknown },
  agentCompanyId?: string | null,
): boolean {
  return defaultMcpConnectionRole(metadata, connection, agentCompanyId) === "managed";
}

export function isDefaultMcpSeed(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  return (config as Record<string, unknown>).defaultMcpManaged === "seed";
}

export function isPersonalDefaultMcpInstance(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  return (config as Record<string, unknown>).defaultMcpManaged === "personal";
}

export interface DefaultMcpPendingEntry {
  key: string;
  /** Org template name (frozen at creation); shown until the agent's own connection exists. */
  name: string;
  state: string;
  reason: string | null;
}

/**
 * Default entries that have no connection for this agent yet (a dedicated entry still being set up,
 * or an ordinary entry whose org connection does not exist). The Tools tab lists them as "being set
 * up" instead of falling back to the shared org connection or hiding the app.
 */
export function defaultMcpPendingEntries(
  metadata: Record<string, unknown> | null | undefined,
  connections?: Array<{ config?: unknown; name?: unknown }>,
): DefaultMcpPendingEntry[] {
  return defaultMcpEntries(metadata)
    .filter((entry) => {
      if (typeof entry.key !== "string" || entry.connectionId) return false;
      const setup = (entry.setup ?? {}) as { state?: unknown; reason?: unknown };
      if (setup.state === "not_required" && connections) {
        const hasSeed = connections.some((c) => {
          const cfg = c.config && typeof c.config === "object" ? (c.config as Record<string, unknown>) : null;
          return cfg?.defaultMcpManaged === "seed" && cfg?.paperclipDefaultMcpEntry === entry.key;
        });
        if (hasSeed) return false;
      }
      return true;
    })
    .map((entry) => {
      const setup = (entry.setup ?? {}) as { state?: unknown; reason?: unknown };
      return {
        key: entry.key as string,
        name: typeof entry.templateKey === "string" ? entry.templateKey : (entry.key as string),
        state: typeof setup.state === "string" ? setup.state : "pending",
        reason: typeof setup.reason === "string" ? setup.reason : null,
      };
    });
}

export function isAgentInstalled(state: InstallState, agentId: string): boolean {
  return state.onAll || state.agentIds.has(agentId);
}

/** Serialize an install state back into the PUT payload the API expects. */
export function installPayload(
  companyId: string,
  state: InstallState,
): Array<{ targetType: "company" | "agent"; targetId: string }> {
  if (state.onAll) return [{ targetType: "company", targetId: companyId }];
  if (state.ignoredCompanyInstall) {
    return [
      { targetType: "company" as const, targetId: companyId },
      ...[...state.agentIds].map((targetId) => ({ targetType: "agent" as const, targetId })),
    ];
  }
  return [...state.agentIds].map((targetId) => ({ targetType: "agent" as const, targetId }));
}

// --- Copy (verbatim from the PAP-13615 wireframe spec) ---

export function installInfoNotice(appName: string): string {
  return `Installing adds ${appName}'s tools to the agent's context on every run — install only where it will actually be used.`;
}

export const INSTALL_ALL_WARNING =
  "Adds context cost to every run of every agent — a deliberate choice. New agents you add later are installed automatically.";

export function autoExtendNotice(agentName: string): string {
  return `Installing on ${agentName} will also grant access. A tool can't be installed on an agent that isn't allowed to use it, so we'll add ${agentName} to who can use it. This is logged.`;
}

export const INSTALLED_HINT =
  "Has access — tick to load its tools into this agent's context.";

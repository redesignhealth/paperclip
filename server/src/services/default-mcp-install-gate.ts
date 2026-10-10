/**
 * Server-side enforcement of the default-MCP OFF contract for agent sessions (TECH-7204).
 *
 * A connection managed by an agent's `defaultMcp` state is usable by that agent only with an
 * EXPLICIT per-agent install. A company install, a company profile binding or an organization grant
 * never authorizes it. Sessions without an agent (user/admin) and agents without `defaultMcp` state
 * are unchanged. This is checked at session start and at every dispatch/credential resolution; an
 * in-flight network call or an already-issued token is never retroactively revoked.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import {
  DEFAULT_MCP_METADATA_KEY,
  agentMayUseConnectionTool,
  isDefaultMcpSeed,
  isManagedTemplate,
  isPersonalDefaultMcpInstance,
  managedConnectionRole,
  readDefaultMcpState,
  type DefaultMcpAgentState,
} from "./default-mcp-spec.js";

/** `config` is optional so legacy callers compile; callers that have it MUST pass it (managed-template check). */
type ConnectionIdentity = { id: string; companyId: string; name: string; config?: unknown };

export interface AgentDefaultMcp {
  /** False when no agent row exists for this company (deleted, or another tenant's agent). */
  found: boolean;
  state: DefaultMcpAgentState | null;
  /**
   * The protected `defaultMcp` key is present but not a valid state. The key is server-only (every
   * caller write strips it), so this means corruption: the agent can no longer be proven unmanaged.
   */
  malformed: boolean;
}

export async function loadAgentDefaultMcpState(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<AgentDefaultMcp> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  if (!row) return { found: false, state: null, malformed: false };
  const state = readDefaultMcpState(row.metadata);
  const raw = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)[DEFAULT_MCP_METADATA_KEY]
    : undefined;
  // Note: `raw === null` or absent (`raw === undefined`) is intentionally treated as legacy
  // (unmanaged), NOT malformed. The server never writes `null`; classifying handwritten legacy
  // `null` as malformed would break the OFF contract and block unmanaged agents.
  return { found: true, state, malformed: state === null && raw !== undefined && raw !== null };
}

/**
 * The single fail-closed check that every caller must evaluate before projecting installs or
 * evaluating `installAppliesToAgent`. A missing agent row (`!loaded.found`) or a corrupted protected
 * `defaultMcp` key (`loaded.malformed`) refuses all connection installs.
 */
export function agentInstallsRefused(loaded: AgentDefaultMcp): boolean {
  return !loaded.found || loaded.malformed;
}

/**
 * Which of the given connections this agent may NOT use, and whether the agent exists at all.
 * A missing agent (or a corrupted protected key) fails CLOSED: every given connection is blocked.
 * Otherwise: managed ones with no explicit agent install, and every `forbidden` one (a dedicated
 * entry's org template, or another agent's dedicated connection) regardless of installs.
 */
export async function managedInstallCheck(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; connections: ConnectionIdentity[] },
): Promise<{ agentFound: boolean; blocked: Set<string> }> {
  const loaded = await loadAgentDefaultMcpState(db, input.companyId, input.agentId);
  if (agentInstallsRefused(loaded)) {
    return { agentFound: loaded.found, blocked: new Set(input.connections.map((connection) => connection.id)) };
  }
  const state = loaded.state;
  // The Paperclip-provisioned company template and discovery-only seeds are never usable by any agent (legacy agents included),
  // whatever install rows or profile bindings exist.
  const templateBlocked = new Set(
    input.connections.filter((connection) => isManagedTemplate(connection.config) || isDefaultMcpSeed(connection.config)).map((connection) => connection.id),
  );
  if (!state) return { agentFound: true, blocked: templateBlocked };
  const blocked = new Set<string>(templateBlocked);
  const managed: ConnectionIdentity[] = [];
  for (const connection of input.connections) {
    const role = managedConnectionRole(state, input.companyId, connection);
    if (role === "forbidden") blocked.add(connection.id);
    else if (role === "managed") managed.push(connection);
  }
  if (managed.length === 0) return { agentFound: true, blocked };
  const explicit = await db
    .select({ connectionId: toolConnectionInstalls.connectionId })
    .from(toolConnectionInstalls)
    .where(
      and(
        eq(toolConnectionInstalls.companyId, input.companyId),
        eq(toolConnectionInstalls.targetType, "agent"),
        eq(toolConnectionInstalls.targetId, input.agentId),
        inArray(toolConnectionInstalls.connectionId, managed.map((connection) => connection.id)),
      ),
    );
  const installed = new Set(explicit.map((row) => row.connectionId));
  for (const connection of managed) if (!installed.has(connection.id)) blocked.add(connection.id);
  return { agentFound: true, blocked };
}

export async function managedConnectionsMissingInstall(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; connections: ConnectionIdentity[] },
): Promise<Set<string>> {
  return (await managedInstallCheck(db, input)).blocked;
}

export type PersonalOwnerCapData = {
  connection: typeof toolConnections.$inferSelect;
  profile: typeof toolProfiles.$inferSelect | null;
  includes: Array<typeof toolProfileEntries.$inferSelect>;
  excludes: Array<typeof toolProfileEntries.$inferSelect>;
};

/**
 * Loads authoritative personal owner policy caps for personal default-MCP instances (TECH-7340).
 *
 * For strict personal instances (`isPersonalDefaultMcpInstance`), the connection creator's canonical app
 * profile (`app:<connId>`) bound to `agentId` acts as an absolute ceiling over that agent's access to the
 * personal connection. Any tool not permitted by the owner's app profile (or if the profile/binding is missing)
 * is denied, regardless of any other profile, grant, or policy allow.
 *
 * Connections that are NOT strict personal default-MCP instances are omitted from the returned Map (uncapped).
 */
export async function loadPersonalOwnerCaps(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId: string;
    connectionIds: string[];
  },
): Promise<Map<string, PersonalOwnerCapData>> {
  const uniqueConnIds = [...new Set(input.connectionIds.filter(Boolean))];
  if (uniqueConnIds.length === 0) return new Map();

  const conns = await db
    .select({
      id: toolConnections.id,
      companyId: toolConnections.companyId,
      name: toolConnections.name,
      transport: toolConnections.transport,
      authKind: toolConnections.authKind,
      credentialPolicy: toolConnections.credentialPolicy,
      config: toolConnections.config,
    })
    .from(toolConnections)
    .where(
      and(
        eq(toolConnections.companyId, input.companyId),
        inArray(toolConnections.id, uniqueConnIds),
      ),
    );

  const personalConns = conns.filter((c) => isPersonalDefaultMcpInstance(c));
  if (personalConns.length === 0) return new Map();

  const expectedProfileKeys = personalConns.map((c) => `app:${c.id}`);
  const profiles = await db
    .select()
    .from(toolProfiles)
    .where(
      and(
        eq(toolProfiles.companyId, input.companyId),
        inArray(toolProfiles.profileKey, expectedProfileKeys),
        eq(toolProfiles.status, "active"),
      ),
    );

  const validProfileByConnId = new Map<string, typeof toolProfiles.$inferSelect>();
  for (const profile of profiles) {
    const meta = profile.metadata && typeof profile.metadata === "object" && !Array.isArray(profile.metadata)
      ? (profile.metadata as Record<string, unknown>)
      : null;
    const connId = typeof meta?.connectionId === "string" ? meta.connectionId : null;
    if (connId && meta?.source === "app_gallery_finish" && profile.profileKey === `app:${connId}`) {
      validProfileByConnId.set(connId, profile);
    }
  }

  const validProfiles = [...validProfileByConnId.values()];
  const profileIds = validProfiles.map((p) => p.id);

  let bindings: Array<typeof toolProfileBindings.$inferSelect> = [];
  if (profileIds.length > 0) {
    bindings = await db
      .select()
      .from(toolProfileBindings)
      .where(
        and(
          eq(toolProfileBindings.companyId, input.companyId),
          inArray(toolProfileBindings.profileId, profileIds),
          eq(toolProfileBindings.targetType, "agent"),
          eq(toolProfileBindings.targetId, input.agentId),
        ),
      );
  }
  const boundProfileIds = new Set(bindings.map((b) => b.profileId));

  const boundValidProfileIds = profileIds.filter((id) => boundProfileIds.has(id));
  let entries: Array<typeof toolProfileEntries.$inferSelect> = [];
  if (boundValidProfileIds.length > 0) {
    entries = await db
      .select()
      .from(toolProfileEntries)
      .where(
        and(
          eq(toolProfileEntries.companyId, input.companyId),
          inArray(toolProfileEntries.profileId, boundValidProfileIds),
        ),
      );
  }

  const entriesByProfileId = new Map<string, Array<typeof toolProfileEntries.$inferSelect>>();
  for (const entry of entries) {
    const list = entriesByProfileId.get(entry.profileId) ?? [];
    list.push(entry);
    entriesByProfileId.set(entry.profileId, list);
  }

  const resultMap = new Map<string, PersonalOwnerCapData>();
  for (const conn of personalConns) {
    const profile = validProfileByConnId.get(conn.id);
    if (!profile || !boundProfileIds.has(profile.id)) {
      resultMap.set(conn.id, {
        connection: conn as typeof toolConnections.$inferSelect,
        profile: null,
        includes: [],
        excludes: [],
      });
      continue;
    }
    const profileEntries = entriesByProfileId.get(profile.id) ?? [];
    resultMap.set(conn.id, {
      connection: conn as typeof toolConnections.$inferSelect,
      profile,
      includes: profileEntries.filter((e) => e.effect === "include"),
      excludes: profileEntries.filter((e) => e.effect === "exclude"),
    });
  }

  return resultMap;
}

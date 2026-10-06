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
import { agents, toolConnectionInstalls, type Db } from "@paperclipai/db";
import { DEFAULT_MCP_METADATA_KEY, managedConnectionRole, readDefaultMcpState, type DefaultMcpAgentState } from "./default-mcp-spec.js";

type ConnectionIdentity = { id: string; companyId: string; name: string };

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
  if (!state) return { agentFound: true, blocked: new Set() };
  const blocked = new Set<string>();
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

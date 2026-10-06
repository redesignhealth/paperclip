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
import { managedConnectionRole, readDefaultMcpState, type DefaultMcpAgentState } from "./default-mcp-spec.js";

type ConnectionIdentity = { id: string; companyId: string; name: string };

export async function loadAgentDefaultMcpState(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<DefaultMcpAgentState | null> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  return readDefaultMcpState(row?.metadata);
}

/**
 * Ids of the given connections this agent may NOT use: managed ones with no explicit agent install,
 * and every `forbidden` one (a dedicated entry's org template, or another agent's dedicated
 * connection) regardless of installs.
 */
export async function managedConnectionsMissingInstall(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; connections: ConnectionIdentity[] },
): Promise<Set<string>> {
  const state = await loadAgentDefaultMcpState(db, input.companyId, input.agentId);
  if (!state) return new Set();
  const blocked = new Set<string>();
  const managed: ConnectionIdentity[] = [];
  for (const connection of input.connections) {
    const role = managedConnectionRole(state, input.companyId, connection);
    if (role === "forbidden") blocked.add(connection.id);
    else if (role === "managed") managed.push(connection);
  }
  if (managed.length === 0) return blocked;
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
  return blocked;
}

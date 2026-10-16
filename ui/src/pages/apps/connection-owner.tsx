import type { Agent, ToolConnection } from "@paperclipai/shared";
import { humanizeConnectionDisplayName } from "@paperclipai/shared";
import { Identity } from "@/components/Identity";
import type { CompanyUserProfile } from "@/lib/company-members";

export type ConnectionOwnerProfile = CompanyUserProfile;

export function connectionOwnerProfile(
  connection: Pick<ToolConnection, "createdByUserId">,
  profiles: ReadonlyMap<string, CompanyUserProfile>,
): ConnectionOwnerProfile | null {
  if (!connection.createdByUserId) return null;
  return profiles.get(connection.createdByUserId) ?? {
    label: connection.createdByUserId === "local-board" ? "Board" : "Board member",
    image: null,
  };
}

function ownerGivenName(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "Board";
  const first = trimmed.split(/\s+/)[0] ?? trimmed;
  return first.includes("@") ? first.split("@")[0] || "Board" : first;
}

function possessive(label: string): string {
  return label.toLowerCase().endsWith("s") ? `${label}’` : `${label}’s`;
}

const DEDICATED_AGENT_CONNECTION_NAME_PATTERN =
  /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNRESOLVED_DEDICATED_AGENT_LABEL = "Dedicated agent (unavailable)";

/**
 * Keep intentionally customized account names, while making the default app
 * name useful in a multi-user company ("Dotta’s Notion", "Sam’s Gmail").
 */
export function connectionDisplayNameForOwner(
  connection: Pick<ToolConnection, "name" | "credentialPolicy">,
  applicationName: string,
  owner: ConnectionOwnerProfile | null,
  agent?: Pick<Agent, "name"> | null,
): string {
  if (agent?.name) return agent.name;
  // `agent` not resolving to a named Agent -- whether `null` (a caller already
  // tried resolveAgentForConnection/resolveAgentFromQuery and it came back
  // empty) or `undefined` (resolution hasn't settled yet, e.g. the agents
  // query is still pending) -- means a "<prefix>:<agentId>" dedicated
  // connection name must not reach humanizeConnectionDisplayName: that
  // helper was never built to parse this shape and title-cases the trailing
  // UUID into a mangled string (e.g. "21ed2201 1592 4bc8 ..."). This isn't
  // just the confirmed-failed case -- a pending resolution showed that exact
  // mangled string too, re-exposing the bug this PR exists to fix for the
  // entire window before the agents query settles (TECH-7617 round 4).
  // Gated on credentialPolicy === "per_agent" too -- resolveAgentForConnection
  // returns null for EVERY non-per_agent connection, regardless of name shape,
  // not just for a per_agent one it failed to resolve. Without this check, a
  // caller passing that null through for a shared/personal connection whose
  // name coincidentally ends in a UUID-shaped suffix would get mislabeled.
  if (
    agent == null &&
    connection.credentialPolicy === "per_agent" &&
    DEDICATED_AGENT_CONNECTION_NAME_PATTERN.test(connection.name.trim())
  ) {
    return UNRESOLVED_DEDICATED_AGENT_LABEL;
  }
  const rawName = connection.name.trim();
  // Provider account identifiers are machine values, not prose. Preserve
  // their casing and punctuation so an email address or tenant hostname stays
  // recognizable in the inline account list.
  const connectionName =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawName) ||
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(rawName)
      ? rawName
      : humanizeConnectionDisplayName(connection);
  if (!owner) return connectionName;
  if (connectionName.trim().toLocaleLowerCase() !== applicationName.trim().toLocaleLowerCase()) {
    return connectionName;
  }
  return `${possessive(ownerGivenName(owner.label))} ${applicationName}`;
}

const COMMS_BOARD_PREFIX = "rh-comms-board:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the dedicated agent for a per_agent connection against the
 * company's known agents. Returns null if the agent cannot be resolved.
 *
 * The server names dedicated connections "<templateName>:<agentId>"
 * (`dedicatedConnectionName`), so the name-encoded ID is the authoritative
 * subject. Installs are consumers, and the creator is not a dedicated owner,
 * so neither is used to guess the subject when the encoded agent is unknown.
 */
export function resolveAgentForConnection(
  connection: ToolConnection,
  agentsById: ReadonlyMap<string, Agent>,
): Agent | null {
  if (connection.credentialPolicy !== "per_agent") {
    return null;
  }

  // 1. Comms-board dedicated connection name: "rh-comms-board:<agentId>".
  // The encoded subject is authoritative: if that agent is unknown (e.g.
  // deleted), do not substitute a different agent.
  if (connection.name.startsWith(COMMS_BOARD_PREFIX)) {
    return agentsById.get(connection.name.slice(COMMS_BOARD_PREFIX.length).trim()) ?? null;
  }

  // 2. Dedicated per_agent connection named "<prefix>:<agentId>"
  if (connection.name.includes(":")) {
    const candidateId = connection.name.slice(connection.name.lastIndexOf(":") + 1).trim();
    const agent = agentsById.get(candidateId);
    if (agent) return agent;
    // A UUID-shaped suffix is an encoded subject we cannot resolve; do not
    // fall back to an unrelated install.
    if (UUID_PATTERN.test(candidateId)) return null;
  }

  // 3. Install fallback, only when it is unambiguous: exactly one agent install.
  const agentInstalls = connection.installs?.filter((i) => i.targetType === "agent") ?? [];
  if (agentInstalls.length === 1) {
    return agentsById.get(agentInstalls[0]!.targetId) ?? null;
  }

  return null;
}

/** The subset of a TanStack `useQuery` result this module needs, kept narrow
 * so callers don't have to import TanStack Query types here. */
export type AgentsQueryLike = {
  data: readonly Agent[] | undefined;
  isError: boolean;
};

/**
 * Resolves an agent for a connection against a TanStack `useQuery` result for
 * the company's agent roster, as a tri-state: the resolved `Agent` (or `null`
 * if genuinely unresolved) once the roster has ever loaded successfully,
 * `null` if the fetch is confirmed failed and has never had data, or
 * `undefined` while nothing has loaded yet (so callers show a neutral
 * "not yet known" state rather than claiming resolution failed).
 *
 * Checking `data !== undefined` rather than `isSuccess` matters: in TanStack
 * Query v5, a failed *background* refetch after an earlier successful fetch
 * sets `isError` while leaving the last-good `data` in place. Gating on
 * `isSuccess` alone would regress an already-resolved dedicated-agent name
 * back to the "unavailable" placeholder on a transient refetch error; this
 * keeps resolving from the still-cached roster instead (TECH-7617 round 4).
 */
export function resolveAgentFromQuery(
  connection: ToolConnection,
  agentsById: ReadonlyMap<string, Agent>,
  agentsQuery: AgentsQueryLike,
): Agent | null | undefined {
  if (agentsQuery.data !== undefined) {
    return resolveAgentForConnection(connection, agentsById);
  }
  if (agentsQuery.isError) return null;
  return undefined;
}

export function ConnectionOwnerIdentity({ owner }: { owner: ConnectionOwnerProfile | null }) {
  if (!owner) return <span className="text-xs text-muted-foreground">Unknown</span>;
  return (
    <Identity
      name={owner.label}
      avatarUrl={owner.image}
      size="sm"
      className="text-muted-foreground"
    />
  );
}

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

/**
 * Keep intentionally customized account names, while making the default app
 * name useful in a multi-user company ("Dotta’s Notion", "Sam’s Gmail").
 */
export function connectionDisplayNameForOwner(
  connection: Pick<ToolConnection, "name">,
  applicationName: string,
  owner: ConnectionOwnerProfile | null,
  agent?: Pick<Agent, "name"> | null,
): string {
  if (agent?.name) return agent.name;
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

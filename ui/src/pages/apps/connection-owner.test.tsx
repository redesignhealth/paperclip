// @vitest-environment jsdom

import type { Agent, ToolConnection, ToolConnectionInstall } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { connectionDisplayNameForOwner, resolveAgentForConnection } from "./connection-owner";

const ENCODED_AGENT_ID = "1d37c752-ef9d-4185-bfd5-3249898f6bc2";
const INSTALL_AGENT_ID = "2b48e863-1234-4567-89ab-cdef01234567";
const UNKNOWN_AGENT_ID = "3c59f974-5678-9abc-def0-123456789abc";

function agent(id: string, name: string): Agent {
  return {
    id,
    companyId: "company-1",
    name,
    urlKey: name.toLowerCase().replace(/\s+/g, "-"),
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function install(connectionId: string, targetType: ToolConnectionInstall["targetType"], targetId: string): ToolConnectionInstall {
  return {
    id: `inst-${connectionId}-${targetType}-${targetId}`,
    companyId: "company-1",
    connectionId,
    targetType,
    targetId,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function connection(
  overrides: Partial<Pick<ToolConnection, "name" | "credentialPolicy" | "installs" | "createdByAgentId">>,
): ToolConnection {
  return {
    id: "conn-x",
    companyId: "company-1",
    applicationId: "app-x",
    name: "GitHub",
    uid: "conn-uid-x",
    connectionKind: "managed",
    connectionPurpose: "tool",
    ownership: "platform_shared",
    transport: "mcp_remote",
    authKind: "api_key",
    credentialSource: "paperclip_vault",
    credentialPolicy: "per_agent",
    status: "active",
    transportConfig: {},
    config: {},
    credentialSecretRefs: [],
    healthStatus: "healthy",
    healthCheckedAt: null,
    lastError: null,
    enabled: true,
    lastUsedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function agentsById(...agents: Agent[]): ReadonlyMap<string, Agent> {
  return new Map(agents.map((a) => [a.id, a]));
}

describe("resolveAgentForConnection (TECH-7592 dedicated agent resolution)", () => {
  it("resolves no agent outside per_agent connections, even with an encoded name and install", () => {
    const agents = agentsById(agent(ENCODED_AGENT_ID, "Encoded Agent"));
    // Only "per_agent" (dedicated) connections carry an agent identity. A
    // "Who can use it" install on a shared/personal connection must not
    // rename it, and a name that merely looks like a dedicated name must
    // not either — the policy gate comes before every resolution path.
    for (const credentialPolicy of ["shared", "per_user", "per_user_with_fallback"] as const) {
      const resolved = resolveAgentForConnection(
        connection({
          name: `rh-comms-board:${ENCODED_AGENT_ID}`,
          credentialPolicy,
          installs: [install("conn-x", "agent", ENCODED_AGENT_ID)],
        }),
        agents,
      );
      expect(resolved, credentialPolicy).toBeNull();
    }
  });

  it("resolves the comms-board name-encoded agent, trimming padded ids", () => {
    const encoded = agent(ENCODED_AGENT_ID, "Encoded Agent");
    expect(
      resolveAgentForConnection(
        connection({ name: `rh-comms-board: ${ENCODED_AGENT_ID} ` }),
        agentsById(encoded),
      ),
    ).toBe(encoded);
  });

  it("treats the name-encoded agent as authoritative over a conflicting install", () => {
    const encoded = agent(ENCODED_AGENT_ID, "Encoded Agent");
    const installAgent = agent(INSTALL_AGENT_ID, "Install Agent");
    expect(
      resolveAgentForConnection(
        connection({
          name: `rh-comms-board:${ENCODED_AGENT_ID}`,
          installs: [install("conn-x", "agent", INSTALL_AGENT_ID)],
        }),
        agentsById(encoded, installAgent),
      ),
    ).toBe(encoded);
  });

  it("does not fall back to an install when the comms-board name-encoded agent is unknown", () => {
    const installAgent = agent(INSTALL_AGENT_ID, "Install Agent");
    // The encoded subject was deleted from the company: the install row is a
    // consumer, not a substitute owner, so the connection stays unresolved.
    expect(
      resolveAgentForConnection(
        connection({
          name: `rh-comms-board:${UNKNOWN_AGENT_ID}`,
          installs: [install("conn-x", "agent", INSTALL_AGENT_ID)],
        }),
        agentsById(installAgent),
      ),
    ).toBeNull();
  });

  it("resolves a generic prefix:<agentId> dedicated name", () => {
    const encoded = agent(ENCODED_AGENT_ID, "Encoded Agent");
    expect(
      resolveAgentForConnection(
        connection({ name: `jira-boards:${ENCODED_AGENT_ID}` }),
        agentsById(encoded),
      ),
    ).toBe(encoded);
  });

  it("parses the generic dedicated name defensively: trims padding, takes the last colon segment, and treats uppercase UUIDs as encoded subjects", () => {
    const encoded = agent(ENCODED_AGENT_ID, "Encoded Agent");
    const installAgent = agent(INSTALL_AGENT_ID, "Install Agent");
    const agents = agentsById(encoded, installAgent);
    // Padded suffix still resolves after trimming.
    expect(
      resolveAgentForConnection(
        connection({ name: `jira-boards: ${ENCODED_AGENT_ID} ` }),
        agents,
      ),
    ).toBe(encoded);
    // A prefix that itself contains a colon still resolves its last segment —
    // the agent id is always the name's final segment.
    expect(
      resolveAgentForConnection(
        connection({ name: `team-space:jira-boards:${ENCODED_AGENT_ID}` }),
        agents,
      ),
    ).toBe(encoded);
    // UUIDs are case-insensitive identifiers, so an unresolved uppercase UUID
    // suffix is still an encoded subject: terminal, no install fallback.
    expect(
      resolveAgentForConnection(
        connection({
          name: `jira-boards:${UNKNOWN_AGENT_ID.toUpperCase()}`,
          installs: [install("conn-x", "agent", INSTALL_AGENT_ID)],
        }),
        agents,
      ),
    ).toBeNull();
  });

  it("terminates on an unresolved UUID-shaped suffix instead of falling back to an install", () => {
    const installAgent = agent(INSTALL_AGENT_ID, "Install Agent");
    // A UUID suffix is an encoded subject (dedicatedConnectionName). When it
    // cannot be resolved, substituting the installed agent would relabel the
    // connection after its owner was deleted.
    expect(
      resolveAgentForConnection(
        connection({
          name: `jira-boards:${UNKNOWN_AGENT_ID}`,
          installs: [install("conn-x", "agent", INSTALL_AGENT_ID)],
        }),
        agentsById(installAgent),
      ),
    ).toBeNull();
  });

  it("falls through a non-UUID suffix to the unambiguous install fallback", () => {
    const installAgent = agent(INSTALL_AGENT_ID, "Install Agent");
    // A non-UUID suffix is not an encoded subject, so a sole install may
    // still resolve the connection.
    expect(
      resolveAgentForConnection(
        connection({
          name: "jira-boards:team-marketing",
          installs: [install("conn-x", "agent", INSTALL_AGENT_ID)],
        }),
        agentsById(installAgent),
      ),
    ).toBe(installAgent);
  });

  it("resolves the sole agent install when the name encodes no agent", () => {
    const installAgent = agent(INSTALL_AGENT_ID, "Install Agent");
    expect(
      resolveAgentForConnection(
        connection({
          name: "Linear",
          installs: [
            install("conn-x", "company", "company-1"),
            install("conn-x", "agent", INSTALL_AGENT_ID),
          ],
        }),
        agentsById(installAgent),
      ),
    ).toBe(installAgent);
  });

  it("resolves no agent when multiple agent installs are ambiguous", () => {
    const first = agent(ENCODED_AGENT_ID, "First Agent");
    const second = agent(INSTALL_AGENT_ID, "Second Agent");
    expect(
      resolveAgentForConnection(
        connection({
          name: "Linear",
          installs: [
            install("conn-x", "agent", ENCODED_AGENT_ID),
            install("conn-x", "agent", INSTALL_AGENT_ID),
          ],
        }),
        agentsById(first, second),
      ),
    ).toBeNull();
  });

  it("resolves no agent when the sole agent install points at an unknown agent, or installs are non-agent only", () => {
    const known = agent(ENCODED_AGENT_ID, "Known Agent");
    expect(
      resolveAgentForConnection(
        connection({
          name: "Linear",
          installs: [install("conn-x", "agent", UNKNOWN_AGENT_ID)],
        }),
        agentsById(known),
      ),
    ).toBeNull();
    expect(
      resolveAgentForConnection(
        connection({
          name: "Linear",
          installs: [install("conn-x", "company", "company-1")],
        }),
        agentsById(known),
      ),
    ).toBeNull();
  });

  it("never falls back to the creating agent (creator-only rejected)", () => {
    const creator = agent(ENCODED_AGENT_ID, "Creator Agent");
    expect(
      resolveAgentForConnection(
        connection({ name: "Linear", createdByAgentId: ENCODED_AGENT_ID }),
        agentsById(creator),
      ),
    ).toBeNull();
  });

  it("keeps the name-encoded agent even when a different agent created the connection", () => {
    const encoded = agent(ENCODED_AGENT_ID, "Encoded Agent");
    const creator = agent(INSTALL_AGENT_ID, "Creator Agent");
    expect(
      resolveAgentForConnection(
        connection({
          name: `rh-comms-board:${ENCODED_AGENT_ID}`,
          createdByAgentId: INSTALL_AGENT_ID,
        }),
        agentsById(encoded, creator),
      ),
    ).toBe(encoded);
  });
});

describe("connectionDisplayNameForOwner (TECH-7617 unresolved dedicated-agent fallback)", () => {
  it("shows the agent's name when resolution succeeded", () => {
    expect(
      connectionDisplayNameForOwner(
        connection({ name: `rh-comms-board:${ENCODED_AGENT_ID}` }),
        "rh-comms-board",
        null,
        agent(ENCODED_AGENT_ID, "Encoded Agent"),
      ),
    ).toBe("Encoded Agent");
  });

  it("shows a neutral placeholder, not a mangled UUID, when the agent is explicitly unresolved", () => {
    // Mirrors Connections.tsx: `agent` is the (possibly null) result of
    // resolveAgentForConnection, passed through explicitly -- a visibility gap
    // (e.g. the viewer can't read the encoded agent via GET /companies/:id/agents)
    // must not fall through to humanizeConnectionDisplayName, which title-cases
    // the trailing UUID into "21ed2201 1592 4bc8 ..." (TECH-7617).
    expect(
      connectionDisplayNameForOwner(
        connection({ name: `rh-comms-board:${UNKNOWN_AGENT_ID}` }),
        "rh-comms-board",
        null,
        null,
      ),
    ).toBe("Dedicated agent (unavailable)");
  });

  it("still falls back to the humanized name for a non-dedicated connection with no agent passed", () => {
    // `agent` omitted entirely (undefined, as AppDetail.tsx and Browse.tsx call
    // it) must behave exactly as before this fix -- the guard is specific to an
    // explicit `null` resolution result for a dedicated-shaped name.
    expect(
      connectionDisplayNameForOwner(connection({ name: "GitHub" }), "GitHub", null),
    ).toBe("GitHub");
  });

  it("does not misfire on an unresolved agent for a connection name that merely contains a colon", () => {
    expect(
      connectionDisplayNameForOwner(
        connection({ name: "vendor:tool-name" }),
        "vendor:tool-name",
        null,
        null,
      ),
    ).not.toBe("Dedicated agent (unavailable)");
  });
});

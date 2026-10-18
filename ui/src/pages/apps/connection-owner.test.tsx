// @vitest-environment jsdom

import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Agent, ToolConnection, ToolConnectionInstall } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ArcanaBrainIdBadge,
  CommsBoardAgentIdBadge,
  connectionDisplayNameForOwner,
  resolveAgentForConnection,
  resolveAgentFromQuery,
  resolveArcanaBrainId,
  resolveCommsBoardAgentId,
} from "./connection-owner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

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

  it("still falls back to the humanized name for a non-dedicated-shaped connection with no agent passed", () => {
    // `agent` omitted entirely (undefined) falls through normally for a
    // non-dedicated-shaped name -- the placeholder guard only intercepts
    // names matching the "<prefix>:<uuid>" pattern (see the next test for
    // that shape with agent omitted).
    expect(
      connectionDisplayNameForOwner(connection({ name: "GitHub" }), "GitHub", null),
    ).toBe("GitHub");
  });

  it("shows the placeholder, not a mangled UUID, for a pending (agent omitted) dedicated-shaped connection", () => {
    // round 4: `agent === undefined` (pending/not-yet-attempted, as Browse.tsx
    // and AppDetail.tsx pass via resolveAgentFromQuery before their agents
    // query has any data) must be treated the same as `agent === null`
    // (confirmed unresolved) for display purposes -- both avoid
    // humanizeConnectionDisplayName's mangled-UUID output for this name
    // shape. Only a resolved `Agent` (handled above) skips the placeholder.
    expect(
      connectionDisplayNameForOwner(
        connection({ name: `rh-comms-board:${UNKNOWN_AGENT_ID}` }),
        "rh-comms-board",
        null,
      ),
    ).toBe("Dedicated agent (unavailable)");
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

  it("does not misfire on a non-dedicated connection whose name coincidentally ends in a UUID-shaped suffix", () => {
    // resolveAgentForConnection returns null (not undefined) for any
    // credentialPolicy !== "per_agent" connection, regardless of its name
    // shape -- the placeholder guard must not key off that null alone, or a
    // shared/personal connection named e.g. "vendor:<tenant-uuid>" would be
    // mislabeled as an unresolved dedicated agent (TECH-7617 round 1).
    for (const credentialPolicy of ["shared", "per_user", "per_user_with_fallback"] as const) {
      expect(
        connectionDisplayNameForOwner(
          connection({
            name: `vendor:${UNKNOWN_AGENT_ID}`,
            credentialPolicy,
          }),
          "vendor",
          null,
          null,
        ),
      ).not.toBe("Dedicated agent (unavailable)");
    }
  });
});

describe("resolveAgentFromQuery (TECH-7617 round 4 tri-state query gating)", () => {
  const resolvable = agent(ENCODED_AGENT_ID, "Encoded Agent");
  const dedicatedConnection = connection({ name: `rh-comms-board:${ENCODED_AGENT_ID}` });

  it("resolves normally once the query has ever had data", () => {
    expect(
      resolveAgentFromQuery(dedicatedConnection, agentsById(resolvable), {
        data: [resolvable],
        isError: false,
      }),
    ).toBe(resolvable);
  });

  it("prefers cached data over a confirmed error (TanStack background refetch failure)", () => {
    // isError can be true for a failed *background* refetch even though the
    // last-good `data` from an earlier successful fetch is still present --
    // must not regress an already-resolved name to the placeholder.
    expect(
      resolveAgentFromQuery(dedicatedConnection, agentsById(resolvable), {
        data: [resolvable],
        isError: true,
      }),
    ).toBe(resolvable);
  });

  it("returns null (not undefined) once the fetch is confirmed failed with no data ever loaded", () => {
    expect(
      resolveAgentFromQuery(dedicatedConnection, agentsById(), {
        data: undefined,
        isError: true,
      }),
    ).toBeNull();
  });

  it("returns undefined (not null) while nothing has loaded yet and there is no error", () => {
    expect(
      resolveAgentFromQuery(dedicatedConnection, agentsById(), {
        data: undefined,
        isError: false,
      }),
    ).toBeUndefined();
  });
});

describe("resolveCommsBoardAgentId (TECH-7592 comms board agent ID resolution)", () => {
  const AGENT_ID = "1d37c752-ef9d-4185-bfd5-3249898f6bc2";
  const OTHER_AGENT_ID = "2b48e863-1234-4567-89ab-cdef01234567";
  const BOARD_ID = "6c8935b2-ef9d-4185-bfd5-3249898f6bc2";
  const CONN_ID = "c-comms-1";

  function commsConnection(overrides: Partial<ToolConnection> = {}): ToolConnection {
    return connection({
      id: CONN_ID,
      name: `rh-comms-board:${AGENT_ID}`,
      credentialPolicy: "per_agent",
      ...overrides,
    });
  }

  function commsAgent(
    metadata: Record<string, unknown> | null = {
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId: CONN_ID,
            binding: { boardAgentId: BOARD_ID, connectionId: CONN_ID },
          },
        },
      },
    },
    id = AGENT_ID,
  ): Agent {
    return {
      ...agent(id, "Test Agent"),
      metadata,
    };
  }

  it("resolves the authoritative boardAgentId from comms-board entry metadata", () => {
    expect(resolveCommsBoardAgentId(commsConnection(), commsAgent())).toBe(BOARD_ID);
  });

  it("normalizes uppercase boardAgentId to lowercase", () => {
    const uppercaseBoardId = BOARD_ID.toUpperCase();
    const a = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId: CONN_ID,
            binding: { boardAgentId: uppercaseBoardId, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), a)).toBe(BOARD_ID.toLowerCase());
  });

  it("returns null when connection or agent is missing", () => {
    expect(resolveCommsBoardAgentId(null, commsAgent())).toBeNull();
    expect(resolveCommsBoardAgentId(commsConnection(), null)).toBeNull();
  });

  it("returns null when connection is not per_agent", () => {
    expect(resolveCommsBoardAgentId(commsConnection({ credentialPolicy: "shared" }), commsAgent())).toBeNull();
  });

  it("returns null when connection name does not start with rh-comms-board:", () => {
    expect(resolveCommsBoardAgentId(commsConnection({ name: `slack:${AGENT_ID}` }), commsAgent())).toBeNull();
  });

  it("returns null when connection name encodes a different agent", () => {
    expect(resolveCommsBoardAgentId(commsConnection({ name: `rh-comms-board:${OTHER_AGENT_ID}` }), commsAgent())).toBeNull();
  });

  it("returns null when agent metadata is missing, null, array, or not an object", () => {
    expect(resolveCommsBoardAgentId(commsConnection(), commsAgent(null))).toBeNull();
    expect(resolveCommsBoardAgentId(commsConnection(), commsAgent({} as Record<string, unknown>))).toBeNull();
    expect(resolveCommsBoardAgentId(commsConnection(), commsAgent([] as unknown as Record<string, unknown>))).toBeNull();
  });

  it("returns null when defaultMcp version is not 1", () => {
    const a = commsAgent({ defaultMcp: { version: 2, entries: {} } });
    expect(resolveCommsBoardAgentId(commsConnection(), a)).toBeNull();
  });

  it("returns null when comms-board entry is missing or another tool only", () => {
    const a = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          arcana: { key: "arcana", templateKey: "arcana_brain", binding: { boardAgentId: BOARD_ID } },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), a)).toBeNull();
  });

  it("returns null when boardAgentId is missing or not a valid UUID", () => {
    const a = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            binding: { boardAgentId: "not-a-uuid" },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), a)).toBeNull();
  });

  it("returns null when connectionId on entry or binding mismatches connection.id", () => {
    const mismatchedEntry = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId: "other-conn-id",
            binding: { boardAgentId: BOARD_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), mismatchedEntry)).toBeNull();

    const mismatchedBinding = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId: CONN_ID,
            binding: { boardAgentId: BOARD_ID, connectionId: "other-conn-id" },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), mismatchedBinding)).toBeNull();
  });

  it("resolves when connectionId is absent in legacy entry as long as connection name matches", () => {
    const legacyAgent = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId: null,
            binding: { boardAgentId: BOARD_ID, connectionId: null },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), legacyAgent)).toBe(BOARD_ID);
  });

  it("resolves when connectionId fields are entirely absent (undefined), not just null", () => {
    const absentAgent = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            // No connectionId on the entry or the binding at all.
            binding: { boardAgentId: BOARD_ID },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), absentAgent)).toBe(BOARD_ID);
  });

  it("treats a blank-string connectionId as absent (legacy), never as a mismatch", () => {
    // The server contract writes connectionId as a real id or null, never a
    // blank string; blank is treated as absent (the legacy allowance) rather
    // than a mismatch, which can only over-show nothing — the boardAgentId
    // still has to come from the same binding.
    const blankAgent = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId: "",
            binding: { boardAgentId: BOARD_ID, connectionId: "" },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), blankAgent)).toBe(BOARD_ID);
  });

  it("resolves from the full realistic server-written entry state (ready binding with every field)", () => {
    // Mirrors what the server actually writes (server/src/services/
    // default-mcp-spec.ts DefaultMcpEntryState/DefaultMcpBindingRef and
    // default-mcp-setup.ts's setup hook): entries["comms-board"] with
    // key/templateKey, a ready setup state, and a binding carrying
    // boardAgentId, baseSub/boardSub (the board JWT subject), secret refs,
    // and the dedicated connectionId. A guard that rejected any of these
    // legitimate fields would hide the badge on healthy rows.
    const realisticAgent = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            enabled: true,
            templateConnectionId: null,
            connectionId: CONN_ID,
            ownerUserId: "user-9",
            setup: {
              state: "ready",
              reason: null,
              attemptCount: 1,
              nextAttemptAt: null,
              leaseUntil: null,
              claimId: null,
              registerAttemptedAt: "2026-01-02T00:00:00Z",
              mintAttemptedAt: "2026-01-02T00:00:01Z",
              updatedAt: "2026-01-02T00:00:02Z",
            },
            binding: {
              boardAgentId: BOARD_ID,
              baseSub: `paperclip-agent-${AGENT_ID}`,
              agentKey: "claude-code",
              boardSub: `paperclip-agent-${AGENT_ID}`,
              secretId: "secret-1",
              secretVersion: "latest",
              connectionId: CONN_ID,
              grantId: "grant-1",
              tokenExpiresAt: null,
            },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), realisticAgent)).toBe(BOARD_ID);
  });

  it("proves the resolved ID is the comms-board agent UUID, never the Paperclip agent ID, the connection ID, or the board JWT subject", () => {
    // Four distinct identity domains meet in this fixture: the Paperclip
    // internal agent UUID (agent.id, name-encoded in the connection), the
    // board-registered agent UUID (binding.boardAgentId — the only correct
    // answer), the dedicated connection UUID (entry/binding connectionId),
    // and the board JWT subject (binding.boardSub, "paperclip-agent-<id>",
    // which is never a UUID). Every value is pairwise distinct, so a wrong
    // domain cannot slip through `toBe`.
    const internalAgentId = AGENT_ID;
    const boardAgentId = "7e40a2c9-8b1d-4f6e-9a3c-5d2b8e7f4a10";
    const connectionId = "0f1e2d3c-4b5a-4968-8776-655443332211";
    const boardJwtSub = `paperclip-agent-${internalAgentId}`;
    const conn = commsConnection({ id: connectionId });
    const owningAgent = commsAgent(
      {
        defaultMcp: {
          version: 1,
          entries: {
            "comms-board": {
              key: "comms-board",
              templateKey: "rh-comms-board",
              dedicated: true,
              connectionId,
              binding: {
                boardAgentId,
                baseSub: boardJwtSub,
                boardSub: boardJwtSub,
                secretId: "secret-2",
                secretVersion: null,
                connectionId,
                grantId: "grant-2",
                tokenExpiresAt: null,
              },
            },
          },
        },
      },
      internalAgentId,
    );
    const resolved = resolveCommsBoardAgentId(conn, owningAgent);
    expect(resolved).toBe(boardAgentId);
    expect(resolved).not.toBe(internalAgentId);
    expect(resolved).not.toBe(connectionId);
    expect(resolved).not.toBe(boardJwtSub);
  });

  it("returns null when defaultMcp itself is null, an array, or a non-object", () => {
    for (const bad of [null, [], "nope", 42] as unknown[]) {
      const a = commsAgent({ defaultMcp: bad } as Record<string, unknown>);
      expect(resolveCommsBoardAgentId(commsConnection(), a), JSON.stringify(bad)).toBeNull();
    }
  });

  it("returns null when defaultMcp version is missing entirely or a string, not just the wrong number", () => {
    const missingVersion = commsAgent({
      defaultMcp: { entries: { "comms-board": { key: "comms-board", templateKey: "rh-comms-board", binding: { boardAgentId: BOARD_ID } } } },
    } as Record<string, unknown>);
    expect(resolveCommsBoardAgentId(commsConnection(), missingVersion)).toBeNull();

    const stringVersion = commsAgent({
      defaultMcp: {
        version: "1",
        entries: { "comms-board": { key: "comms-board", templateKey: "rh-comms-board", binding: { boardAgentId: BOARD_ID } } },
      },
    } as Record<string, unknown>);
    expect(resolveCommsBoardAgentId(commsConnection(), stringVersion)).toBeNull();
  });

  it("returns null when entries is missing, null, or an array", () => {
    for (const entries of [undefined, null, []] as unknown[]) {
      const a = commsAgent({
        defaultMcp: { version: 1, entries },
      } as Record<string, unknown>);
      expect(resolveCommsBoardAgentId(commsConnection(), a), JSON.stringify(entries)).toBeNull();
    }
  });

  it("returns null when entries[\"comms-board\"] is an array (falls through to the alias scan, which finds nothing)", () => {
    const a = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": ["not", "an", "entry"],
        },
      },
    } as Record<string, unknown>);
    expect(resolveCommsBoardAgentId(commsConnection(), a)).toBeNull();
  });

  it("returns null when the direct entries[\"comms-board\"] hit is another template's entry (wrong key and templateKey)", () => {
    // A malformed/squatted entries slot must not resolve even though the
    // slot key says "comms-board": the entry's own key/templateKey identify
    // the template, and neither matches the comms-board contract.
    const a = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            binding: { boardAgentId: BOARD_ID },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), a)).toBeNull();
  });

  it("resolves a compat entry stored under a different entries key via its key or templateKey alias", () => {
    // The server today always writes entries["comms-board"] (the spec key is
    // frozen at creation); the alias scan is deliberate compatibility for
    // differently-slotted shapes. The entry still has to identify itself as
    // comms-board via key/templateKey and carry a valid binding.
    const keyedAlias = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "legacy-comms": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            binding: { boardAgentId: BOARD_ID },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), keyedAlias)).toBe(BOARD_ID);

    const templateKeyAlias = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "other-slot": {
            key: "legacy-comms-entry",
            templateKey: "rh-comms-board",
            dedicated: true,
            binding: { boardAgentId: BOARD_ID },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), templateKeyAlias)).toBe(BOARD_ID);
  });

  it("returns null when the binding is missing entirely or an array", () => {
    const noBinding = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": { key: "comms-board", templateKey: "rh-comms-board", dedicated: true },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), noBinding)).toBeNull();

    const arrayBinding = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            binding: [],
          },
        },
      },
    } as Record<string, unknown>);
    expect(resolveCommsBoardAgentId(commsConnection(), arrayBinding)).toBeNull();
  });

  it("returns null when boardAgentId is blank, whitespace, a non-string, or null (registration not completed)", () => {
    // A blank id must never render as an empty badge.
    for (const bad of ["", "   "]) {
      const a = commsAgent({
        defaultMcp: {
          version: 1,
          entries: {
            "comms-board": {
              key: "comms-board",
              templateKey: "rh-comms-board",
              dedicated: true,
              binding: { boardAgentId: bad },
            },
          },
        },
      });
      expect(resolveCommsBoardAgentId(commsConnection(), a), JSON.stringify(bad)).toBeNull();
    }
    // Non-string and null boardAgentId (DefaultMcpBindingRef allows null while
    // registration has not captured the board's answer).
    const nonString = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            binding: { boardAgentId: 42 },
          },
        },
      },
    } as Record<string, unknown>);
    expect(resolveCommsBoardAgentId(commsConnection(), nonString)).toBeNull();

    const nullBoardAgentId = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            binding: { boardAgentId: null },
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), nullBoardAgentId)).toBeNull();
  });

  it("returns null while registration is pending (realistic pending setup state with no binding)", () => {
    // The exact state a freshly-created agent sits in until the comms-board
    // setup hook completes: setup.state "pending", binding null.
    const pendingAgent = commsAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            enabled: true,
            connectionId: null,
            setup: {
              state: "pending",
              reason: null,
              attemptCount: 0,
              nextAttemptAt: null,
              leaseUntil: null,
              claimId: null,
              registerAttemptedAt: null,
              mintAttemptedAt: null,
              updatedAt: "2026-01-01T00:00:00Z",
            },
            binding: null,
          },
        },
      },
    });
    expect(resolveCommsBoardAgentId(commsConnection(), pendingAgent)).toBeNull();
  });

  it("returns null when the passed agent is not the connection's name-encoded owner, in either direction", () => {
    // The badge must only ever read the OWNING agent's binding: a connection
    // named rh-comms-board:<A> must not surface B's board id, and a
    // different agent's valid binding must not surface on A's connection.
    const agentB = commsAgent(
      {
        defaultMcp: {
          version: 1,
          entries: {
            "comms-board": {
              key: "comms-board",
              templateKey: "rh-comms-board",
              dedicated: true,
              binding: { boardAgentId: "7e40a2c9-8b1d-4f6e-9a3c-5d2b8e7f4a10" },
            },
          },
        },
      },
      OTHER_AGENT_ID,
    );
    // Connection owned by A, agent passed is B (B has its own valid binding).
    expect(resolveCommsBoardAgentId(commsConnection(), agentB)).toBeNull();
    // Connection owned by B, agent passed is A (A's metadata is valid).
    expect(
      resolveCommsBoardAgentId(commsConnection({ name: `rh-comms-board:${OTHER_AGENT_ID}` }), commsAgent()),
    ).toBeNull();
  });

  it("trims a padded connection name before matching the comms-board prefix and owner id", () => {
    expect(
      resolveCommsBoardAgentId(
        commsConnection({ name: `  rh-comms-board: ${AGENT_ID}  ` }),
        commsAgent(),
      ),
    ).toBe(BOARD_ID);
  });
});

describe("CommsBoardAgentIdBadge (TECH-7592 full-ID visibility, never cut off)", () => {
  const BADGE_BOARD_ID = "7e40a2c9-8b1d-4f6e-9a3c-5d2b8e7f4a10";

  async function renderBadge(boardAgentId: string = BADGE_BOARD_ID) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(() => {
      root.render(<CommsBoardAgentIdBadge boardAgentId={boardAgentId} />);
    });
    const badge = container.querySelector("code");
    return {
      badge,
      cleanup: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  it("renders the full 36-character board agent UUID as visible text, never a shortened form", async () => {
    const { badge, cleanup } = await renderBadge();
    expect(badge).toBeTruthy();
    // The explicit, fully visible text — not merely an aria-label or title
    // attribute (the pre-fix UI hid the full ID behind a popover).
    expect(badge?.textContent).toBe(BADGE_BOARD_ID);
    expect(BADGE_BOARD_ID).toHaveLength(36);
    expect(badge?.textContent).not.toBe(BADGE_BOARD_ID.slice(0, 8));
    cleanup();
  });

  it("carries the full ID in both title and aria-label (accessible), with the text as the primary carrier", async () => {
    const { badge, cleanup } = await renderBadge();
    expect(badge?.getAttribute("title")).toBe(`Comms board agent ID: ${BADGE_BOARD_ID}`);
    expect(badge?.getAttribute("aria-label")).toBe(`Comms board agent ID: ${BADGE_BOARD_ID}`);
    // Tooltip is a redundancy, not the only carrier.
    expect(badge?.textContent).toBe(BADGE_BOARD_ID);
    cleanup();
  });

  it("never truncates or ellipsizes the ID: break-all and max-w-full with select-all, no truncate class", async () => {
    // Structural class assertions (jsdom cannot prove real layout; the
    // classes are what make the ID wrap at narrow widths instead of
    // clipping): the ID itself wraps (break-all, max-w-full) while the row
    // title is what truncates first.
    const { badge, cleanup } = await renderBadge();
    expect(badge?.className).toContain("max-w-full");
    expect(badge?.className).toContain("break-all");
    expect(badge?.className).toContain("select-all");
    expect(badge?.className).toContain("font-mono");
    expect(badge?.className).not.toContain("truncate");
    expect(badge?.className).not.toContain("ellipsis");
    cleanup();
  });

  it("stops click propagation so selecting the ID never triggers row navigation", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const rowClick = vi.fn();
    await act(() => {
      root.render(
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div onClick={rowClick}>
          <CommsBoardAgentIdBadge boardAgentId={BADGE_BOARD_ID} />
        </div>,
      );
    });
    const badge = container.querySelector("code");
    await act(() => {
      badge?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rowClick).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });
});

describe("resolveArcanaBrainId (TECH-7673 Arcana brain ID resolution)", () => {
  const PAPERCLIP_AGENT_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
  const ARCANA_PRINCIPAL_ID = "33333333-3333-5333-8333-333333333333";
  const CANONICAL_BRAIN_ID = `agent:${ARCANA_PRINCIPAL_ID}`;
  const BOARD_UUID = "44444444-4444-4444-8444-444444444444";
  const CONN_ID = "c-arcana-conn-1";

  function arcanaConnection(overrides: Partial<ToolConnection> = {}): ToolConnection {
    return connection({
      id: CONN_ID,
      name: `rh-arcana-brain:${PAPERCLIP_AGENT_ID}`,
      credentialPolicy: "per_agent",
      ...overrides,
    });
  }

  function arcanaAgent(
    metadata: Record<string, unknown> | null = {
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            connectionId: CONN_ID,
            setup: {
              state: "ready",
              reason: null,
              attemptCount: 1,
              nextAttemptAt: null,
              leaseUntil: null,
              claimId: null,
              registerAttemptedAt: null,
              mintAttemptedAt: null,
              updatedAt: "2026-01-01T00:00:00Z",
            },
            binding: {
              boardAgentId: null,
              baseSub: ARCANA_PRINCIPAL_ID,
              agentKey: null,
              boardSub: null,
              secretId: "sec-arcana-1",
              secretVersion: "latest",
              connectionId: CONN_ID,
              grantId: "grant-arcana-1",
              tokenExpiresAt: null,
            },
          },
        },
      },
    },
    id = PAPERCLIP_AGENT_ID,
  ): Agent {
    return {
      ...agent(id, "Arcana Agent"),
      metadata: metadata as Record<string, unknown>,
    };
  }

  it("resolves the authoritative canonical brain ID from arcana-brain entry metadata", () => {
    expect(resolveArcanaBrainId(arcanaConnection(), arcanaAgent())).toBe(CANONICAL_BRAIN_ID);
  });

  it("normalizes uppercase baseSub UUID to lowercase with agent: prefix", () => {
    const uppercasePrincipal = ARCANA_PRINCIPAL_ID.toUpperCase();
    const a = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            connectionId: CONN_ID,
            setup: { state: "ready" },
            binding: { baseSub: uppercasePrincipal, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), a)).toBe(CANONICAL_BRAIN_ID.toLowerCase());
  });

  it("returns null when connection or agent is missing", () => {
    expect(resolveArcanaBrainId(null, arcanaAgent())).toBeNull();
    expect(resolveArcanaBrainId(arcanaConnection(), null)).toBeNull();
  });

  it("returns null when credentialPolicy is not per_agent", () => {
    expect(resolveArcanaBrainId(arcanaConnection({ credentialPolicy: "shared" }), arcanaAgent())).toBeNull();
  });

  it("returns null when connection name does not start with rh-arcana-brain:", () => {
    expect(resolveArcanaBrainId(arcanaConnection({ name: `rh-comms-board:${PAPERCLIP_AGENT_ID}` }), arcanaAgent())).toBeNull();
    expect(resolveArcanaBrainId(arcanaConnection({ name: `slack:${PAPERCLIP_AGENT_ID}` }), arcanaAgent())).toBeNull();
  });

  it("returns null when connection name has a different agent ID (owner mismatch)", () => {
    expect(resolveArcanaBrainId(arcanaConnection({ name: `rh-arcana-brain:${OTHER_AGENT_ID}` }), arcanaAgent())).toBeNull();
  });

  it("returns null when metadata is missing, empty, or an array", () => {
    expect(resolveArcanaBrainId(arcanaConnection(), arcanaAgent(null))).toBeNull();
    expect(resolveArcanaBrainId(arcanaConnection(), arcanaAgent({}))).toBeNull();
    expect(resolveArcanaBrainId(arcanaConnection(), arcanaAgent([] as unknown as Record<string, unknown>))).toBeNull();
  });

  it("returns null when defaultMcp version is not 1", () => {
    const a = arcanaAgent({ defaultMcp: { version: 2, entries: {} } });
    expect(resolveArcanaBrainId(arcanaConnection(), a)).toBeNull();
  });

  it("returns null when arcana-brain entry is missing or another tool only", () => {
    const a = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": { key: "comms-board", templateKey: "rh-comms-board", setup: { state: "ready" }, binding: { boardAgentId: BOARD_UUID } },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), a)).toBeNull();
  });

  it("returns null when setup.state is not 'ready' (e.g. pending or error)", () => {
    const pendingAgent = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "pending" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), pendingAgent)).toBeNull();

    const errorAgent = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "error" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), errorAgent)).toBeNull();
  });

  it("returns null when connectionId on entry or binding mismatches connection.id", () => {
    const mismatchedEntry = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            connectionId: "other-conn-id",
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), mismatchedEntry)).toBeNull();

    const mismatchedBinding = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            connectionId: CONN_ID,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: "other-conn-id" },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), mismatchedBinding)).toBeNull();
  });

  it("resolves canonical ID when connectionId is legacy null or omitted on entry and binding", () => {
    const legacyAgent = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            connectionId: null,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: null },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), legacyAgent)).toBe(CANONICAL_BRAIN_ID);
  });

  it("returns null when baseSub is missing or not a valid UUID (never falls back to Paperclip UUID, board ID, or conn ID)", () => {
    const badBaseSub = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: "not-a-uuid", boardAgentId: BOARD_UUID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), badBaseSub)).toBeNull();

    const missingBinding = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: null,
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), missingBinding)).toBeNull();
  });

  it("resolves a compat entry stored under a different entries key via its arcana-brain key alias (ready setup + valid baseSub required)", () => {
    // The server today always writes entries["arcana-brain"] (the spec key is
    // frozen at creation); the alias scan is deliberate compatibility for
    // differently-slotted shapes. The entry still has to identify itself via
    // key/templateKey AND carry a ready setup plus a valid baseSub binding.
    const keyedAlias = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "legacy-arcana": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), keyedAlias)).toBe(CANONICAL_BRAIN_ID);

    // Stricter than the comms resolver: an entry identified only by
    // templateKey, whose key belongs to another template, is rejected — the
    // key and the templateKey must agree on the arcana-brain contract.
    const templateKeyOnlyAlias = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "other-slot": {
            key: "legacy-arcana-entry",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), templateKeyOnlyAlias)).toBeNull();
  });

  it("rejects foreign-slot candidates unless BOTH key==='arcana-brain' AND templateKey==='rh-arcana-brain' match exactly", () => {
    // Foreign slot with key-only (templateKey missing / undefined)
    const keyOnlyMissing = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), keyOnlyMissing)).toBeNull();

    // Foreign slot with templateKey-only (key missing / undefined)
    const templateKeyOnlyMissing = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), templateKeyOnlyMissing)).toBeNull();

    // Foreign slot with null discriminators
    const keyWithNullTemplateKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "arcana-brain",
            templateKey: null,
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), keyWithNullTemplateKey)).toBeNull();

    const templateKeyWithNullKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: null,
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), templateKeyWithNullKey)).toBeNull();

    // Foreign slot with number discriminators
    const keyWithNumberTemplateKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "arcana-brain",
            templateKey: 123,
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), keyWithNumberTemplateKey)).toBeNull();

    const templateKeyWithNumberKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: 123,
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), templateKeyWithNumberKey)).toBeNull();

    // Foreign slot with non-string discriminators (boolean, object)
    const keyWithBoolTemplateKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "arcana-brain",
            templateKey: true,
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), keyWithBoolTemplateKey)).toBeNull();

    const templateKeyWithObjKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: { name: "arcana-brain" },
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), templateKeyWithObjKey)).toBeNull();

    // Foreign slot with whitespace (exact string equality required, no loose whitespace)
    const keyWithWhitespaceTemplateKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "arcana-brain",
            templateKey: " rh-arcana-brain ",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), keyWithWhitespaceTemplateKey)).toBeNull();

    const templateKeyWithWhitespaceKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: " arcana-brain ",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), templateKeyWithWhitespaceKey)).toBeNull();

    // Foreign slot with empty strings
    const emptyStringTemplateKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "arcana-brain",
            templateKey: "",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), emptyStringTemplateKey)).toBeNull();

    const emptyStringKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), emptyStringKey)).toBeNull();

    // Foreign slot with mixed wrong domain
    const mixedCommsTemplate = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "arcana-brain",
            templateKey: "rh-comms-board",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), mixedCommsTemplate)).toBeNull();

    const mixedCommsKey = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "comms-board",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), mixedCommsKey)).toBeNull();

    // Valid foreign slot with BOTH discriminators exact
    const validForeignSlot = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "foreign-slot": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), validForeignSlot)).toBe(CANONICAL_BRAIN_ID);
  });

  it("returns null when the direct entries[\"arcana-brain\"] hit is another template's entry (squatted slot or mixed key/templateKey)", () => {
    // A squatted entries slot must not resolve even though the slot key says
    // "arcana-brain": the entry's own key/templateKey identify the template,
    // and neither matches the arcana-brain contract.
    const squatted = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), squatted)).toBeNull();

    // Mixed identifiers (right key, wrong templateKey) are rejected too.
    const mixed = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-comms-board",
            dedicated: true,
            setup: { state: "ready" },
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), mixed)).toBeNull();
  });

  it("returns null when the setup state object is missing entirely, not just pending or error", () => {
    // The arcana contract requires a setup state ("ready" is the terminal
    // state default-mcp-setup.ts's arcanaBrainHook returns); an entry with no
    // setup object at all has never been through the hook.
    const noSetup = arcanaAgent({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            binding: { baseSub: ARCANA_PRINCIPAL_ID, connectionId: CONN_ID },
          },
        },
      },
    });
    expect(resolveArcanaBrainId(arcanaConnection(), noSetup)).toBeNull();
  });

  it("keeps the comms-board and arcana-brain domains separate when one agent has both entries and both dedicated connections", () => {
    // The realistic TECH-7673 surface state: one agent owning a comms-board
    // dedicated connection AND an arcana-brain dedicated connection, with
    // both entries in one defaultMcp. Four pairwise-distinct identity domains
    // meet here: the internal Paperclip agent UUID (111…, name-encoded in
    // both connections), the comms board agent UUID (444…, the only correct
    // comms answer), the Arcana principal UUID (333…, the only correct Arcana
    // answer in its canonical agent:… form), and the dedicated connection
    // UUIDs (555…). Each resolver must answer only for its own domain's
    // connection and return null for the sibling's — no cross-entry leak.
    const commsConnOverrides: Partial<ToolConnection> = {
      id: "55555555-5555-4555-8555-555555555556",
      name: `rh-comms-board:${PAPERCLIP_AGENT_ID}`,
      credentialPolicy: "per_agent",
    };
    const commsConn = connection(commsConnOverrides);
    const arcanaConn = arcanaConnection({ id: "55555555-5555-4555-8555-555555555555" });
    const bothEntriesAgent = arcanaAgent(
      {
        defaultMcp: {
          version: 1,
          entries: {
            "comms-board": {
              key: "comms-board",
              templateKey: "rh-comms-board",
              dedicated: true,
              connectionId: commsConn.id,
              binding: {
                boardAgentId: BOARD_UUID,
                baseSub: `paperclip-agent-${PAPERCLIP_AGENT_ID}`,
                connectionId: commsConn.id,
              },
            },
            "arcana-brain": {
              key: "arcana-brain",
              templateKey: "rh-arcana-brain",
              dedicated: true,
              connectionId: arcanaConn.id,
              setup: { state: "ready" },
              binding: { boardAgentId: null, baseSub: ARCANA_PRINCIPAL_ID, connectionId: arcanaConn.id },
            },
          },
        },
      },
      PAPERCLIP_AGENT_ID,
    );

    // Each domain's resolver answers for its own connection with exactly its
    // own domain's identifier — never the sibling's.
    expect(resolveCommsBoardAgentId(commsConn, bothEntriesAgent)).toBe(BOARD_UUID);
    expect(resolveCommsBoardAgentId(commsConn, bothEntriesAgent)).not.toBe(CANONICAL_BRAIN_ID);
    expect(resolveArcanaBrainId(arcanaConn, bothEntriesAgent)).toBe(CANONICAL_BRAIN_ID);
    expect(resolveArcanaBrainId(arcanaConn, bothEntriesAgent)).not.toBe(BOARD_UUID);
    // And each returns null for the sibling domain's connection — an Arcana
    // connection must never surface the comms board UUID, and a comms
    // connection must never surface the canonical brain ID.
    expect(resolveArcanaBrainId(commsConn, bothEntriesAgent)).toBeNull();
    expect(resolveCommsBoardAgentId(arcanaConn, bothEntriesAgent)).toBeNull();
  });
});

describe("ArcanaBrainIdBadge (TECH-7673 full canonical brain ID visibility)", () => {
  const BADGE_BRAIN_ID = "agent:33333333-3333-5333-8333-333333333333";

  async function renderBadge(brainId: string = BADGE_BRAIN_ID) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(() => {
      root.render(<ArcanaBrainIdBadge brainId={brainId} />);
    });
    const badge = container.querySelector("code");
    return {
      badge,
      cleanup: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  it("renders the full 42-character canonical brain ID as visible text", async () => {
    const { badge, cleanup } = await renderBadge();
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe(BADGE_BRAIN_ID);
    expect(BADGE_BRAIN_ID).toHaveLength(42);
    expect(badge?.textContent).not.toBe(BADGE_BRAIN_ID.slice(0, 14));
    cleanup();
  });

  it("carries the full ID in both title and aria-label with Arcana brain ID prefix", async () => {
    const { badge, cleanup } = await renderBadge();
    expect(badge?.getAttribute("title")).toBe(`Arcana brain ID: ${BADGE_BRAIN_ID}`);
    expect(badge?.getAttribute("aria-label")).toBe(`Arcana brain ID: ${BADGE_BRAIN_ID}`);
    cleanup();
  });

  it("never truncates or ellipsizes the ID: break-all and max-w-full with select-all", async () => {
    const { badge, cleanup } = await renderBadge();
    expect(badge?.className).toContain("max-w-full");
    expect(badge?.className).toContain("break-all");
    expect(badge?.className).toContain("select-all");
    expect(badge?.className).toContain("font-mono");
    expect(badge?.className).not.toContain("truncate");
    expect(badge?.className).not.toContain("ellipsis");
    cleanup();
  });

  it("stops click propagation so selecting the ID never triggers row navigation", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const rowClick = vi.fn();
    await act(() => {
      root.render(
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div onClick={rowClick}>
          <ArcanaBrainIdBadge brainId={BADGE_BRAIN_ID} />
        </div>,
      );
    });
    const badge = container.querySelector("code");
    await act(() => {
      badge?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rowClick).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });
});

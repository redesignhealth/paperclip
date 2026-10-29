import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { connectorToolDefinitionsForSkills, resolveConnectorAssignments } from "./connector-runtime.js";

const resolvers = vi.hoisted(() => ({
  browser: vi.fn(), speko: vi.fn(), slack: vi.fn(), inboxes: vi.fn(),
}));
vi.mock("./native-runtime/assigned-mcp-tools.js", () => ({ getAssignedMcpGateway: () => ({ browserUseResources: resolvers.browser }) }));
vi.mock("./voice/speko-agent-tools.js", () => ({ spekoAssignedResources: resolvers.speko }));
vi.mock("./connectors/slack.js", () => ({ slackAssignedResource: resolvers.slack, executeGovernedSlackTool: vi.fn() }));
vi.mock("./email-channels.js", () => ({ emailChannelService: () => ({ assignedInboxes: resolvers.inboxes }) }));

afterEach(() => vi.resetAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("connector assignment preparation", () => {
  it("starts independent resolvers together and retains connector order", async () => {
    const pending = Array.from({ length: 4 }, () => deferred<Array<{ id: string; label: string; connectionId: string; address: string }>>());
    Object.values(resolvers).forEach((resolver, i) => resolver.mockReturnValue(pending[i].promise));
    const assignments = resolveConnectorAssignments({} as Db, { companyId: "company", agentId: "agent" });
    await vi.waitFor(() => Object.values(resolvers).forEach(resolver => expect(resolver).toHaveBeenCalledOnce()));
    for (const i of [3, 2, 1, 0]) pending[i].resolve([{ id: `resource-${i}`, connectionId: `connection-${i}`, label: "Resource", address: "inbox@example.com" }]);
    expect((await assignments).map(assignment => assignment.key)).toEqual(["browser-use-cloud", "speko", "slack", "agentmail"]);
  });

  it("does not look up Slack endpoints for non-Slack assignments", async () => {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([{ id: "inbox", address: "inbox@example.com", connectionId: "email" }]);
    const select = vi.fn();
    const assignments = await resolveConnectorAssignments({ select } as unknown as Db, {
      companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
    });
    expect(assignments.map(assignment => assignment.key)).toEqual(["agentmail"]);
    expect(select).not.toHaveBeenCalled();
  });

  /**
   * Minimal stub for the two reads gating performs: the endpoint rows, then the
   * prior-install (legacy) lookup. Gating is requested AND installed.
   */
  function gatingDb(rows: Array<Record<string, unknown>> | Error, legacy = false) {
    let call = 0;
    const select = vi.fn(() => {
      call += 1;
      const isEndpointRead = call === 1;
      return {
        from: () => ({
          where: async () => {
            if (rows instanceof Error) throw rows;
            return isEndpointRead ? rows : [];
          },
          innerJoin: () => ({
            where: async () => {
              if (rows instanceof Error) throw rows;
              return legacy ? rows : [];
            },
          }),
        }),
      };
    });
    return select;
  }

  it.each(["default", "upload", "empty", "error"])("filters a task-bound Slack assignment with a %s lookup", async mode => {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "slack", label: "Slack", connectionId: "connection" }]);
    const rows = mode === "error"
      ? new Error("Endpoint lookup unavailable")
      : mode === "empty"
        ? []
        // A group counts only when both requested and installed.
        : [{ id: "slack", setup: {
            slackOptInScopeGroups: mode === "upload" ? ["file_upload"] : [],
            slackInstalledOptInScopeGroups: mode === "upload" ? ["file_upload"] : [],
          } }];
    const select = gatingDb(rows);
    const assignments = await resolveConnectorAssignments({ select } as unknown as Db, {
      companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
    });
    const names = assignments[0].tools.map(tool => tool.name);
    expect(names.includes("slack_upload_file")).toBe(mode === "upload");
    expect(names).not.toContain("slack_create_channel");
    expect(names).not.toContain("slack_open_dm");
    if (mode === "empty" || mode === "error") expect(names).toEqual([]);
    else expect(names).toContain("slack_history");
  });

  it("keeps a requested-but-not-installed group gated", async () => {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "slack", label: "Slack", connectionId: "connection" }]);
    const select = gatingDb([
      { id: "slack", setup: { slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: [] } },
    ]);
    const assignments = await resolveConnectorAssignments({ select } as unknown as Db, {
      companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
    });
    expect(assignments[0].tools.map(tool => tool.name)).not.toContain("slack_upload_file");
  });


  it("settles outstanding resolution before propagating a failed connector", async () => {
    const slack = deferred<[]>();
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockRejectedValue(new Error("Speko unavailable"));
    resolvers.slack.mockReturnValue(slack.promise);
    resolvers.inboxes.mockResolvedValue([]);
    let settled = false;
    const assignments = resolveConnectorAssignments({} as Db, { companyId: "company", agentId: "agent" });
    const result = expect(assignments).rejects.toThrow("Speko unavailable").finally(() => { settled = true; });
    await vi.waitFor(() => expect(resolvers.slack).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    slack.resolve([]);
    await result;
  });
});

describe("connector tool definitions fail closed", () => {
  const slackSkill = "paperclipai/paperclip/slack";

  it("yields no gated Slack tools when the enabled set is omitted", () => {
    // S4: an omitted set is not "everything".
    const [slack] = connectorToolDefinitionsForSkills(new Set([slackSkill]));
    const names = slack!.tools.map(tool => tool.name);
    expect(names).not.toContain("slack_upload_file");
    expect(names).not.toContain("slack_create_channel");
    expect(names).not.toContain("slack_invite");
    expect(names).not.toContain("slack_open_dm");
    // Ungated Slack tools are unaffected.
    expect(names).toContain("slack_history");
  });

  it("includes a gated tool once the enabled set names it", () => {
    const [slack] = connectorToolDefinitionsForSkills(new Set([slackSkill]), new Set(["slack_upload_file"]));
    const names = slack!.tools.map(tool => tool.name);
    expect(names).toContain("slack_upload_file");
    expect(names).not.toContain("slack_create_channel");
  });
});

describe("Slack connector gating is requested and installed", () => {
  function gatingDb(rows: Array<Record<string, unknown>>) {
    let call = 0;
    return vi.fn(() => {
      call += 1;
      const first = call === 1;
      return {
        from: () => ({
          where: async () => (first ? rows : []),
          innerJoin: () => ({ where: async () => [] }),
        }),
      };
    });
  }

  async function slackToolNames(setup: Record<string, unknown>) {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "slack", label: "Slack", connectionId: "connection" }]);
    const assignments = await resolveConnectorAssignments({ select: gatingDb([{ id: "slack", setup }]) } as unknown as Db, {
      companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
    });
    return assignments[0]!.tools.map(tool => tool.name);
  }

  it("disables a granted group the operator removed", async () => {
    // Slack still reports the scope, but the request is empty.
    const names = await slackToolNames({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: ["file_upload"] });
    expect(names).not.toContain("slack_upload_file");
    expect(names).toContain("slack_history");
  });

  it("offers a group only when requested and installed", async () => {
    const names = await slackToolNames({ slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"] });
    expect(names).toContain("slack_upload_file");
  });
});

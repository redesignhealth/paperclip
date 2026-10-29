import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { SLACK_TOOLS } from "@paperclipai/shared";
import { executeSlackTool, executeGovernedSlackTool } from "./slack.js";
import { executeSlackWrite } from "./slack-writes.js";
import { registerSlackTaskAuthority, type SlackTaskAuthority } from "./slack-authority.js";
import { slackEnabledToolsForSetup } from "./slack-opt-ins.js";

/**
 * TECH-7988: a tool this agent did not enable must be rejected before any Slack
 * API call, not surfaced later as a Slack `missing_scope`. Gating is requested
 * AND installed, and dispatch must agree with the listing exactly.
 */
describe("Slack tool dispatch opt-in gating", () => {
  const binding = {
    companyId: "company",
    agentId: "agent",
    runId: "run",
    issueId: "issue",
  };

  function authority(setup: Record<string, unknown>) {
    return {
      endpoint: {
        id: "endpoint",
        companyId: "company",
        providerAccountId: "T1",
        botExternalId: "UBOT",
        allowDirectMessages: true,
        setup,
      },
      conversation: null,
      slackUserId: "U1",
      principalId: "principal",
      userId: "user",
      deliveryId: null,
      identityContextId: null,
      revision: "revision",
      workMode: "standard",
      botToken: "xoxb-test",
    } as unknown as SlackTaskAuthority;
  }

  async function withAuthority<T>(
    setup: Record<string, unknown>,
    run: (db: Db) => Promise<T>,
  ): Promise<T> {
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => authority(setup));
    try {
      return await run(db);
    } finally {
      unregister();
    }
  }

  it.each([
    ["slack_upload_file", { attachmentId: "00000000-0000-4000-8000-000000000000", channel: "C1", idempotencyKey: "00000000-0000-4000-8000-000000000001" }],
    ["slack_open_dm", { idempotencyKey: "00000000-0000-4000-8000-000000000002" }],
  ])("rejects %s before any Slack call when the group is off", async (tool, args) => {
    await withAuthority({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] }, async (db) => {
      const fetchImpl = vi.fn();
      await expect(executeSlackTool(db, binding, tool, args, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("keeps a requested but uninstalled group disabled", async () => {
    await withAuthority({ slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: [] }, async (db) => {
      const fetchImpl = vi.fn();
      await expect(executeSlackTool(db, binding, "slack_upload_file", {
        attachmentId: "00000000-0000-4000-8000-000000000000",
        channel: "C1",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ details: { code: "slack_tool_not_enabled" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("keeps a removed group disabled even though Slack kept the grant", async () => {
    // Installed says granted; requested says the operator removed it.
    await withAuthority({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: ["channel_management"] }, async (db) => {
      const fetchImpl = vi.fn();
      await expect(executeSlackTool(db, binding, "slack_create_channel", {
        name: "launch", is_private: false, idempotencyKey: "00000000-0000-4000-8000-000000000003",
      }, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe("Slack governed dispatch opt-in gating", () => {
  it("names the missing opt-in before entering the tool gateway", async () => {
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => authorityFor({ slackOptInScopeGroups: [] }));
    try {
      await expect(executeGovernedSlackTool(db, { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" },
        "slack_create_channel", { name: "launch", is_private: false, idempotencyKey: "00000000-0000-4000-8000-000000000004" }))
        .rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled", groups: ["channel_management"] } });
    } finally {
      unregister();
    }
  });

  function authorityFor(setup: Record<string, unknown>) {
    return {
      endpoint: { id: "endpoint", companyId: "company", setup },
    } as unknown as SlackTaskAuthority;
  }
});

describe("Slack write dispatch opt-in gating", () => {
  it("rejects a disabled write before any Slack call", async () => {
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => ({
      endpoint: { id: "endpoint", companyId: "company", setup: { slackOptInScopeGroups: [] } },
      workMode: "standard",
    }) as unknown as SlackTaskAuthority);
    const fetchImpl = vi.fn();
    try {
      await expect(executeSlackWrite(
        db,
        { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" },
        "slack_upload_file",
        { attachmentId: "00000000-0000-4000-8000-000000000000", channel: "C1", idempotencyKey: "00000000-0000-4000-8000-000000000001" },
        undefined,
        fetchImpl as unknown as typeof fetch,
      )).rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});

describe("Slack gating fail-closed edges", () => {
  it("rejects an unknown tool as a client error instead of a TypeError", async () => {
    await expect(executeSlackWrite(
      {} as Db,
      { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" },
      "slack_not_a_tool",
      {},
      undefined,
    )).rejects.toMatchObject({ status: 400, details: { code: "unknown_slack_tool" } });
  });

  it("treats a row with no opt-in fields and no prior install as having no groups", async () => {
    // Two reads: the endpoint row, then the prior-install (legacy) lookup.
    let call = 0;
    const db = {
      select: vi.fn(() => {
        call += 1;
        const first = call === 1;
        return {
          from: () => ({
            where: async () => (first ? [{ id: "endpoint", setup: {} }] : []),
            innerJoin: () => ({ where: async () => [] }),
          }),
        };
      }),
    } as unknown as Db;
    await withAuthorityOn(db, { }, async () => {
      const fetchImpl = vi.fn();
      await expect(executeSlackTool(db, {
        companyId: "company", agentId: "agent", runId: "run", issueId: "issue", endpointId: "endpoint",
      }, "slack_upload_file", {
        attachmentId: "00000000-0000-4000-8000-000000000000",
        channel: "C1",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }, fetchImpl as unknown as typeof fetch)).rejects.toThrow("not enabled for this agent");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  async function withAuthorityOn<T>(db: Db, setup: Record<string, unknown>, run: () => Promise<T>) {
    const unregister = registerSlackTaskAuthority(db, async () => ({
      endpoint: {
        id: "endpoint", companyId: "company", providerAccountId: "T1",
        botExternalId: "UBOT", allowDirectMessages: true, setup,
      },
      conversation: null, slackUserId: "U1", principalId: "principal", userId: "user",
      deliveryId: null, identityContextId: null, revision: "revision",
      workMode: "standard", botToken: "xoxb-test",
    }) as unknown as SlackTaskAuthority);
    try {
      return await run();
    } finally {
      unregister();
    }
  }
});

/**
 * The property that matters most: for every requested/installed combination,
 * the set a listing offers equals the set dispatch accepts. A mismatch means a
 * tool is advertised but fails, or is callable while hidden.
 */
describe("Slack listing and dispatch agree", () => {
  const groups = ["channel_management", "proactive_dms", "file_upload"] as const;
  const subsets = (items: readonly (typeof groups)[number][]) =>
    items.reduce<(typeof groups)[number][][]>((acc, group) => [...acc, ...acc.map(set => [...set, group])], [[]]);
  const gatedTools = SLACK_TOOLS.filter(tool => tool.name !== "slack_search");

  it("agrees for every requested/installed combination", async () => {
    for (const requested of subsets(groups)) {
      for (const installed of subsets(groups)) {
        const setup = { slackOptInScopeGroups: requested, slackInstalledOptInScopeGroups: installed };
        const listed = new Set(slackEnabledToolsForSetup(setup).map(tool => String(tool.name)));
        const db = {} as Db;
        const unregister = registerSlackTaskAuthority(db, async () => ({
          endpoint: {
            id: "endpoint", companyId: "company", providerAccountId: "T1",
            botExternalId: "UBOT", allowDirectMessages: true, setup,
          },
          conversation: null, slackUserId: "U1", principalId: "principal", userId: "user",
          deliveryId: null, identityContextId: null, revision: "revision",
          workMode: "standard", botToken: "xoxb-test",
        }) as unknown as SlackTaskAuthority);
        try {
          for (const tool of gatedTools) {
            // A gated-off tool must fail on gating, before argument parsing or
            // any Slack call; a listed tool must get past the gate.
            const error = await executeSlackTool(db, {
              companyId: "company", agentId: "agent", runId: "run", issueId: "issue", endpointId: "endpoint",
            }, tool.name, {}, vi.fn() as unknown as typeof fetch).catch(failure => failure);
            const gatedOut = error?.details?.code === "slack_tool_not_enabled";
            expect(gatedOut).toBe(!listed.has(tool.name));
          }
        } finally {
          unregister();
        }
      }
    }
  });
});

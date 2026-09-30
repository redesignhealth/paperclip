import { describe, expect, it } from "vitest";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  GATEWAY_CONTEXT_TOOLS,
  contextToolsForAllowedActions,
  createToolGatewayService,
} from "../services/tool-gateway.js";
import { createAdapterRuntimeMcpAccess } from "../services/heartbeat.js";

describe("heartbeat runtime MCP access & context tools", () => {
  describe("getAssignedGatewayToolNames", () => {
    const mockRows = [
      {
        catalogEntry: {
          id: "entry-1",
          name: "create_issue",
          toolName: "create_issue",
          title: "Create Issue",
          riskLevel: "write",
          isReadOnly: false,
          isWrite: true,
          isDestructive: false,
        },
        connection: {
          id: "conn-1",
          name: "GitHub",
          transport: "mcp_remote",
          status: "active",
          enabled: true,
          healthStatus: "ok",
          config: {},
        },
        application: {
          id: "app-1",
          name: "GitHub App",
          type: "mcp_http",
          applicationKey: "github",
        },
      },
      {
        catalogEntry: {
          id: "entry-2",
          name: "list_issues",
          toolName: "list_issues",
          title: "List Issues",
          riskLevel: "read",
          isReadOnly: true,
          isWrite: false,
          isDestructive: false,
        },
        connection: {
          id: "conn-1",
          name: "GitHub",
          transport: "mcp_remote",
          status: "active",
          enabled: true,
          healthStatus: "ok",
          config: {},
        },
        application: {
          id: "app-1",
          name: "GitHub App",
          type: "mcp_http",
          applicationKey: "github",
        },
      },
      {
        catalogEntry: {
          id: "entry-3",
          name: "send_message",
          toolName: "send_message",
          title: "Send Message",
          riskLevel: "write",
          isReadOnly: false,
          isWrite: true,
          isDestructive: false,
        },
        connection: {
          id: "conn-2",
          name: "Slack",
          transport: "mcp_remote",
          status: "active",
          enabled: true,
          healthStatus: "ok",
          config: {},
        },
        application: {
          id: "app-2",
          name: "Slack App",
          type: "mcp_http",
          applicationKey: "slack",
        },
      },
    ];

    const mockDb = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                orderBy: () => Promise.resolve(mockRows),
              }),
            }),
          }),
        }),
      }),
    } as any;

    const service = createToolGatewayService(mockDb);

    it("returns empty array when no connections or tools match", async () => {
      const result = await service.getAssignedGatewayToolNames({
        companyId: "company-1",
        assignedConnections: [],
        assignedTools: [],
        fullConnectionIds: new Set(),
      });
      expect(result).toEqual([]);
    });

    it("returns all tools for full-connection grant and omits unassigned connections", async () => {
      const result = await service.getAssignedGatewayToolNames({
        companyId: "company-1",
        assignedConnections: [{ id: "conn-1" }],
        assignedTools: [],
        fullConnectionIds: new Set(["conn-1"]),
        allowedActions: ["tools/list", "tools/call"],
      });
      expect(result).toHaveLength(2);
      expect(result.some((t) => t.includes("create-issue"))).toBe(true);
      expect(result.some((t) => t.includes("list-issues"))).toBe(true);
      expect(result.some((t) => t.includes("send-message"))).toBe(false);
    });

    it("returns only specified tool for per-tool grant", async () => {
      const result = await service.getAssignedGatewayToolNames({
        companyId: "company-1",
        assignedConnections: [{ id: "conn-1" }],
        assignedTools: [{ id: "entry-1", connectionId: "conn-1" }],
        fullConnectionIds: new Set(),
        allowedActions: ["tools/list", "tools/call"],
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("create-issue");
    });

    it("filters context actions and adds only permitted context tools", async () => {
      const resultNoContext = await service.getAssignedGatewayToolNames({
        companyId: "company-1",
        assignedConnections: [{ id: "conn-1" }],
        assignedTools: [{ id: "entry-1", connectionId: "conn-1" }],
        fullConnectionIds: new Set(),
        allowedActions: ["tools/list", "tools/call"],
      });
      expect(resultNoContext).not.toContain("paperclip_list_resources");

      const resultWithContext = await service.getAssignedGatewayToolNames({
        companyId: "company-1",
        assignedConnections: [{ id: "conn-1" }],
        assignedTools: [{ id: "entry-1", connectionId: "conn-1" }],
        fullConnectionIds: new Set(),
        allowedActions: ["tools/list", "tools/call", "resources/list"],
      });
      expect(resultWithContext).toContain("paperclip_list_resources");
      expect(resultWithContext).not.toContain("paperclip_read_resource");
    });

    it("deduplicates and sorts tool names alphabetically", async () => {
      const result = await service.getAssignedGatewayToolNames({
        companyId: "company-1",
        assignedConnections: [{ id: "conn-1" }, { id: "conn-1" }],
        assignedTools: [
          { id: "entry-1", connectionId: "conn-1" },
          { id: "entry-1", connectionId: "conn-1" },
        ],
        fullConnectionIds: new Set(["conn-1"]),
        allowedActions: ["tools/list", "tools/call", "resources/list"],
      });
      const sorted = [...result].sort();
      expect(result).toEqual(sorted);
      expect(new Set(result).size).toBe(result.length);
    });
  });
  describe("contextToolsForAllowedActions", () => {
    it("returns empty array for tokens with only tools/list and tools/call (no dead context tools)", () => {
      const result = contextToolsForAllowedActions(["tools/list", "tools/call"]);
      expect(result).toEqual([]);
    });

    it("returns empty array for undefined or null allowedActions", () => {
      expect(contextToolsForAllowedActions(undefined)).toEqual([]);
      expect(contextToolsForAllowedActions(null)).toEqual([]);
    });

    it("includes paperclip_list_resources when resources/list is allowed", () => {
      const result = contextToolsForAllowedActions(["tools/list", "resources/list"]);
      expect(result.map((t) => t.name)).toEqual(["paperclip_list_resources"]);
    });

    it("includes paperclip_read_resource when resources/read is allowed", () => {
      const result = contextToolsForAllowedActions(["tools/list", "resources/read"]);
      expect(result.map((t) => t.name)).toEqual(["paperclip_read_resource"]);
    });

    it("includes paperclip_list_prompts when prompts/list is allowed", () => {
      const result = contextToolsForAllowedActions(["tools/list", "prompts/list"]);
      expect(result.map((t) => t.name)).toEqual(["paperclip_list_prompts"]);
    });

    it("includes paperclip_get_prompt when prompts/get is allowed", () => {
      const result = contextToolsForAllowedActions(["tools/list", "prompts/get"]);
      expect(result.map((t) => t.name)).toEqual(["paperclip_get_prompt"]);
    });

    it("includes all four context tools when all context actions are allowed", () => {
      const result = contextToolsForAllowedActions([
        "tools/list",
        "tools/call",
        "resources/list",
        "resources/read",
        "prompts/list",
        "prompts/get",
      ]);
      expect(result).toHaveLength(4);
      expect(result.map((t) => t.name)).toEqual([
        "paperclip_list_resources",
        "paperclip_read_resource",
        "paperclip_list_prompts",
        "paperclip_get_prompt",
      ]);
    });

    it("exposes consistent GATEWAY_CONTEXT_TOOLS metadata", () => {
      expect(GATEWAY_CONTEXT_TOOLS).toHaveLength(4);
      for (const tool of GATEWAY_CONTEXT_TOOLS) {
        expect(tool.name).toMatch(/^paperclip_(list|read|get)_/);
        expect(tool.title).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.requiredAction).toMatch(/^(resources|prompts)\//);
      }
    });
  });

  describe("defensive copying and deep freezing of allowedTools", () => {
    it("returns undefined for empty server array", () => {
      expect(createAdapterRuntimeMcpAccess([])).toBeUndefined();
    });

    it("defensively copies and deep freezes allowedTools", () => {
      const mutableTools = ["tool_a", "tool_b"];
      const inputServers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "https://mcp.test",
          token: "tok",
          connectionId: "c1",
          allowedTools: mutableTools,
        },
      ];

      const access = createAdapterRuntimeMcpAccess(inputServers)!;
      expect(access).toBeDefined();

      // Mutate the original input array
      mutableTools.push("tool_c");

      const firstGet = access.getServers();
      expect(firstGet[0]!.allowedTools).toEqual(["tool_a", "tool_b"]);

      // Mutate the returned array
      firstGet[0]!.allowedTools.push("tool_d");

      // Verify that subsequent getServers() call is unaffected
      const secondGet = access.getServers();
      expect(secondGet[0]!.allowedTools).toEqual(["tool_a", "tool_b"]);
    });
  });
});

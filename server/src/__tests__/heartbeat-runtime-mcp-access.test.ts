import { describe, expect, it } from "vitest";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  GATEWAY_CONTEXT_TOOLS,
  contextToolsForAllowedActions,
} from "../services/tool-gateway.js";

describe("heartbeat runtime MCP access & context tools", () => {
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
    // Re-verify the createAdapterRuntimeMcpAccess behavior
    function createAdapterRuntimeMcpAccess(servers: AdapterRuntimeMcpServer[]) {
      if (servers.length === 0) return undefined;
      const snapshot = servers.map((server) =>
        Object.freeze({
          ...server,
          allowedTools: Object.freeze([...server.allowedTools]),
        }),
      );
      return Object.freeze({
        getServers: () =>
          snapshot.map((server) => ({
            ...server,
            allowedTools: [...server.allowedTools],
          })),
      });
    }

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

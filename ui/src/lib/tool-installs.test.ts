import { describe, expect, it } from "vitest";
import type { ToolConnectionInstall } from "@paperclipai/shared";
import { defaultMcpConnectionRole, defaultMcpPendingEntries, isDefaultMcpManagedConnection, installPayload, installStateFrom, isAgentInstalled } from "./tool-installs";

const install = (targetType: "company" | "agent", targetId: string) => ({ targetType, targetId }) as ToolConnectionInstall;

describe("default-MCP aware install state", () => {
  const installs = [install("company", "co-1"), install("agent", "other-agent")];

  it("keeps today's behaviour for ordinary agents: a company install means installed for all", () => {
    const state = installStateFrom(installs);
    expect(state.onAll).toBe(true);
    expect(isAgentInstalled(state, "agent-1")).toBe(true);
    expect(installPayload("co-1", state)).toEqual([{ targetType: "company", targetId: "co-1" }]);
  });

  it("ignores the company install for a managed connection and writes it back unchanged with the explicit agent rows", () => {
    const state = installStateFrom(installs, { ignoreCompanyInstall: true });
    expect(state.onAll).toBe(false);
    expect(isAgentInstalled(state, "agent-1")).toBe(false);
    state.agentIds.add("agent-1"); // the normal checkbox toggle
    expect(isAgentInstalled(state, "agent-1")).toBe(true);
    expect(installPayload("co-1", state)).toEqual([
      { targetType: "company", targetId: "co-1" },
      { targetType: "agent", targetId: "other-agent" },
      { targetType: "agent", targetId: "agent-1" },
    ]);
    state.agentIds.delete("agent-1"); // toggling off removes only the agent row
    expect(installPayload("co-1", state)).toEqual([
      { targetType: "company", targetId: "co-1" },
      { targetType: "agent", targetId: "other-agent" },
    ]);
  });

  it("without a company install the payload is unchanged even for managed connections", () => {
    const state = installStateFrom([install("agent", "agent-1")], { ignoreCompanyInstall: true });
    expect(installPayload("co-1", state)).toEqual([{ targetType: "agent", targetId: "agent-1" }]);
  });

  it("classifies connections: own/ordinary = managed; a dedicated entry's template and other agents' dedicated connections = forbidden", () => {
    const entry = (over: Record<string, unknown>) => ({ connectionId: null, templateConnectionId: null, templateKey: null, dedicated: false, ...over });
    const metadata = { defaultMcp: { version: 1, entries: {
      comms: entry({ key: "comms", templateKey: "rh-comms-board", dedicated: true, templateConnectionId: "t1", connectionId: "d1" }),
      google: entry({ key: "google", templateKey: "rh-google-mcp" }),
    } } };
    const conn = (over: Record<string, unknown> = {}) => ({ id: "x", name: "other", companyId: "co-1", ...over });
    expect(defaultMcpConnectionRole(metadata, conn({ id: "d1" }), "co-1")).toBe("managed"); // own, by stored id
    expect(defaultMcpConnectionRole(metadata, conn({ id: "t1" }), "co-1")).toBe("forbidden"); // provisioning-only template
    expect(defaultMcpConnectionRole(metadata, conn({ name: "rh-comms-board" }), "co-1")).toBe("forbidden"); // template by frozen name
    expect(defaultMcpConnectionRole(metadata, conn({ name: "rh-comms-board:other-agent" }), "co-1")).toBe("forbidden"); // prefix never authorizes
    expect(defaultMcpConnectionRole(metadata, conn({ name: "rh-google-mcp" }), "co-1")).toBe("managed"); // ordinary entry: the org connection itself
    expect(defaultMcpConnectionRole(metadata, conn({ name: "rh-google-mcp:abc" }), "co-1")).toBeNull();
    expect(defaultMcpConnectionRole(metadata, conn({ id: "d1", companyId: "co-2" }), "co-1")).toBeNull();
    expect(defaultMcpConnectionRole(null, conn({ id: "d1" }), "co-1")).toBeNull();
    expect(defaultMcpConnectionRole({ defaultMcp: { forged: true } }, conn({ id: "d1" }), "co-1")).toBeNull();
    expect(isDefaultMcpManagedConnection(metadata, conn({ id: "t1" }), "co-1")).toBe(false);
  });

  it("lists default entries without a connection as pending rows", () => {
    const metadata = { defaultMcp: { version: 1, entries: {
      comms: { key: "comms", templateKey: "rh-comms-board", dedicated: true, connectionId: null, setup: { state: "pending", reason: "owner_required" } },
      ready: { key: "ready", templateKey: "x", dedicated: true, connectionId: "d1", setup: { state: "ready", reason: null } },
    } } };
    expect(defaultMcpPendingEntries(metadata)).toEqual([{ key: "comms", name: "rh-comms-board", state: "pending", reason: "owner_required" }]);
    expect(defaultMcpPendingEntries(null)).toEqual([]);
  });
});

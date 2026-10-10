import { describe, expect, it } from "vitest";
import type { ToolConnectionInstall } from "@paperclipai/shared";
import {
  defaultMcpConnectionRole,
  defaultMcpPendingEntries,
  isDefaultMcpManagedConnection,
  isDefaultMcpSeed,
  isPersonalDefaultMcpInstance,
  installPayload,
  installStateFrom,
  isAgentInstalled,
} from "./tool-installs";

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

describe("TECH-7340: discovery-only seeds and personal instances in default-MCP install state", () => {
  const entry = (over: Record<string, unknown>) => ({
    connectionId: null, templateConnectionId: null, templateKey: null, dedicated: false, ...over,
  });
  const metadata = { defaultMcp: { version: 1, entries: {
    google: entry({ key: "rh-google-mcp", templateKey: "rh-google-mcp" }),
    rh: entry({ key: "rh-mcp", templateKey: "rh-mcp-personal" }),
  } } };
  const seedConfig = { defaultMcpManaged: "seed", paperclipDefaultMcpEntry: "rh-google-mcp" };
  const personalConfig = {
    defaultMcpManaged: "personal",
    paperclipDefaultMcpEntry: "rh-mcp",
    identityModel: "personal_only",
  };
  const conn = (over: Record<string, unknown> = {}) => ({ id: "x", name: "other", companyId: "co-1", ...over });

  it("classifies a seed as forbidden for every agent state, and a tagged personal instance as managed by its entry", () => {
    const seed = conn({ id: "seed-1", name: "RH Google MCP", config: seedConfig });
    expect(defaultMcpConnectionRole(metadata, seed, "co-1")).toBe("forbidden");
    expect(defaultMcpConnectionRole(null, seed, "co-1")).toBe("forbidden"); // legacy agents too
    expect(isDefaultMcpManagedConnection(metadata, seed, "co-1")).toBe(false);
    // A tagged personal instance is managed by the entry whose KEY matches its tag.
    const instance = conn({ id: "pi-1", name: "RH MCP", config: personalConfig });
    expect(defaultMcpConnectionRole(metadata, instance, "co-1")).toBe("managed");
    // An instance whose tag matches NO entry key is not managed by name matching
    // (its name is a display name, never the frozen template key).
    expect(defaultMcpConnectionRole(metadata, conn({ id: "pi-2", name: "RH MCP", config: { ...personalConfig, paperclipDefaultMcpEntry: "rh-scheduler-mcp" } }), "co-1")).toBeNull();
    expect(defaultMcpConnectionRole({ defaultMcp: { entries: { google: entry({ key: "rh-google-mcp", templateKey: "rh-google-mcp" }) } } }, instance, "co-1")).toBeNull();
    // Unmarked connections keep today's behavior.
    expect(defaultMcpConnectionRole(metadata, conn({ id: "pi-1", name: "other" }), "co-1")).toBeNull();
  });

  it("isDefaultMcpSeed / isPersonalDefaultMcpInstance read only the managed markers", () => {
    expect(isDefaultMcpSeed(seedConfig)).toBe(true);
    expect(isDefaultMcpSeed({ defaultMcpManaged: "template" })).toBe(false);
    expect(isDefaultMcpSeed(personalConfig)).toBe(false);
    expect(isDefaultMcpSeed(null)).toBe(false);
    expect(isDefaultMcpSeed([seedConfig])).toBe(false);

    // The UI helper is the marker-only display classifier; the server's strict
    // six-fact instance check (tag, transport, auth, policy, identity model) is
    // covered by the server-side spec tests.
    expect(isPersonalDefaultMcpInstance(personalConfig)).toBe(true);
    expect(isPersonalDefaultMcpInstance({ ...personalConfig, defaultMcpManaged: "seed" })).toBe(false);
    expect(isPersonalDefaultMcpInstance({ defaultMcpManaged: "personal" })).toBe(true); // marker-only in the UI
    expect(isPersonalDefaultMcpInstance({ defaultMcpManaged: "template" })).toBe(false);
    expect(isPersonalDefaultMcpInstance(null)).toBe(false);
    expect(isPersonalDefaultMcpInstance([personalConfig])).toBe(false);
  });

  it("hides a not-yet-connected entry's pending ghost only behind its own VALID seed tag, not names or wrong tags", () => {
    const pending = { defaultMcp: { version: 1, entries: {
      google: entry({ key: "rh-google-mcp", templateKey: "rh-google-mcp", setup: { state: "not_required", reason: null } }),
    } } };
    const seedFor = (tag: string) => ({ config: { defaultMcpManaged: "seed", paperclipDefaultMcpEntry: tag } });

    // Without connections the legacy behavior is unchanged (the ghost is listed).
    expect(defaultMcpPendingEntries(pending)).toEqual([
      { key: "rh-google-mcp", name: "rh-google-mcp", state: "not_required", reason: null },
    ]);
    // With the matching seed the ghost is hidden: the Connect-your-account row replaces it.
    expect(defaultMcpPendingEntries(pending, [seedFor("rh-google-mcp")])).toEqual([]);
    // An arbitrary same-name manual connection, a wrong-tag seed, or a personal instance
    // does NOT hide the ghost: only the entry's own seed tag does.
    expect(defaultMcpPendingEntries(pending, [{ name: "RH Google MCP", config: {} }])).toHaveLength(1);
    expect(defaultMcpPendingEntries(pending, [seedFor("rh-mcp")])).toHaveLength(1);
    expect(defaultMcpPendingEntries(pending, [{ config: { defaultMcpManaged: "personal", paperclipDefaultMcpEntry: "rh-google-mcp" } }])).toHaveLength(1);
  });
});

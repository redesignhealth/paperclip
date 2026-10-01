import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

// Only the child-process spawn is mocked. The MCP preflight is the REAL implementation
// talking to a local JSON-RPC gateway fixture over HTTP.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Task completed\n\nsession_id: session-real-preflight",
      stderr: "",
    })),
  };
});

import { execute } from "./execute.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { startFakeGateway, stopFakeGateways } from "./test-support/fake-mcp-gateway.js";

const TOKEN = "tok-real-preflight-secret";

function makeContext(
  servers: AdapterRuntimeMcpServer[],
  logs: Array<{ stream: string; chunk: string }>,
): AdapterExecutionContext {
  return {
    runId: "run-real-preflight-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes MCP Agent",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 30, graceSec: 2, persistSession: true },
    context: { issueId: "issue-1", wakeReason: "manual" },
    runtimeMcp: { getServers: () => servers },
    authToken: "paperclip-run-auth-token",
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
    onSpawn: async () => {},
  } as unknown as AdapterExecutionContext;
}

describe("Hermes execute with the real MCP preflight", () => {
  const originalHermesHome = process.env.HERMES_HOME;
  let hostHome: string;

  beforeEach(async () => {
    vi.mocked(runChildProcess).mockClear();
    hostHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-hermes-"));
    process.env.HERMES_HOME = hostHome;
  });

  afterEach(async () => {
    await stopFakeGateways();
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermesHome;
    await fs.rm(hostHome, { recursive: true, force: true }).catch(() => {});
  });

  async function leftoverProfiles(): Promise<string[]> {
    const entries = await fs.readdir(path.join(hostHome, "profiles")).catch(() => [] as string[]);
    return entries.filter((name) => name.startsWith("paperclip-run-"));
  }

  function server(url: string, allowedTools: string[]): AdapterRuntimeMcpServer {
    return { name: "Paperclip connections", url, token: TOKEN, connectionId: "conn-1", allowedTools };
  }

  it("spawns Hermes when the gateway lists exactly the allowlisted tools", async () => {
    const gw = await startFakeGateway({ token: TOKEN, tools: ["connections_search", "connection_request"] });
    const logs: Array<{ stream: string; chunk: string }> = [];

    const result = await execute(makeContext([server(gw.url, ["connections_search", "connection_request"])], logs));

    expect(result.exitCode).toBe(0);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(gw.requests).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
    expect(logs.map((l) => l.chunk).join("")).toContain(
      "MCP preflight ok: 'paperclip_connections' lists exactly 2 allowlisted tool(s).",
    );
    expect(await leftoverProfiles()).toEqual([]);
  });

  it("aborts before spawn and cleans the temp home when the gateway exposes an extra tool", async () => {
    const gw = await startFakeGateway({ token: TOKEN, tools: ["connections_search", "connection_request", "shell_exec"] });
    const logs: Array<{ stream: string; chunk: string }> = [];

    await expect(
      execute(makeContext([server(gw.url, ["connections_search", "connection_request"])], logs)),
    ).rejects.toThrow(/run aborted before model execution: .*outside the allowlist: shell_exec/);

    expect(runChildProcess).not.toHaveBeenCalled();
    expect(await leftoverProfiles()).toEqual([]);
    const everything = logs.map((l) => l.chunk).join("");
    expect(everything).toContain("MCP preflight failed");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(gw.url);
  });

  it("aborts before spawn when an allowlisted tool is missing", async () => {
    const gw = await startFakeGateway({ token: TOKEN, tools: ["connections_search"] });
    const logs: Array<{ stream: string; chunk: string }> = [];

    await expect(
      execute(makeContext([server(gw.url, ["connections_search", "connection_request"])], logs)),
    ).rejects.toThrow(/does not list 1 allowlisted tool\(s\): connection_request/);

    expect(runChildProcess).not.toHaveBeenCalled();
    expect(await leftoverProfiles()).toEqual([]);
  });

  it("aborts before spawn when the gateway rejects the run token, without leaking credentials", async () => {
    const gw = await startFakeGateway({ token: "some-other-token", tools: ["connections_search"] });
    const logs: Array<{ stream: string; chunk: string }> = [];

    await expect(execute(makeContext([server(`${gw.url}?api_key=url-secret`, ["connections_search"])], logs))).rejects.toThrow(
      /rejected the run credential \(HTTP 401\)/,
    );

    expect(runChildProcess).not.toHaveBeenCalled();
    const everything = logs.map((l) => l.chunk).join("");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("url-secret");
    expect(await leftoverProfiles()).toEqual([]);
  });
});

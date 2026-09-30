import fs from "node:fs/promises";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

let interceptedOpts: {
  command?: string;
  args?: string[];
  opts?: Record<string, unknown>;
  tempHomeAtExecution?: string | null;
  tempHomeExistsAtExecution?: boolean;
} = {};

let mockChildProcessBehavior: "success" | "failure" | "timeout" | "throw" = "success";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (runId: string, cmd: string, args: string[], opts: any) => {
      interceptedOpts = {
        command: cmd,
        args,
        opts,
        tempHomeAtExecution: opts.env?.HERMES_HOME ?? null,
        tempHomeExistsAtExecution: opts.env?.HERMES_HOME
          ? await fs.access(opts.env.HERMES_HOME).then(() => true).catch(() => false)
          : false,
      };

      if (mockChildProcessBehavior === "throw") {
        throw new Error("Simulated child process spawn failure");
      }

      if (mockChildProcessBehavior === "timeout") {
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          stdout: "",
          stderr: "",
        };
      }

      if (mockChildProcessBehavior === "failure") {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "Hermes fatal error: connection failed",
        };
      }

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Task completed\n\nsession_id: session-12345",
        stderr: "",
      };
    }),
  };
});

import { execute } from "./execute.js";

function makeContext(options: {
  servers?: AdapterRuntimeMcpServer[];
  sessionId?: string | null;
  persistSession?: boolean;
}): AdapterExecutionContext {
  const logs: Array<{ stream: string; chunk: string }> = [];
  return {
    runId: "run-mcp-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes MCP Agent",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: options.sessionId ?? null,
      sessionParams: options.sessionId ? { sessionId: options.sessionId } : null,
      sessionDisplayId: options.sessionId ?? null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 30,
      graceSec: 2,
      persistSession: options.persistSession ?? true,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
    },
    runtimeMcp: options.servers
      ? {
          getServers: () => options.servers!,
        }
      : undefined,
    authToken: "paperclip-run-auth-token",
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
    onSpawn: async () => {},
  } as unknown as AdapterExecutionContext;
}

describe("Hermes MCP execute integration", () => {
  const originalHermesHome = process.env.HERMES_HOME;

  beforeEach(() => {
    interceptedOpts = {};
    mockChildProcessBehavior = "success";
  });

  afterEach(() => {
    if (originalHermesHome === undefined) {
      delete process.env.HERMES_HOME;
    } else {
      process.env.HERMES_HOME = originalHermesHome;
    }
  });

  it("propagates HERMES_HOME to child process only, without mutating process.env.HERMES_HOME", async () => {
    process.env.HERMES_HOME = "/host/hermes/home";

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "Paperclip connections",
        url: "http://localhost:3100/mcp/runtime-tools",
        token: "tok-connections",
        connectionId: "paperclip-runtime-tools",
        allowedTools: ["connections_search", "connection_request"],
      },
    ];

    const ctx = makeContext({ servers });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);

    // Check that during execution, child process received temp HERMES_HOME and the directory existed
    expect(interceptedOpts.tempHomeAtExecution).toBeTruthy();
    expect(interceptedOpts.tempHomeAtExecution).not.toBe("/host/hermes/home");
    expect(interceptedOpts.tempHomeExistsAtExecution).toBe(true);

    // Check that process.env.HERMES_HOME was NOT modified
    expect(process.env.HERMES_HOME).toBe("/host/hermes/home");

    // Check that child process environment received token env var
    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    expect(childEnv.HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS).toBe("tok-connections");

    // Check that temp directory was cleaned up after execution in finally
    await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("suppresses --resume when using isolated HERMES_HOME and does not persist sessionParams", async () => {
    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "paperclip-assigned",
        url: "http://localhost:3100/mcp/gateways/gw_1",
        token: "tok-assigned",
        connectionId: "conn-1",
        allowedTools: ["tool_a"],
      },
    ];

    const ctx = makeContext({ servers, sessionId: "prior-session-id" });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);

    // Assert --resume was NOT added to child process args
    expect(interceptedOpts.args).not.toContain("--resume");
    expect(interceptedOpts.args).not.toContain("prior-session-id");

    // Assert sessionParams was NOT stored for the next run (since temp state is discarded)
    expect(result.sessionParams).toBeUndefined();
  });

  it("preserves normal --resume and sessionParams when NO MCP servers are present (no-MCP behavior)", async () => {
    const ctx = makeContext({ servers: [], sessionId: "prior-session-id" });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);

    // Assert --resume WAS added to child process args
    expect(interceptedOpts.args).toContain("--resume");
    expect(interceptedOpts.args).toContain("prior-session-id");

    // Assert HERMES_HOME was NOT set
    expect(interceptedOpts.tempHomeAtExecution).toBeNull();

    // Assert sessionParams WAS stored
    expect(result.sessionParams).toEqual({ sessionId: "session-12345" });
  });

  it("cleans up isolated HERMES_HOME on child process non-zero exit", async () => {
    mockChildProcessBehavior = "failure";

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "test-server",
        url: "http://localhost:3100/mcp",
        token: "tok-1",
        connectionId: "c1",
        allowedTools: ["tool_a"],
      },
    ];

    const ctx = makeContext({ servers });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Hermes fatal error: connection failed");

    // Temp directory existed during child run
    expect(interceptedOpts.tempHomeAtExecution).toBeTruthy();
    expect(interceptedOpts.tempHomeExistsAtExecution).toBe(true);

    // Temp directory was cleaned up in finally
    await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cleans up isolated HERMES_HOME on child process timeout", async () => {
    mockChildProcessBehavior = "timeout";

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "test-server",
        url: "http://localhost:3100/mcp",
        token: "tok-1",
        connectionId: "c1",
        allowedTools: ["tool_a"],
      },
    ];

    const ctx = makeContext({ servers });
    const result = await execute(ctx);

    expect(result.timedOut).toBe(true);

    // Temp directory was cleaned up in finally
    await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cleans up isolated HERMES_HOME when runChildProcess throws an exception", async () => {
    mockChildProcessBehavior = "throw";

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "test-server",
        url: "http://localhost:3100/mcp",
        token: "tok-1",
        connectionId: "c1",
        allowedTools: ["tool_a"],
      },
    ];

    const ctx = makeContext({ servers });
    await expect(execute(ctx)).rejects.toThrow("Simulated child process spawn failure");

    // Temp directory was cleaned up in finally
    await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

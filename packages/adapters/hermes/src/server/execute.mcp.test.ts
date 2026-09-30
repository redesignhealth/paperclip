import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-hermes-"));
    process.env.HERMES_HOME = mockHome;

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
    expect(interceptedOpts.tempHomeAtExecution).not.toBe(mockHome);
    expect(interceptedOpts.tempHomeExistsAtExecution).toBe(true);

    // Check that process.env.HERMES_HOME was NOT modified
    expect(process.env.HERMES_HOME).toBe(mockHome);

    // Check that child process environment received token env var
    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    expect(childEnv.HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS).toBe("tok-connections");

    // Check that temp directory was cleaned up after execution in finally
    await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await fs.rm(mockHome, { recursive: true, force: true }).catch(() => {});
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
    expect(result.clearSession).toBe(true);
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
    expect(result.clearSession).toBeUndefined();
  });

  it("removes duplicate PAPERCLIP_RUNTIME_TOOLS_* env token channel while naturally including guidance in prompt", async () => {
    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "paperclip-assigned",
        url: "http://localhost:3100/mcp/gateways/gw_1",
        token: "tok-assigned",
        connectionId: "conn-1",
        allowedTools: ["tool_a"],
      },
    ];

    const ctx = makeContext({ servers });
    (ctx as any).runtimeTools = {
      version: 1,
      guidance: "Use native MCP tools for search and actions.",
      mcpEndpoint: "http://localhost:3100/api/mcp/runtime-tools",
      rest: {
        connectionsSearch: "http://localhost:3100/api/connections/search",
        connectionRequest: "http://localhost:3100/api/connections/request",
      },
      bearerToken: "leaked-runtime-token",
      tools: ["connections_search"],
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    // Ensure no PAPERCLIP_RUNTIME_TOOLS_* env variables reached the child
    expect(childEnv.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBeUndefined();
    expect(childEnv.PAPERCLIP_RUNTIME_TOOLS_ENDPOINT).toBeUndefined();
    expect(childEnv.PAPERCLIP_RUNTIME_TOOLS_REST_CONNECTIONS_SEARCH).toBeUndefined();
    for (const key of Object.keys(childEnv)) {
      expect(key.startsWith("PAPERCLIP_RUNTIME_TOOLS_")).toBe(false);
    }

    // Verify non-secret guidance was incorporated into the prompt
    expect(interceptedOpts.args?.join(" ")).toContain("Use native MCP tools for search and actions.");
  });

  it("injects allowlisted provider env from host .env directly into child process without copying to temp .env", async () => {
    const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-exec-test-"));
    const hostHermes = path.join(mockHome, ".hermes");
    await fs.mkdir(hostHermes, { recursive: true });
    await fs.writeFile(
      path.join(hostHermes, ".env"),
      "ANTHROPIC_API_KEY=sk-ant-exec-secret\nFORBIDDEN_SECRET=unsafe-leak\n",
    );

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "test-server",
        url: "http://localhost:3100/mcp",
        token: "tok-1",
        connectionId: "c1",
        allowedTools: ["tool_a"],
      },
    ];

    let tempDotenvContent = "";
    const ctx = makeContext({ servers });
    (ctx.config as any).env = { HOME: mockHome };

    const utils = await import("@paperclipai/adapter-utils/server-utils");
    const prevRunChild = utils.runChildProcess as any;
    prevRunChild.mockImplementationOnce(async (runId: string, cmd: string, args: string[], opts: any) => {
      interceptedOpts = {
        command: cmd,
        args,
        opts,
        tempHomeAtExecution: opts.env?.HERMES_HOME ?? null,
      };
      if (opts.env?.HERMES_HOME) {
        tempDotenvContent = await fs.readFile(path.join(opts.env.HERMES_HOME, ".env"), "utf8");
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n\nsession_id: s1", stderr: "" };
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    // Allowlisted provider key is injected into child process env
    expect(childEnv.ANTHROPIC_API_KEY).toBe("sk-ant-exec-secret");
    // Non-allowlisted key is NOT injected
    expect(childEnv.FORBIDDEN_SECRET).toBeUndefined();

    // Temp .env contains ONLY run MCP tokens, NEVER provider secrets
    expect(tempDotenvContent).toContain("HERMES_MCP_TOKEN_TEST_SERVER");
    expect(tempDotenvContent).not.toContain("ANTHROPIC_API_KEY");
    expect(tempDotenvContent).not.toContain("sk-ant-exec-secret");

    await fs.rm(mockHome, { recursive: true, force: true }).catch(() => {});
  });

  it("treats provider env inheritance as fallback-only so explicit config env overrides host .env", async () => {
    const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fallback-test-"));
    const hostHermes = path.join(mockHome, ".hermes");
    await fs.mkdir(hostHermes, { recursive: true });
    await fs.writeFile(
      path.join(hostHermes, ".env"),
      "OPENAI_API_KEY=host-fallback-key\nANTHROPIC_API_KEY=host-anthropic-key\n",
    );

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
    (ctx.config as any).env = {
      HOME: mockHome,
      OPENAI_API_KEY: "explicit-config-key",
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    // Explicit config env wins over host .env
    expect(childEnv.OPENAI_API_KEY).toBe("explicit-config-key");
    // Non-conflicting host key is inherited as fallback
    expect(childEnv.ANTHROPIC_API_KEY).toBe("host-anthropic-key");

    await fs.rm(mockHome, { recursive: true, force: true }).catch(() => {});
  });

  it("wires redacted cleanup warnings to ctx.onLog on cleanup failure", async () => {
    const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-warn-test-"));
    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "test-server",
        url: "http://localhost:3100/mcp",
        token: "tok-1",
        connectionId: "c1",
        allowedTools: ["tool_a"],
      },
    ];

    const logs: Array<{ stream: string; chunk: string }> = [];
    const ctx = makeContext({ servers });
    (ctx.config as any).env = { HOME: mockHome };
    ctx.onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    };

    let cleanedDir: string | null = null;
    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (targetPath, opts) => {
      if (typeof targetPath === "string" && targetPath.includes("paperclip-run-")) {
        cleanedDir = targetPath;
        throw new Error("Simulated EBUSY locking error");
      }
      return originalRm(targetPath, opts);
    });

    try {
      await execute(ctx);

      const warningLog = logs.find((l) => l.chunk.includes("[hermes] Warning:"));
      expect(warningLog).toBeDefined();
      expect(warningLog!.chunk).toContain("Temporary Hermes home cleanup encountered an error");
      // Must not leak file paths or exception text
      expect(warningLog!.chunk).not.toContain(mockHome);
      expect(warningLog!.chunk).not.toContain("EBUSY");
    } finally {
      rmSpy.mockRestore();
      if (cleanedDir) {
        await originalRm(cleanedDir, { recursive: true, force: true }).catch(() => {});
      }
      await fs.rm(mockHome, { recursive: true, force: true }).catch(() => {});
    }
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

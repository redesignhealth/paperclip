import fs from "node:fs/promises";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type {
  AdapterExecutionContext,
  AdapterMem0PgvectorRuntimeMemoryConfig,
  AdapterRuntimeMcpServer,
  AdapterRuntimeMemoryAccess,
} from "@paperclipai/adapter-utils";

let interceptedOpts: {
  command?: string;
  args?: string[];
  opts?: Record<string, unknown>;
  tempHomeAtExecution?: string | null;
  tempHomeExistsAtExecution?: boolean;
  mem0JsonExistedAtExecution?: boolean;
} = {};

let mockChildProcessBehavior: "success" | "failure" | "timeout" | "throw" | "emit_secrets" | "emit_chunks" | "real_spawn" = "success";
let customStdout = "";
let customStderr = "";
let customChunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
let runChildProcessCallCount = 0;
let existsSyncMockHandler: ((targetPath: unknown) => boolean) | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (targetPath: unknown) => {
      if (existsSyncMockHandler) {
        return existsSyncMockHandler(targetPath);
      }
      return actual.existsSync(targetPath as any);
    },
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (runId: string, cmd: string, args: string[], opts: any) => {
      runChildProcessCallCount++;

      if (mockChildProcessBehavior === "real_spawn") {
        return actual.runChildProcess(runId, cmd, args, opts);
      }

      const tempHome = opts.env?.HERMES_HOME ?? null;
      let tempHomeExists = false;
      let mem0JsonExists = false;

      if (tempHome) {
        tempHomeExists = await fs.access(tempHome).then(() => true).catch(() => false);
        const mem0Path = path.join(tempHome, "mem0.json");
        mem0JsonExists = await fs.access(mem0Path).then(() => true).catch(() => false);

        // Simulate mem0 creating a local history SQLite file inside HERMES_HOME
        try {
          await fs.writeFile(path.join(tempHome, "history.db"), "SQLite format 3\0dummy data");
        } catch {
          // ignore
        }
      }

      interceptedOpts = {
        command: cmd,
        args,
        opts,
        tempHomeAtExecution: tempHome,
        tempHomeExistsAtExecution: tempHomeExists,
        mem0JsonExistedAtExecution: mem0JsonExists,
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
          stderr: customStderr || "Hermes fatal error: memory connection failed",
        };
      }

      if (mockChildProcessBehavior === "emit_secrets") {
        if (opts.onLog) {
          await opts.onLog("stdout", customStdout);
          await opts.onLog("stderr", customStderr);
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: customStdout,
          stderr: customStderr,
        };
      }

      if (mockChildProcessBehavior === "emit_chunks") {
        let combinedStdout = "";
        let combinedStderr = "";
        for (const item of customChunks) {
          if (item.stream === "stdout") combinedStdout += item.chunk;
          if (item.stream === "stderr") combinedStderr += item.chunk;
          if (opts.onLog) {
            await opts.onLog(item.stream, item.chunk);
          }
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: combinedStdout,
          stderr: combinedStderr,
        };
      }

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Task completed successfully\n\nsession_id: mem-session-999",
        stderr: "",
      };
    }),
  };
});

import {
  execute,
  checkHermesMemoryCapability,
  isBenignStderrLog,
  augmentStaleImageError,
  HERMES_PRODUCTION_CLOSURE_SENTINEL,
  HERMES_MEMORY_REQUIRED_MODULES,
  HERMES_MEMORY_PYTHON_IMPORT_CHECK,
  resolveOptHermesPath,
  isPaperclipProductionContainer,
} from "./execute.js";
import { MAX_CONFIG_STRING_LENGTH } from "./memory-config.js";

const REALISTIC_SECRET_PASSWORD = "VerySecret_Tenant_DB_Password_77#*!";
const REALISTIC_HOST = "pg-tenant-42.internal.paperclip.io";
const REALISTIC_USER = "tenant_role_42";
const REALISTIC_DB = "tenant_database_42";
const REALISTIC_COLLECTION = "mem0_agent_collection";

let testHermesHome: string;

function createValidMemoryConfig(): AdapterMem0PgvectorRuntimeMemoryConfig {
  return {
    provider: "mem0",
    mode: "oss",
    userId: "company",
    agentId: "agent-mem-test-uuid",
    llm: {
      provider: "openai",
      config: {
        model: "gpt-5.4-mini",
        api_key: "sk-openai-key-secret-9999",
      },
    },
    embedder: {
      provider: "openai",
      config: {
        model: "text-embedding-3-small",
      },
    },
    vectorStore: {
      provider: "pgvector",
      config: {
        host: REALISTIC_HOST,
        port: 5432,
        user: REALISTIC_USER,
        password: REALISTIC_SECRET_PASSWORD,
        dbname: REALISTIC_DB,
        sslmode: "require",
        collectionName: REALISTIC_COLLECTION,
      },
    },
  };
}

function makeContext(options: {
  memoryConfig?: unknown;
  runtimeMemoryAccessor?: AdapterRuntimeMemoryAccess;
  servers?: AdapterRuntimeMcpServer[];
  sessionId?: string | null;
  persistSession?: boolean;
  extraEnv?: Record<string, string>;
  extraArgs?: string[];
  command?: string;
  onLogCollector?: Array<{ stream: string; chunk: string }>;
  onMeta?: (meta: any) => Promise<void>;
}): AdapterExecutionContext {
  const logs = options.onLogCollector ?? [];
  const memoryAccess: AdapterRuntimeMemoryAccess | undefined =
    options.runtimeMemoryAccessor ??
    (options.memoryConfig !== undefined
      ? {
          getConfig: async () => options.memoryConfig as AdapterMem0PgvectorRuntimeMemoryConfig,
        }
      : undefined);

  return {
    runId: "run-memory-test-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes Memory Agent",
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
      command: options.command ?? "/usr/bin/hermes",
      timeoutSec: 30,
      graceSec: 2,
      persistSession: options.persistSession ?? true,
      extraArgs: options.extraArgs,
      env: {
        HERMES_HOME: testHermesHome,
        ...options.extraEnv,
      },
    },
    context: {
      issueId: "issue-memory-1",
      wakeReason: "manual",
    },
    runtimeMemory: memoryAccess,
    runtimeMcp: options.servers
      ? {
          getServers: () => options.servers!,
        }
      : undefined,
    authToken: "paperclip-run-auth-token",
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
    onMeta: options.onMeta,
    onSpawn: async () => {},
  } as unknown as AdapterExecutionContext;
}

describe("Hermes Runtime Memory execution integration", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    interceptedOpts = {};
    mockChildProcessBehavior = "success";
    customStdout = "";
    customStderr = "";
    customChunks = [];
    runChildProcessCallCount = 0;

    testHermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-test-hermes-root-"));
    process.env.HERMES_HOME = testHermesHome;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (testHermesHome) {
      await fs.rm(testHermesHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("activates isolated HERMES_HOME beneath test-owned root and sets MEM0_TELEMETRY='False'", async () => {
    const memory = createValidMemoryConfig();
    const ctx = makeContext({ memoryConfig: memory });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    // Verify child execution parameters
    expect(interceptedOpts.tempHomeAtExecution).toBeTruthy();
    expect(interceptedOpts.tempHomeAtExecution?.startsWith(testHermesHome)).toBe(true);
    expect(interceptedOpts.tempHomeExistsAtExecution).toBe(true);
    expect(interceptedOpts.mem0JsonExistedAtExecution).toBe(true);

    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    expect(childEnv.HERMES_HOME).toBe(interceptedOpts.tempHomeAtExecution);
    expect(childEnv.MEM0_TELEMETRY).toBe("False");

    // Verify database credentials are NOT in child env
    expect(childEnv.PGPASSWORD).toBeUndefined();
    expect(childEnv.password).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain(REALISTIC_SECRET_PASSWORD);

    // Verify temp home directory (and history.db) was cleaned up after run settles
    await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("strips ambient libpq PG* variables using unsetEnvKeys before child spawn", async () => {
    process.env.PGHOST = "host-ambient.com";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "user_ambient";
    process.env.PGPASSWORD = "password_ambient";
    process.env.PGDATABASE = "db_ambient";
    process.env.PGSERVICE = "service_ambient";
    process.env.PGSERVICEFILE = "/tmp/servicefile";
    process.env.PGPASSFILE = "/tmp/passfile";

    const memory = createValidMemoryConfig();
    const ctx = makeContext({
      memoryConfig: memory,
      extraEnv: {
        PGPASSWORD: "user_config_password",
      },
    });

    await execute(ctx);

    const unsetKeys = (interceptedOpts.opts as any)?.unsetEnvKeys as readonly string[];
    expect(unsetKeys).toContain("PGHOST");
    expect(unsetKeys).toContain("PGPASSWORD");
    expect(unsetKeys).toContain("PGDATABASE");
    expect(unsetKeys).toContain("PGUSER");

    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    expect(childEnv.PGHOST).toBeUndefined();
    expect(childEnv.PGPORT).toBeUndefined();
    expect(childEnv.PGUSER).toBeUndefined();
    expect(childEnv.PGPASSWORD).toBeUndefined();
    expect(childEnv.PGDATABASE).toBeUndefined();
    expect(childEnv.PGSERVICE).toBeUndefined();
    expect(childEnv.PGSERVICEFILE).toBeUndefined();
    expect(childEnv.PGPASSFILE).toBeUndefined();
  });

  it("verifies via real spawned child process that ambient forbidden env vars do not reach child on memory runs", async () => {
    mockChildProcessBehavior = "real_spawn";
    process.env.PGHOST = "ambient-real-spawn-host.internal";
    process.env.PGPASSWORD = "ambient-real-spawn-password";
    process.env.DATABASE_URL = "postgres://leak:leak@control-plane/db";
    process.env.PAPERCLIP_MEMORY_ADMIN_DATABASE_URL = "postgres://admin:leak@rds/postgres";

    // Create a real executable mock hermes script that dumps process.env
    const scriptPath = path.join(testHermesHome, "mock-hermes.sh");
    const scriptContent = `#!/bin/sh
node -e "process.stdout.write(JSON.stringify({ pghost: process.env.PGHOST, pgpass: process.env.PGPASSWORD, dburl: process.env.DATABASE_URL, adminurl: process.env.PAPERCLIP_MEMORY_ADMIN_DATABASE_URL })); process.stdout.write('\\nsession_id: real-session-1\\n');"
`;
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });
    await fs.chmod(scriptPath, 0o755);

    const logs: Array<{ stream: string; chunk: string }> = [];
    const memory = createValidMemoryConfig();
    const ctx = makeContext({
      memoryConfig: memory,
      command: scriptPath,
      onLogCollector: logs,
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const childOutput = logs
      .filter((l) => l.stream === "stdout")
      .map((l) => l.chunk)
      .join("");
    expect(childOutput).not.toContain("ambient-real-spawn-host.internal");
    expect(childOutput).not.toContain("ambient-real-spawn-password");
    expect(childOutput).not.toContain("postgres://leak:leak@control-plane/db");
    expect(childOutput).not.toContain("postgres://admin:leak@rds/postgres");
  }, 15_000);

  it("verifies via real spawned child process that ambient forbidden env vars do not reach child on NO-MEMORY runs", async () => {
    mockChildProcessBehavior = "real_spawn";
    process.env.PGHOST = "ambient-no-memory-host.internal";
    process.env.PGPASSWORD = "ambient-no-memory-password";
    process.env.DATABASE_URL = "postgres://control-plane-leak/db";
    process.env.PAPERCLIP_MEMORY_ADMIN_DATABASE_URL = "postgres://admin-leak/postgres";

    const scriptPath = path.join(testHermesHome, "mock-hermes-no-mem.sh");
    const scriptContent = `#!/bin/sh
node -e "process.stdout.write(JSON.stringify({ pghost: process.env.PGHOST, pgpass: process.env.PGPASSWORD, dburl: process.env.DATABASE_URL, adminurl: process.env.PAPERCLIP_MEMORY_ADMIN_DATABASE_URL })); process.stdout.write('\\nsession_id: real-session-2\\n');"
`;
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });
    await fs.chmod(scriptPath, 0o755);

    const logs: Array<{ stream: string; chunk: string }> = [];
    const ctx = makeContext({
      command: scriptPath,
      onLogCollector: logs,
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const childOutput = logs
      .filter((l) => l.stream === "stdout")
      .map((l) => l.chunk)
      .join("");
    expect(childOutput).not.toContain("ambient-no-memory-host.internal");
    expect(childOutput).not.toContain("ambient-no-memory-password");
    expect(childOutput).not.toContain("postgres://control-plane-leak/db");
    expect(childOutput).not.toContain("postgres://admin-leak/postgres");
  }, 15_000);

  it("suppresses --resume and sets clearSession: true on memory runs", async () => {
    const memory = createValidMemoryConfig();
    const ctx = makeContext({ memoryConfig: memory, sessionId: "prior-session-uuid" });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    // Verify --resume was NOT added
    expect(interceptedOpts.args).not.toContain("--resume");
    expect(interceptedOpts.args).not.toContain("prior-session-uuid");

    // Verify clearSession is true and sessionParams is undefined
    expect(result.clearSession).toBe(true);
    expect(result.sessionParams).toBeUndefined();
  });

  it("redacts sensitive memory database values from onLog, summary, errorMessage, and resultJson", async () => {
    mockChildProcessBehavior = "emit_secrets";
    customStdout = `Connecting to postgresql://${REALISTIC_USER}:${REALISTIC_SECRET_PASSWORD}@${REALISTIC_HOST}:5432/${REALISTIC_DB} table=${REALISTIC_COLLECTION}\nMemory initialized\n`;
    customStderr = `Error on ${REALISTIC_HOST}: authentication with user ${REALISTIC_USER} and password ${REALISTIC_SECRET_PASSWORD} failed on collection ${REALISTIC_COLLECTION}\n`;

    const logs: Array<{ stream: string; chunk: string }> = [];
    const memory = createValidMemoryConfig();
    const ctx = makeContext({ memoryConfig: memory, onLogCollector: logs });

    const result = await execute(ctx);

    // Negative assertion: the secret password MUST NOT appear in logs
    const allLogText = logs.map((l) => l.chunk).join("\n");
    expect(allLogText).not.toContain(REALISTIC_SECRET_PASSWORD);
    expect(allLogText).toContain("***REDACTED***");

    // Positive assertion: non-secret database identifiers are preserved without broad substring corruption
    expect(allLogText).toContain(REALISTIC_HOST);
    expect(allLogText).toContain(REALISTIC_USER);
    expect(allLogText).toContain(REALISTIC_DB);
    expect(allLogText).toContain(REALISTIC_COLLECTION);

    // Check executionResult summary
    expect(result.summary).not.toContain(REALISTIC_SECRET_PASSWORD);
    expect(result.summary).toContain("***REDACTED***");

    // Check executionResult resultJson
    const resultJsonStr = JSON.stringify(result.resultJson);
    expect(resultJsonStr).not.toContain(REALISTIC_SECRET_PASSWORD);

    // Check executionResult errorMessage
    if (result.errorMessage) {
      expect(result.errorMessage).not.toContain(REALISTIC_SECRET_PASSWORD);
    }
  });

  it("redacts secrets split across multiple streaming chunks", async () => {
    mockChildProcessBehavior = "emit_chunks";

    // Split the secret across 3 chunks
    // REALISTIC_SECRET_PASSWORD = "VerySecret_Tenant_DB_Password_77#*!" (length 35)
    // Part 1: "VerySecret_" (11)
    // Part 2: "Tenant_DB_" (10)
    // Part 3: "Password_77#*!" (14)
    customChunks = [
      { stream: "stdout", chunk: "Starting connection with password: VerySecret_" },
      { stream: "stdout", chunk: "Tenant_DB_" },
      { stream: "stdout", chunk: "Password_77#*! ... done\n" },
    ];

    const logs: Array<{ stream: string; chunk: string }> = [];
    const memory = createValidMemoryConfig();
    const ctx = makeContext({ memoryConfig: memory, onLogCollector: logs });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const emittedLogs = logs.map((l) => l.chunk).join("");
    // Crucial check: the raw secret and its split components must NOT form the complete secret in emitted logs
    expect(emittedLogs).not.toContain(REALISTIC_SECRET_PASSWORD);
    expect(emittedLogs).toContain("***REDACTED***");
    expect(emittedLogs).toContain("Starting connection with password: ***REDACTED*** ... done");
  });

  it("protects real database password secrets without broad substring replacement of user/dbname/collectionName", async () => {
    mockChildProcessBehavior = "emit_secrets";
    const secretPass = "super_secret_pg_pass_9999";
    const shortUser = "u1";
    const shortDb = "db";
    const shortColl = "c1";

    customStdout = `DB connected: user=${shortUser} db=${shortDb} coll=${shortColl} pass=${secretPass}\n`;
    customStderr = `Error for ${shortUser} on ${shortDb} with ${secretPass}\n`;

    const logs: Array<{ stream: string; chunk: string }> = [];
    const memory: AdapterMem0PgvectorRuntimeMemoryConfig = {
      provider: "mem0",
      mode: "oss",
      userId: "company",
      agentId: "agent-1",
      llm: { provider: "openai", config: { model: "gpt-5.4" } },
      embedder: { provider: "openai", config: { model: "text-embed" } },
      vectorStore: {
        provider: "pgvector",
        config: {
          host: "db.internal.net",
          port: 5432,
          user: shortUser,
          password: secretPass,
          dbname: shortDb,
          sslmode: "require",
          collectionName: shortColl,
        },
      },
    };

    const ctx = makeContext({ memoryConfig: memory, onLogCollector: logs });
    const result = await execute(ctx);

    const allLogs = logs.map((l) => l.chunk).join("");
    // Non-secret database identifiers must NOT be redacted (avoids broad substring replacement corruption)
    expect(allLogs).toContain(`user=${shortUser}`);
    expect(allLogs).toContain(`db=${shortDb}`);
    expect(allLogs).toContain(`coll=${shortColl}`);

    // Real secret password MUST be redacted
    expect(allLogs).not.toContain(secretPass);
    expect(allLogs).toContain("***REDACTED***");

    expect(result.summary).not.toContain(secretPass);
    expect(JSON.stringify(result.resultJson)).not.toContain(secretPass);
  });

  it("redacts short MCP tokens without corrupting word boundaries or output token counters", async () => {
    mockChildProcessBehavior = "emit_secrets";
    // Short 3-character token "tok"
    const shortToken = "tok";
    customStdout = `Using token: ${shortToken} for MCP server.\nTokens: 1500 input, 250 output.\n`;
    customStderr = `HERMES_MCP_TOKEN_SRV="${shortToken}" initialized successfully\n`;

    const logs: Array<{ stream: string; chunk: string }> = [];
    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "test-srv",
        url: "http://localhost:3100/mcp",
        token: shortToken,
        allowedTools: ["test_tool"],
        connectionId: "conn-test-srv",
      },
    ];
    const ctx = makeContext({ servers, onLogCollector: logs });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const allLogText = logs.map((l) => l.chunk).join("");
    // Short token must be redacted where exact value occurs
    expect(allLogText).toContain("Using token: ***REDACTED*** for MCP server.");
    expect(allLogText).toContain('HERMES_MCP_TOKEN_SRV="***REDACTED***"');

    // But words containing "tok" such as "Tokens" must NOT be corrupted
    expect(allLogText).toContain("Tokens: 1500 input, 250 output.");
    expect(allLogText).not.toContain("***REDACTED***ens");

    // Token usage parsing must succeed
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(1500);
    expect(result.usage?.outputTokens).toBe(250);
  });

  it("classifies raw stderr before redaction so numeric credentials in timestamps are routed to stdout", async () => {
    mockChildProcessBehavior = "emit_chunks";
    // Credential is "789"
    const numericSecret = "789";
    customChunks = [
      {
        stream: "stderr",
        chunk: `2026-10-01 12:34:56,${numericSecret} - mem0 - INFO - Initializing mem0 with token\n`,
      },
    ];

    const logs: Array<{ stream: string; chunk: string }> = [];
    const memory: AdapterMem0PgvectorRuntimeMemoryConfig = {
      provider: "mem0",
      mode: "oss",
      userId: "company",
      agentId: "agent-1",
      llm: {
        provider: "openai",
        config: {
          model: "gpt-5.4",
          api_key: numericSecret,
        },
      },
      embedder: { provider: "openai", config: { model: "text-embed" } },
      vectorStore: {
        provider: "pgvector",
        config: {
          host: "db.internal.net",
          port: 5432,
          user: "db_user",
          password: "db_password_1234",
          dbname: "db_name",
          sslmode: "require",
          collectionName: "col_name",
        },
      },
    };
    const ctx = makeContext({ memoryConfig: memory, onLogCollector: logs });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    // Finding 1 fix: raw chunk was classified with isBenignStderrLog BEFORE redaction,
    // so the valid timestamp regex matched and the line was routed to stdout instead of stderr.
    const stdoutLogs = logs.filter((l) => l.stream === "stdout").map((l) => l.chunk);
    const stderrLogs = logs.filter((l) => l.stream === "stderr").map((l) => l.chunk);

    expect(stdoutLogs.some((c) => c.includes("Initializing mem0 with token"))).toBe(true);
    expect(stderrLogs.some((c) => c.includes("Initializing mem0 with token"))).toBe(false);

    // Displayed/stored text MUST be redacted
    const allEmitted = logs.map((l) => l.chunk).join("");
    expect(allEmitted).not.toContain(numericSecret);
    expect(allEmitted).toContain("2026-10-01 12:34:56,***REDACTED*** - mem0 - INFO - Initializing mem0 with token");
  });

  it("fails closed before spawn if collected credentials contain unredactable degenerate values", async () => {
    const memory = createValidMemoryConfig();
    const badServers: AdapterRuntimeMcpServer[] = [
      {
        name: "bad-srv",
        url: "http://localhost:3100/mcp",
        token: "***",
        allowedTools: ["test_tool"],
        connectionId: "conn-bad",
      },
    ];
    const logs: Array<{ stream: string; chunk: string }> = [];
    const ctx = makeContext({ memoryConfig: memory, servers: badServers, onLogCollector: logs });
    await expect(execute(ctx)).rejects.toThrow("Cannot safely redact sensitive credential");
    expect(logs.some((l) => l.stream === "stderr" && l.chunk.includes("Cannot safely redact sensitive credential"))).toBe(true);
    // Ensure raw credential value is never leaked in log output
    expect(logs.some((l) => l.chunk.includes("***"))).toBe(false);
  });

  it("fails closed before spawn if MCP server token exceeds MAX_CONFIG_STRING_LENGTH", async () => {
    const memory = createValidMemoryConfig();
    const oversizedToken = "t".repeat(MAX_CONFIG_STRING_LENGTH + 1);
    const badServers: AdapterRuntimeMcpServer[] = [
      {
        name: "oversized-token-srv",
        url: "http://localhost:3100/mcp",
        token: oversizedToken,
        allowedTools: ["test_tool"],
        connectionId: "conn-oversized",
      },
    ];
    const logs: Array<{ stream: string; chunk: string }> = [];
    const ctx = makeContext({ memoryConfig: memory, servers: badServers, onLogCollector: logs });
    await expect(execute(ctx)).rejects.toThrow("exceeds maximum allowed length");
    expect(logs.some((l) => l.stream === "stderr" && l.chunk.includes("exceeds maximum allowed length"))).toBe(true);
    // Ensure raw credential value is never leaked in log output
    expect(logs.some((l) => l.chunk.includes(oversizedToken))).toBe(false);
  });

  it("fails closed before spawn with generic error if runtime memory config is malformed or invalid", async () => {
    const logs: Array<{ stream: string; chunk: string }> = [];
    // Missing required pgvector collectionName / split fields
    const invalidConfig = {
      provider: "mem0",
      mode: "oss",
      userId: "company",
      agentId: "agent-1",
      llm: { provider: "openai", config: { model: "gpt-5.4" } },
      embedder: { provider: "openai", config: { model: "text-embed" } },
      vectorStore: {
        provider: "pgvector",
        config: {
          connection_string: "postgresql://bad:pass@host/db", // forbidden!
        },
      },
    };

    const ctx = makeContext({ memoryConfig: invalidConfig, onLogCollector: logs });

    await expect(execute(ctx)).rejects.toThrow("Failed to resolve runtime memory configuration");
    // Verify runChildProcess was never called
    expect(runChildProcessCallCount).toBe(0);

    // Negative assertions: raw connection string or internal details must not appear in onLog
    const allLogText = logs.map((l) => l.chunk).join("\n");
    expect(allLogText).not.toContain("connection_string");
    expect(allLogText).not.toContain("postgresql://bad:pass@host/db");
  });

  it("fails closed with generic error if runtimeMemory.getConfig() rejects, ensuring secrets never leak", async () => {
    const logs: Array<{ stream: string; chunk: string }> = [];
    const secretDsn = "postgresql://tenant_admin:SuperSecretLeak123!@pg.secret.internal:5432/private_db";
    const ctx = makeContext({
      runtimeMemoryAccessor: {
        getConfig: async () => {
          throw new Error(`Failed to decrypt secret: ${secretDsn}`);
        },
      },
      onLogCollector: logs,
    });

    let thrownError: Error | null = null;
    try {
      await execute(ctx);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toBe("Failed to resolve runtime memory configuration");
    expect(thrownError!.message).not.toContain("SuperSecretLeak123!");
    expect(thrownError!.message).not.toContain("pg.secret.internal");
    expect(thrownError!.message).not.toContain(secretDsn);

    // Verify logs do NOT contain the secret DSN or password
    const allLogText = logs.map((l) => l.chunk).join("\n");
    expect(allLogText).not.toContain("SuperSecretLeak123!");
    expect(allLogText).not.toContain("pg.secret.internal");
    expect(allLogText).not.toContain(secretDsn);
    expect(runChildProcessCallCount).toBe(0);
  });

  it("preserves prior behavior: does not emit metadata when ctx.onMeta is provided", async () => {
    const memory = createValidMemoryConfig();
    const onMetaSpy = vi.fn(async () => undefined);

    const ctx = makeContext({
      memoryConfig: memory,
      extraArgs: ["--sensitive-extra-flag", "super-secret-arg-val"],
      onMeta: onMetaSpy,
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    // Prior no-memory behavior is preserved: local execute does not call onMeta
    expect(onMetaSpy).not.toHaveBeenCalled();

    // Verify command args sent to child do NOT leak database passwords or credentials
    const argsStr = JSON.stringify(interceptedOpts.args);
    expect(argsStr).not.toContain(REALISTIC_SECRET_PASSWORD);
    expect(argsStr).not.toContain(REALISTIC_HOST);
  });

  describe("cleanup paths", () => {
    it("cleans up isolated home and mem0 state on non-zero exit code", async () => {
      mockChildProcessBehavior = "failure";
      const memory = createValidMemoryConfig();
      const ctx = makeContext({ memoryConfig: memory });

      const result = await execute(ctx);
      expect(result.exitCode).toBe(1);

      expect(interceptedOpts.tempHomeAtExecution).toBeTruthy();
      await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("cleans up isolated home and mem0 state on child process timeout", async () => {
      mockChildProcessBehavior = "timeout";
      const memory = createValidMemoryConfig();
      const ctx = makeContext({ memoryConfig: memory });

      const result = await execute(ctx);
      expect(result.timedOut).toBe(true);

      expect(interceptedOpts.tempHomeAtExecution).toBeTruthy();
      await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("cleans up isolated home and mem0 state when child process throws an unhandled error", async () => {
      mockChildProcessBehavior = "throw";
      const memory = createValidMemoryConfig();
      const ctx = makeContext({ memoryConfig: memory });

      await expect(execute(ctx)).rejects.toThrow("Simulated child process spawn failure");

      expect(interceptedOpts.tempHomeAtExecution).toBeTruthy();
      await expect(fs.access(interceptedOpts.tempHomeAtExecution!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("leaves normal execution unchanged when no runtime memory and no MCP servers are provided", async () => {
    process.env.PGHOST = "host-kept.com";
    const ctx = makeContext({ sessionId: "persisted-session-123" });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    // No isolated HERMES_HOME profile should be created
    expect(interceptedOpts.tempHomeAtExecution?.includes("paperclip-run-")).toBe(false);
    expect(interceptedOpts.mem0JsonExistedAtExecution).toBe(false);

    // Session resumption preserved
    expect(interceptedOpts.args).toContain("--resume");
    expect(interceptedOpts.args).toContain("persisted-session-123");
    expect(result.sessionParams).toEqual({ sessionId: "mem-session-999" });
    expect(result.clearSession).toBeUndefined();

    // MEM0_TELEMETRY set unconditionally on all runs
    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    expect(childEnv.MEM0_TELEMETRY).toBe("False");
    // Forbidden env vars are stripped unconditionally even on no-memory runs
    expect(childEnv.PGHOST).toBeUndefined();
  });

  describe("benign stderr reclassification and logging notices", () => {
    it("reclassifies benign INFO, DEBUG, MCP server, and timestamped lines to stdout while keeping errors on stderr", async () => {
      mockChildProcessBehavior = "emit_secrets";
      customStdout = "Normal stdout message\n";
      customStderr = [
        "2026-09-30T12:00:00Z INFO: Application initialized successfully\n",
        "INFO: hermes: connected to MCP server offline-server\n",
        "[DEBUG] tools: Registered MCP tool test_tool\n",
        "Successfully registered all tools\n",
        "Error: Genuine database connection failed\n",
      ].join("");

      const logs: Array<{ stream: string; chunk: string }> = [];
      const ctx = makeContext({ onLogCollector: logs });

      const result = await execute(ctx);
      expect(result.exitCode).toBe(0);

      // Verify reclassification
      const stdoutLogs = logs.filter((l) => l.stream === "stdout").map((l) => l.chunk).join("");
      const stderrLogs = logs.filter((l) => l.stream === "stderr").map((l) => l.chunk).join("");

      expect(stdoutLogs).toContain("Application initialized successfully");
      expect(stdoutLogs).toContain("connected to MCP server offline-server");
      expect(stdoutLogs).toContain("Registered MCP tool test_tool");
      expect(stdoutLogs).toContain("Successfully registered all tools");

      // Error must stay on stderr
      expect(stderrLogs).toContain("Error: Genuine database connection failed");
      expect(stderrLogs).not.toContain("Application initialized");
    });

    it("logs a safe notice documenting stripped forbidden database environment variables on every run", async () => {
      process.env.PGHOST = "secret-db.internal";
      process.env.PGPASSWORD = "super_secret_pg_pass";
      const logs: Array<{ stream: string; chunk: string }> = [];
      const ctx = makeContext({ onLogCollector: logs });

      await execute(ctx);

      const allLogs = logs.map((l) => l.chunk).join("");
      expect(allLogs).toContain("[hermes] Notice: Stripped");
      expect(allLogs).toContain("PGHOST");
      expect(allLogs).toContain("PGPASSWORD");
      // Never leaks values in the notice
      expect(allLogs).not.toContain("secret-db.internal");
      expect(allLogs).not.toContain("super_secret_pg_pass");
    });

    it("logs clean database environment notice when no forbidden DB env keys are present", async () => {
      delete process.env.PGHOST;
      delete process.env.PGPASSWORD;
      delete process.env.DATABASE_URL;
      delete process.env.DATABASE_MIGRATION_URL;
      const logs: Array<{ stream: string; chunk: string }> = [];
      const ctx = makeContext({ onLogCollector: logs });

      await execute(ctx);

      const allLogs = logs.map((l) => l.chunk).join("");
      expect(allLogs).toContain("[hermes] Notice:");
    });
  });

  describe("isBenignStderrLog classification", () => {
    it("classifies empty and whitespace-only lines as benign", () => {
      expect(isBenignStderrLog("")).toBe(true);
      expect(isBenignStderrLog("   \n")).toBe(true);
      expect(isBenignStderrLog("\t  \r\n")).toBe(true);
    });

    it("classifies structured timestamped INFO/DEBUG/WARN as benign", () => {
      expect(isBenignStderrLog("2026-10-01T12:00:00 [INFO] Server started")).toBe(true);
      expect(isBenignStderrLog("[2026-10-01 12:00:00] DEBUG: Initializing components")).toBe(true);
      expect(isBenignStderrLog("2026/10/01 12:00:00 WARNING Config key deprecated")).toBe(true);
      expect(isBenignStderrLog("2026-10-01T12:00:00 Application initialized")).toBe(true);
      expect(isBenignStderrLog("2026-10-01T12:00:00 Successfully registered all tools")).toBe(true);
    });

    it("classifies Python comma-millisecond timestamps with benign log levels as benign", () => {
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 - mem0 - INFO - Initializing mem0...")).toBe(true);
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 [INFO] Ready")).toBe(true);
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 - psycopg - DEBUG - Connection pool created")).toBe(true);
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 WARNING Connection pool high usage")).toBe(true);
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 Application initialized")).toBe(true);
    });

    it("rejects Python comma-millisecond timestamps with error levels as not benign", () => {
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 - mem0 - ERROR - Failed to connect to pgvector")).toBe(false);
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 [CRITICAL] Out of memory")).toBe(false);
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 FATAL could not open database")).toBe(false);
      expect(isBenignStderrLog("2026-10-01 12:34:56,789 Traceback (most recent call last):")).toBe(false);
    });

    it("rejects timestamped ERROR, CRITICAL, FATAL, and Traceback as not benign", () => {
      expect(isBenignStderrLog("2026-10-01T12:00:00 ERROR Failed to connect to pgvector")).toBe(false);
      expect(isBenignStderrLog("2026-10-01T12:00:00 [CRITICAL] Out of memory")).toBe(false);
      expect(isBenignStderrLog("2026-10-01T12:00:00 FATAL could not open database")).toBe(false);
      expect(isBenignStderrLog("2026-10-01T12:00:00 Traceback (most recent call last):")).toBe(false);
      expect(isBenignStderrLog("[2026-10-01 12:00:00] ERROR: authentication failed")).toBe(false);
    });

    it("rejects bare ERROR, CRITICAL, FATAL, and Traceback as not benign", () => {
      expect(isBenignStderrLog("ERROR: Connection refused")).toBe(false);
      expect(isBenignStderrLog("CRITICAL: system crash")).toBe(false);
      expect(isBenignStderrLog("FATAL: process terminated")).toBe(false);
      expect(isBenignStderrLog("Traceback (most recent call last):")).toBe(false);
    });

    it("classifies anchored MCP lifecycle patterns as benign", () => {
      expect(isBenignStderrLog("Successfully registered all tools")).toBe(true);
      expect(isBenignStderrLog("Registered MCP tool memory_search")).toBe(true);
      expect(isBenignStderrLog("[INFO] Registered MCP tool memory_write")).toBe(true);
      expect(isBenignStderrLog("tool registered successfully")).toBe(true);
      expect(isBenignStderrLog("MCP tool registered successfully")).toBe(true);
      expect(isBenignStderrLog("MCP Server: git-server")).toBe(true);
      expect(isBenignStderrLog("MCP server connected")).toBe(true);
      expect(isBenignStderrLog("Application initialized")).toBe(true);
    });

    it("rejects unanchored error lines mentioning MCP server or tools as not benign", () => {
      expect(isBenignStderrLog("Fatal error: MCP Server unreachable")).toBe(false);
      expect(isBenignStderrLog("Exception in worker: Registered MCP tool crashed")).toBe(false);
      expect(isBenignStderrLog("Connection error occurred when MCP Server refused packet")).toBe(false);
      expect(isBenignStderrLog("Random unclassified error message")).toBe(false);
    });

    it("rejects pseudo-log-level words without delimiters (e.g. warned, inform, debugging, INFOMERCIAL)", () => {
      expect(isBenignStderrLog("warned user that database credentials were not found")).toBe(false);
      expect(isBenignStderrLog("information about failed connection to host")).toBe(false);
      expect(isBenignStderrLog("debugging output from worker showed fatal exit")).toBe(false);
      expect(isBenignStderrLog("INFOMERCIAL banner displayed")).toBe(false);
      expect(isBenignStderrLog("2026-10-01T12:00:00 warned user of config issue")).toBe(false);
    });
  });

  describe("augmentStaleImageError", () => {
    it("augments error message when stderr contains ModuleNotFoundError for mem0/psycopg", () => {
      const err = augmentStaleImageError(
        "Hermes exited with code 1",
        createValidMemoryConfig(),
        "ModuleNotFoundError: No module named 'mem0'",
      );
      expect(err).toContain("Stale Docker image detected: missing mem0ai/psycopg dependencies");
    });

    it("augments error message when stderr contains ImportError for psycopg", () => {
      const err = augmentStaleImageError(
        "Failed run",
        createValidMemoryConfig(),
        "ImportError: cannot import name 'psycopg' from 'psycopg'",
      );
      expect(err).toContain("Stale Docker image detected: missing mem0ai/psycopg dependencies");
    });

    it("augments error message for No module named psycopg2", () => {
      const err = augmentStaleImageError(
        "Failed run",
        createValidMemoryConfig(),
        "No module named 'psycopg2'",
      );
      expect(err).toContain("Stale Docker image detected: missing mem0ai/psycopg dependencies");
    });

    it("does not augment error when stderr merely mentions Mem0MemoryProvider benignly", () => {
      const err = augmentStaleImageError(
        "Hermes exited with code 1",
        createValidMemoryConfig(),
        "[INFO] Initializing Mem0MemoryProvider\nError: connection timed out",
      );
      expect(err).toBe("Hermes exited with code 1");
      expect(err).not.toContain("Stale Docker image detected");
    });

    it("does not augment error when memoryConfig is null", () => {
      const err = augmentStaleImageError(
        "Hermes exited with code 1",
        null,
        "ModuleNotFoundError: No module named 'mem0'",
      );
      expect(err).toBe("Hermes exited with code 1");
    });
  });

  describe("checkHermesMemoryCapability and preflight throw", () => {
    let fixtureDir: string | null = null;

    afterEach(() => {
      if (fixtureDir) {
        try {
          rmSync(fixtureDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        fixtureDir = null;
      }
    });

    it("reports available when outside container (path does not exist)", async () => {
      const result = await checkHermesMemoryCapability("/non/existent/opt/hermes/path");
      expect(result.available).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("reports available when marked production closure has valid python and imports succeed", async () => {
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-test-prod-"));
      writeFileSync(path.join(fixtureDir, HERMES_PRODUCTION_CLOSURE_SENTINEL), "test-digest");
      mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
      const pythonBin = path.join(fixtureDir, "bin", "python3");
      writeFileSync(pythonBin, "#!/bin/sh\nexit 0\n");
      chmodSync(pythonBin, 0o755);

      const result = await checkHermesMemoryCapability(fixtureDir);
      expect(result.available).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("fails explicitly when marked production closure is missing python interpreter", async () => {
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-test-prod-nopy-"));
      writeFileSync(path.join(fixtureDir, HERMES_PRODUCTION_CLOSURE_SENTINEL), "test-digest");
      // Do not create bin/python3

      const result = await checkHermesMemoryCapability(fixtureDir);
      expect(result.available).toBe(false);
      expect(result.error).toContain("marked production closure");
      expect(result.error).toContain("missing the Python interpreter");
      expect(result.error).toContain("corrupted");
    });

    it("fails explicitly with stale-image error when marked production closure fails python import check", async () => {
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-test-prod-fail-"));
      writeFileSync(path.join(fixtureDir, HERMES_PRODUCTION_CLOSURE_SENTINEL), "test-digest");
      mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
      const pythonBin = path.join(fixtureDir, "bin", "python3");
      writeFileSync(pythonBin, "#!/bin/sh\necho 'No module named mem0' >&2\nexit 1\n");
      chmodSync(pythonBin, 0o755);

      const result = await checkHermesMemoryCapability(fixtureDir);
      expect(result.available).toBe(false);
      expect(result.error).toContain("production Docker image lacks required dependencies");
      expect(result.error).toContain("The container image appears stale");
    });

    it("distinguishes Daytona/unmarked environment when python import check fails", async () => {
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-test-daytona-"));
      // No .hermes-production-closure sentinel written
      mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
      const pythonBin = path.join(fixtureDir, "bin", "python3");
      writeFileSync(pythonBin, "#!/bin/sh\nexit 1\n");
      chmodSync(pythonBin, 0o755);

      const result = await checkHermesMemoryCapability(fixtureDir);
      expect(result.available).toBe(false);
      expect(result.error).toContain("is not a Paperclip production image with the baked memory closure");
      expect(result.error).toContain("Daytona and custom environments require installing the Hermes memory closure");
    });

    it("reports missing python in Daytona/unmarked environment when python binary is absent", async () => {
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-test-daytona-nopy-"));
      // No sentinel, no bin/python3

      const result = await checkHermesMemoryCapability(fixtureDir);
      expect(result.available).toBe(false);
      expect(result.error).toContain("Python interpreter");
      expect(result.error).toContain("was not found");
    });

    it("execute throws and logs preflight failure to stderr when preflight fails", async () => {
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-test-exec-fail-"));
      writeFileSync(path.join(fixtureDir, HERMES_PRODUCTION_CLOSURE_SENTINEL), "test-digest");
      mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
      const pythonBin = path.join(fixtureDir, "bin", "python3");
      writeFileSync(pythonBin, "#!/bin/sh\nexit 1\n");
      chmodSync(pythonBin, 0o755);

      const logs: Array<{ stream: string; chunk: string }> = [];
      const ctx = makeContext({
        memoryConfig: createValidMemoryConfig(),
        onLogCollector: logs,
      });

      const originalEnv = process.env.PAPERCLIP_HERMES_OPT_PATH;
      process.env.PAPERCLIP_HERMES_OPT_PATH = fixtureDir;

      try {
        await expect(execute(ctx)).rejects.toThrow(
          "Hermes runtime memory is enabled, but the production Docker image lacks required dependencies",
        );

        // Preflight failure must be logged to stderr, NOT stdout
        const stderrLogs = logs.filter((l) => l.stream === "stderr").map((l) => l.chunk).join("");
        expect(stderrLogs).toContain(
          "[hermes] Error: Hermes runtime memory is enabled, but the production Docker image lacks required dependencies",
        );

        const stdoutLogs = logs.filter((l) => l.stream === "stdout").map((l) => l.chunk).join("");
        expect(stdoutLogs).not.toContain("[hermes] Error: Hermes runtime memory");
      } finally {
        if (originalEnv !== undefined) {
          process.env.PAPERCLIP_HERMES_OPT_PATH = originalEnv;
        } else {
          delete process.env.PAPERCLIP_HERMES_OPT_PATH;
        }
      }
    });

    it("distinguishes stale pre-sentinel Paperclip production image from Daytona/custom", async () => {
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-test-stale-prod-"));
      // No sentinel, but optHermesPath exists with bin/python3
      mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
      const pythonBin = path.join(fixtureDir, "bin", "python3");
      writeFileSync(pythonBin, "#!/bin/sh\nexit 0\n");
      chmodSync(pythonBin, 0o755);

      const origHome = process.env.PAPERCLIP_HOME;
      try {
        process.env.PAPERCLIP_HOME = "/paperclip";
        const result = await checkHermesMemoryCapability(fixtureDir);
        expect(result.available).toBe(false);
        expect(result.error).toContain("current Paperclip production container image is stale (pre-sentinel image missing the memory requirements closure)");
      } finally {
        if (origHome !== undefined) {
          process.env.PAPERCLIP_HOME = origHome;
        } else {
          delete process.env.PAPERCLIP_HOME;
        }
      }
    });

    it("resolveOptHermesPath honors PAPERCLIP_HERMES_OPT_PATH in test mode and ignores it in production mode even with VITEST=1", () => {
      const origEnv = process.env.NODE_ENV;
      const origVitest = process.env.VITEST;
      const origOpt = process.env.PAPERCLIP_HERMES_OPT_PATH;

      try {
        process.env.PAPERCLIP_HERMES_OPT_PATH = "/tmp/custom-opt-hermes";

        // In test mode: honors PAPERCLIP_HERMES_OPT_PATH
        process.env.NODE_ENV = "test";
        expect(resolveOptHermesPath()).toBe("/tmp/custom-opt-hermes");

        // In development mode: strictly /opt/hermes, ignoring PAPERCLIP_HERMES_OPT_PATH
        process.env.NODE_ENV = "development";
        expect(resolveOptHermesPath()).toBe("/opt/hermes");

        // When NODE_ENV is undefined: strictly /opt/hermes, ignoring PAPERCLIP_HERMES_OPT_PATH
        delete process.env.NODE_ENV;
        expect(resolveOptHermesPath()).toBe("/opt/hermes");

        // In production mode: strictly /opt/hermes, ignoring PAPERCLIP_HERMES_OPT_PATH even if VITEST is set
        process.env.NODE_ENV = "production";
        process.env.VITEST = "1";
        expect(resolveOptHermesPath()).toBe("/opt/hermes");

        delete process.env.VITEST;
        expect(resolveOptHermesPath()).toBe("/opt/hermes");

        // Explicit override parameter always wins
        expect(resolveOptHermesPath("/explicit/override")).toBe("/explicit/override");
      } finally {
        if (origEnv !== undefined) process.env.NODE_ENV = origEnv;
        else delete process.env.NODE_ENV;
        if (origVitest !== undefined) process.env.VITEST = origVitest;
        else delete process.env.VITEST;
        if (origOpt !== undefined) process.env.PAPERCLIP_HERMES_OPT_PATH = origOpt;
        else delete process.env.PAPERCLIP_HERMES_OPT_PATH;
      }
    });

    it("isPaperclipProductionContainer relies strictly on /paperclip markers and not generic entrypoints", () => {
      const origHome = process.env.PAPERCLIP_HOME;
      try {
        delete process.env.PAPERCLIP_HOME;
        // Without /paperclip directory or PAPERCLIP_HOME, returns false
        // even if a standard node base image has /usr/local/bin/docker-entrypoint.sh
        existsSyncMockHandler = (targetPath: unknown) => {
          if (targetPath === "/usr/local/bin/docker-entrypoint.sh") return true;
          if (targetPath === "/paperclip") return false;
          return false;
        };
        expect(isPaperclipProductionContainer()).toBe(false);

        // When /paperclip exists, returns true
        existsSyncMockHandler = (targetPath: unknown) => targetPath === "/paperclip";
        expect(isPaperclipProductionContainer()).toBe(true);

        // When /paperclip does not exist but PAPERCLIP_HOME is /paperclip, returns true
        existsSyncMockHandler = () => false;
        process.env.PAPERCLIP_HOME = "/paperclip";
        expect(isPaperclipProductionContainer()).toBe(true);

        // When /paperclip does not exist and PAPERCLIP_HOME is /home/daytona, returns false
        process.env.PAPERCLIP_HOME = "/home/daytona";
        expect(isPaperclipProductionContainer()).toBe(false);
      } finally {
        existsSyncMockHandler = null;
        if (origHome !== undefined) process.env.PAPERCLIP_HOME = origHome;
        else delete process.env.PAPERCLIP_HOME;
      }
    });

    it("exports consistent required memory module list and check statement", () => {
      expect(HERMES_MEMORY_REQUIRED_MODULES).toEqual(["mem0", "psycopg", "psycopg2"]);
      expect(HERMES_MEMORY_PYTHON_IMPORT_CHECK).toBe("import mem0, psycopg, psycopg2");
    });
  });
});

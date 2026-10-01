import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type {
  AdapterExecutionContext,
  AdapterMem0PgvectorRuntimeMemoryConfig,
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

import { execute } from "./execute.js";

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
        model: "gpt-4o-mini",
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

    // Negative assertions: the secret password, host, user, db, collection MUST NOT appear
    const allLogText = logs.map((l) => l.chunk).join("\n");
    expect(allLogText).not.toContain(REALISTIC_SECRET_PASSWORD);
    expect(allLogText).not.toContain(REALISTIC_HOST);
    expect(allLogText).not.toContain(REALISTIC_USER);
    expect(allLogText).not.toContain(REALISTIC_DB);
    expect(allLogText).not.toContain(REALISTIC_COLLECTION);
    expect(allLogText).toContain("***REDACTED***");

    // Check executionResult summary
    expect(result.summary).not.toContain(REALISTIC_SECRET_PASSWORD);
    expect(result.summary).not.toContain(REALISTIC_HOST);
    expect(result.summary).toContain("***REDACTED***");

    // Check executionResult resultJson
    const resultJsonStr = JSON.stringify(result.resultJson);
    expect(resultJsonStr).not.toContain(REALISTIC_SECRET_PASSWORD);
    expect(resultJsonStr).not.toContain(REALISTIC_HOST);

    // Check executionResult errorMessage
    if (result.errorMessage) {
      expect(result.errorMessage).not.toContain(REALISTIC_SECRET_PASSWORD);
      expect(result.errorMessage).not.toContain(REALISTIC_HOST);
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

  it("redacts short DB identifiers and credentials regardless of length without fragment reconstruction", async () => {
    mockChildProcessBehavior = "emit_secrets";
    const shortPass = "p!";
    const shortUser = "u1";
    const shortDb = "db";
    const shortColl = "c1";

    customStdout = `DB connected: user=${shortUser} db=${shortDb} coll=${shortColl} pass=${shortPass}\n`;
    customStderr = `Error for ${shortUser} on ${shortDb} with ${shortPass}\n`;

    const logs: Array<{ stream: string; chunk: string }> = [];
    const memory: AdapterMem0PgvectorRuntimeMemoryConfig = {
      provider: "mem0",
      mode: "oss",
      userId: "company",
      agentId: "agent-1",
      llm: { provider: "openai", config: { model: "gpt-4o" } },
      embedder: { provider: "openai", config: { model: "text-embed" } },
      vectorStore: {
        provider: "pgvector",
        config: {
          host: "db.internal.net",
          port: 5432,
          user: shortUser,
          password: shortPass,
          dbname: shortDb,
          sslmode: "require",
          collectionName: shortColl,
        },
      },
    };

    const ctx = makeContext({ memoryConfig: memory, onLogCollector: logs });
    const result = await execute(ctx);

    const allLogs = logs.map((l) => l.chunk).join("");
    expect(allLogs).not.toContain(`user=${shortUser}`);
    expect(allLogs).not.toContain(`pass=${shortPass}`);
    expect(allLogs).not.toContain(`db=${shortDb}`);
    expect(allLogs).not.toContain(`coll=${shortColl}`);
    expect(allLogs).toContain("***REDACTED***");

    expect(result.summary).not.toContain(shortPass);
    expect(JSON.stringify(result.resultJson)).not.toContain(shortPass);
  });

  it("fails closed before spawn with generic error if runtime memory config is malformed or invalid", async () => {
    const logs: Array<{ stream: string; chunk: string }> = [];
    // Missing required pgvector collectionName / split fields
    const invalidConfig = {
      provider: "mem0",
      mode: "oss",
      userId: "company",
      agentId: "agent-1",
      llm: { provider: "openai", config: { model: "gpt-4o" } },
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

    // MEM0_TELEMETRY not added
    const childEnv = interceptedOpts.opts?.env as Record<string, string>;
    expect(childEnv.MEM0_TELEMETRY).toBeUndefined();
    // Forbidden env vars are stripped unconditionally even on no-memory runs
    expect(childEnv.PGHOST).toBeUndefined();
  });
});

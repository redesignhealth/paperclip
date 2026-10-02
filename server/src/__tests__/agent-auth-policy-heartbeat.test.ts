/**
 * TECH-7095 heartbeat enforcement (embedded Postgres): the pre-spawn managed AI connection gate,
 * the isolated run home for non-managed adapters, runtime neutralisation of saved env overrides,
 * host GitHub refusal, the process adapter credential refusal, and create-route env validation.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { createRunHome } from "@paperclipai/adapter-utils/run-home";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Only the managed runtime preparation is replaced (it needs a stored grant); the gate,
// env layering and adapter dispatch under test are real.
const mockPrepareManagedAiRuntime = vi.hoisted(() => vi.fn());
vi.mock("../services/ai-connection-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ai-connection-runtime.js")>()),
  prepareManagedAiRuntime: mockPrepareManagedAiRuntime,
}));

import { heartbeatService } from "../services/heartbeat.ts";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { logger } from "../middleware/logger.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// Sentinel secrets in the server env: none may reach a child, an error, or a log line.
const SENTINELS = {
  DATABASE_URL: "postgres://sentinel-db-7095",
  BETTER_AUTH_SECRET: "sentinel-better-auth-7095",
  ANTHROPIC_API_KEY: "sentinel-anthropic-7095",
  GITHUB_TOKEN: "sentinel-github-7095",
} as const;
const SENTINEL_VALUES = Object.values(SENTINELS);
function expectNoSentinel(text: string) {
  for (const value of SENTINEL_VALUES) expect(text).not.toContain(value);
}

describeEmbeddedPostgres("agent auth policy in the heartbeat", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fakeHostHome = "";
  let scratch = "";
  const saved: Record<string, string | undefined> = {};
  const execute = vi.fn();

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_AGENT_AUTH_POLICY", "HOME", ...Object.keys(SENTINELS)]) {
      saved[key] = process.env[key];
    }
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "agent-auth-policy-heartbeat-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("agent-auth-policy-heartbeat-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    scratch = await mkdtemp(path.join(os.tmpdir(), "paperclip-7095-hb-"));
    // A fake host HOME holding a "host login" a run must never be pointed at.
    fakeHostHome = path.join(scratch, "host-home");
    await mkdir(path.join(fakeHostHome, ".claude"), { recursive: true });
    await writeFile(path.join(fakeHostHome, ".claude", ".credentials.json"), "{\"host\":\"login\"}");
    process.env.HOME = fakeHostHome;
    Object.assign(process.env, SENTINELS);
  }, 60_000);

  beforeEach(() => {
    execute.mockReset();
    execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false, resultJson: {} }));
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    mockPrepareManagedAiRuntime.mockReset();
    mockPrepareManagedAiRuntime.mockImplementation(async (_db: unknown, input: { config: Record<string, unknown> }) => {
      const home = await createRunHome({ prefix: "paperclip-ai-test-" });
      return {
        config: {
          ...input.config,
          env: { ...(input.config.env as Record<string, unknown> ?? {}), ...home.env, CLAUDE_CONFIG_DIR: home.providerDir, ANTHROPIC_API_KEY: "managed-fixture-key" },
          managedAiConnection: { connectionId: "c1", grantId: "g1", provider: "anthropic", method: "api_key", mode: "responsible_user", identity: "g1:u:0" },
        },
        attribution: { connectionId: "c1", grantId: "g1", provider: "anthropic", method: "api_key", mode: "responsible_user", responsibleUserId: "responsible-user" },
        accountName: "Fixture account",
        accountOwnerUserId: null,
        identity: "g1:u:0",
        cleanup: home.cleanup,
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    unregisterServerAdapter("claude_local");
    await heartbeat.drainActiveRunExecutions();
    // Scan the rows THIS test produced before they are truncated away: no run/event row may
    // carry a sentinel server secret.
    expectNoSentinel(JSON.stringify(await db.select().from(heartbeatRuns)));
    expectNoSentinel(JSON.stringify(await db.select().from(heartbeatRunEvents)));
    await db.execute(sql.raw(`TRUNCATE TABLE "environment_leases","environments","activity_log","heartbeat_run_events","heartbeat_runs","agent_wakeup_requests","agent_runtime_state","company_skills","agents","companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  async function seed(input: { adapterType: string; adapterConfig?: Record<string, unknown>; runtimeConfig?: Record<string, unknown> }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Policy", issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Agent", role: "engineer", status: "idle",
      adapterType: input.adapterType, adapterConfig: input.adapterConfig ?? {}, runtimeConfig: input.runtimeConfig ?? {}, permissions: {},
    });
    return { companyId, agentId };
  }

  async function runToEnd(agentId: string) {
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    await expect.poll(async () => (await heartbeat.getRun(queued!.id))?.status, { timeout: 20_000 }).not.toMatch(/^(queued|running)$/);
    return (await heartbeat.getRun(queued!.id))!;
  }

  function processEnvDumpConfig(outPath: string, env: Record<string, unknown> = {}) {
    return {
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(process.env))`],
      env,
    };
  }

  it("managed_only: an unbound managed-capable run fails ai_connection_required and never reaches execute", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const { agentId, companyId } = await seed({ adapterType: "claude_local" });
    const finished = await runToEnd(agentId);
    expect(finished.status).toBe("failed");
    expect(finished.errorCode).toBe("configuration_incomplete");
    expect((finished.resultJson as any)?.configurationIncomplete).toMatchObject({
      reason: "ai_connection_required", companyId, agentId,
      actionUrl: `/agents/${agentId}/runtime`, fingerprint: `ai-required:${agentId}`,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockPrepareManagedAiRuntime).not.toHaveBeenCalled();
    expectNoSentinel(JSON.stringify(finished));
  });

  it("managed_only_report: the unbound run proceeds and a names-only warning is logged", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only_report";
    const warn = vi.spyOn(logger, "warn");
    const { agentId } = await seed({ adapterType: "claude_local" });
    const finished = await runToEnd(agentId);
    expect(finished.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
    const policyWarnings = warn.mock.calls.filter((call) => String(call[1] ?? "").includes("no managed AI connection"));
    expect(policyWarnings).toHaveLength(1);
    expect(policyWarnings[0]?.[0]).toMatchObject({ agentId, adapterType: "claude_local", policy: "managed_only_report" });
    expectNoSentinel(JSON.stringify(warn.mock.calls));
  });

  it("host_fallback: the unbound run is unchanged (executes, host GitHub mode)", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const { agentId } = await seed({ adapterType: "claude_local" });
    const finished = await runToEnd(agentId);
    expect(finished.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].context.githubAuthenticationMode).toBe("host");
  });

  it("managed_only: a bound run is unaffected, uses the managed home and never host GitHub", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const { agentId } = await seed({
      adapterType: "claude_local",
      runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } },
    });
    const finished = await runToEnd(agentId);
    expect(finished.status).toBe("succeeded");
    expect(mockPrepareManagedAiRuntime).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const ctx = execute.mock.calls[0]?.[0];
    expect(ctx.config.env.HOME).toMatch(/paperclip-ai-test-/);
    expect(ctx.config.env.HOME).not.toBe(fakeHostHome);
    expect(ctx.context.githubAuthenticationMode).toBe("managed");
  });

  it("managed_only: a non-managed adapter runs in an isolated run home that saved overrides cannot redirect", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const out = path.join(scratch, `env-${randomUUID()}.json`);
    // A pre-existing saved override (written straight to the DB, bypassing validation).
    const { agentId } = await seed({
      adapterType: "process",
      adapterConfig: processEnvDumpConfig(out, {
        HOME: fakeHostHome, XDG_CONFIG_HOME: path.join(fakeHostHome, ".config"), TMPDIR: "/tmp/override",
        CODEX_HOME: path.join(fakeHostHome, ".codex"), GH_CONFIG_DIR: path.join(fakeHostHome, ".config/gh"), KEEP_ME: "yes",
      }),
    });
    const finished = await runToEnd(agentId);
    expect(finished.status).toBe("succeeded");
    const childEnv = JSON.parse(await readFile(out, "utf8")) as Record<string, string>;
    expect(childEnv.HOME).toMatch(/paperclip-run-home-/);
    expect(childEnv.HOME).not.toBe(fakeHostHome);
    expect(childEnv.XDG_CONFIG_HOME).toBe(path.join(childEnv.HOME, "config"));
    expect(childEnv.TMPDIR).toBe(path.join(childEnv.HOME, "tmp"));
    expect(childEnv.CODEX_HOME).toBeUndefined();
    expect(childEnv.GH_CONFIG_DIR ?? "").not.toContain(fakeHostHome);
    expect(childEnv.KEEP_ME).toBe("yes");
    expectNoSentinel(JSON.stringify(childEnv));
    // Cleaned up in the run's finally, which runs just after the terminal status is written.
    for (let i = 0; i < 100 && existsSync(childEnv.HOME); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(childEnv.HOME)).toBe(false);
  });

  it("host_fallback: the same saved override is honoured exactly as before", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const out = path.join(scratch, `env-${randomUUID()}.json`);
    const { agentId } = await seed({ adapterType: "process", adapterConfig: processEnvDumpConfig(out, { HOME: fakeHostHome }) });
    const finished = await runToEnd(agentId);
    expect(finished.status).toBe("succeeded");
    const childEnv = JSON.parse(await readFile(out, "utf8")) as Record<string, string>;
    expect(childEnv.HOME).toBe(fakeHostHome);
  });

  it("managed_only: a process agent carrying an AI provider key is refused and never spawned", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const out = path.join(scratch, `env-${randomUUID()}.json`);
    const { agentId } = await seed({
      adapterType: "process",
      adapterConfig: processEnvDumpConfig(out, { ANTHROPIC_API_KEY: SENTINELS.ANTHROPIC_API_KEY }),
    });
    const finished = await runToEnd(agentId);
    expect(finished.status).toBe("failed");
    expect(existsSync(out)).toBe(false);
    expect(finished.error ?? "").toMatch(/environment settings/);
    expectNoSentinel(JSON.stringify(finished));
  });

  it("create route: managed_only rejects a HOME override with 422; host_fallback accepts it", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Route", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "local-board",
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    const body = {
      name: "Proc", role: "engineer", adapterType: "process",
      adapterConfig: { command: "true", env: { HOME: { type: "plain", value: SENTINELS.BETTER_AUTH_SECRET }, XDG_DATA_HOME: "/x" } },
    };
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const refused = await request(app).post(`/api/companies/${companyId}/agents`).send(body);
    expect(refused.status).toBe(422);
    expect(refused.body.details?.code).toBe("agent_env_override_forbidden");
    expect(refused.body.details?.keys).toEqual(["HOME", "XDG_DATA_HOME"]);
    expectNoSentinel(JSON.stringify(refused.body));
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);

    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const accepted = await request(app).post(`/api/companies/${companyId}/agents`).send({ ...body, adapterConfig: { command: "true", env: { HOME: "/legacy" } } });
    expect(accepted.status).toBe(201);
  });
});

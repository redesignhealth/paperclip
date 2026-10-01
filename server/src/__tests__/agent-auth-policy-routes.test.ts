/**
 * TECH-7095: the adapter test-environment route under the agent auth policy. A managed-capable
 * adapter with no managed AI connection is refused (422 ai_connection_required) BEFORE any
 * secret resolution or probe; a non-managed adapter probe runs in an isolated run home.
 */
import { existsSync } from "node:fs";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(async () => []),
}));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(async () => null),
  listPrincipalGrants: vi.fn(async () => []),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  collectMissingRuntimeBindings: vi.fn(async () => [] as Array<Record<string, unknown>>),
  resolveEnvBindings: vi.fn(async () => ({ env: {} as Record<string, string>, secretKeys: new Set<string>(), manifest: [] })),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  releaseLease: vi.fn(),
  listBoundCompanyIds: vi.fn(async () => [] as string[]),
  findManagedSandboxEnvironment: vi.fn(async () => null as Record<string, unknown> | null),
}));
const mockEnvironmentRuntime = vi.hoisted(() => ({
  acquireRunLease: vi.fn(),
  realizeWorkspace: vi.fn(),
  getDriver: vi.fn(() => ({ releaseRunLease: vi.fn(async () => undefined) })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  getExperimental: vi.fn(async () => ({ enableManagedSandboxOnly: false })),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
    resolveRequestedSkillKeys: vi.fn(async () => []),
  }),
  budgetService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn(), cancelActiveForAgent: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));
vi.mock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../services/environment-runtime.js", () => ({ environmentRuntimeService: () => mockEnvironmentRuntime }));
vi.mock("../services/environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: vi.fn(async () => null) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => mockInstanceSettingsService }));

const SENTINEL = "sentinel-anthropic-route-7095";
const testEnvironmentSpy = vi.fn();
const passResult = (adapterType: string) => ({
  adapterType, status: "pass" as const, checks: [], testedAt: new Date(0).toISOString(),
});

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

let previousPolicy: string | undefined;
let previousAnthropic: string | undefined;
const overridden: Array<{ type: string; previous: ServerAdapterModule | null }> = [];

async function overrideAdapter(type: string) {
  const { registerServerAdapter, getServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
  let previous: ServerAdapterModule | null = null;
  try { previous = getServerAdapter(type); } catch { previous = null; }
  unregisterServerAdapter(type);
  registerServerAdapter({
    type,
    execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
    testEnvironment: testEnvironmentSpy,
  } as ServerAdapterModule);
  overridden.push({ type, previous });
}

describe("test-environment route under the agent auth policy", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    previousPolicy = process.env.PAPERCLIP_AGENT_AUTH_POLICY;
    previousAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = SENTINEL;
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "Allowed by test grant" });
    testEnvironmentSpy.mockImplementation(async (ctx: { adapterType: string }) => passResult(ctx.adapterType));
    await overrideAdapter("claude_local");
    await overrideAdapter("hermes_local");
  });

  afterEach(async () => {
    const { registerServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    for (const { type, previous } of overridden.splice(0)) {
      unregisterServerAdapter(type);
      if (previous) registerServerAdapter(previous);
    }
    if (previousPolicy === undefined) delete process.env.PAPERCLIP_AGENT_AUTH_POLICY;
    else process.env.PAPERCLIP_AGENT_AUTH_POLICY = previousPolicy;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
  });

  it("managed_only: refuses an unbound managed-capable adapter test with 422 before any probe", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/claude_local/test-environment")
      .send({ adapterConfig: {} });
    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("ai_connection_required");
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
    expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
    expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  });

  it("managed_only_report: the unbound test still runs (report only)", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only_report";
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/claude_local/test-environment")
      .send({ adapterConfig: {} });
    expect(res.status).toBe(200);
    expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
  });

  it("host_fallback: behaviour unchanged", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/claude_local/test-environment")
      .send({ adapterConfig: { env: { HOME: "/legacy/home" } } });
    expect(res.status).toBe(200);
    expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
    expect(testEnvironmentSpy.mock.calls[0]?.[0].config.env?.HOME).toBe("/legacy/home");
  });

  it("managed_only: a non-managed adapter probe runs in an isolated, cleaned-up run home", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/hermes_local/test-environment")
      .send({ adapterConfig: {} });
    expect(res.status).toBe(200);
    const env = testEnvironmentSpy.mock.calls[0]?.[0].config.env as Record<string, string>;
    expect(env.HOME).toMatch(/paperclip-run-home-/);
    expect(env.HOME).not.toBe(process.env.HOME);
    expect(env.XDG_CONFIG_HOME?.startsWith(env.HOME)).toBe(true);
    expect(env.TMPDIR?.startsWith(env.HOME)).toBe(true);
    expect(existsSync(env.HOME)).toBe(false);
  });

  it("managed_only: rejects a home/credential-location env override with 422 (names only)", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/hermes_local/test-environment")
      .send({ adapterConfig: { env: { HOME: "/override", GIT_SSH_COMMAND: SENTINEL } } });
    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("agent_env_override_forbidden");
    expect(res.body.details?.keys).toEqual(["GIT_SSH_COMMAND", "HOME"]);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
  });
});

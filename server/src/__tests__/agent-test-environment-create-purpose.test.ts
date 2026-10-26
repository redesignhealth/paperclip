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
  forecastPlatformDefaultCompanySecret: vi.fn(async () => ({ outcome: "created", wouldBind: true })),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  collectMissingRuntimeBindings: vi.fn(async () => [] as Array<Record<string, unknown>>),
  resolveEnvBindings: vi.fn(async () => ({
    env: {} as Record<string, string>,
    secretKeys: new Set<string>(),
    manifest: [],
  })),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  releaseLease: vi.fn(),
  listBoundCompanyIds: vi.fn(async () => [] as string[]),
  findManagedSandboxEnvironment: vi.fn(async () => null as Record<string, unknown> | null),
}));

const mockReleaseRunLease = vi.hoisted(() => vi.fn(async () => undefined));
const mockEnvironmentRuntime = vi.hoisted(() => ({
  acquireRunLease: vi.fn(),
  realizeWorkspace: vi.fn(),
  getDriver: vi.fn(() => ({
    releaseRunLease: mockReleaseRunLease,
  })),
}));

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn());
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
  heartbeatService: () => ({
    wakeup: vi.fn(),
    cancelActiveForAgent: vi.fn(),
  }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

const platformKey = vi.hoisted(() => ({ value: null as string | null }));
const readPlatformKeySpy = vi.hoisted(() => vi.fn(() => platformKey.value));
vi.mock("../secrets/platform-default-openai-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/platform-default-openai-key.js")>()),
  readPlatformDefaultOpenAiKey: readPlatformKeySpy,
}));

const routerPlatformKey = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../secrets/platform-default-router-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/platform-default-router-key.js")>()),
  readPlatformDefaultRouterKey: vi.fn(() => routerPlatformKey.value),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntime,
}));

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

const testEnvironmentSpy = vi.fn();

const externalAdapter: ServerAdapterModule = {
  type: "external_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: testEnvironmentSpy,
};

// Only the runtime preparation is replaced: it needs a database and a stored
// grant, and these tests exercise the route's verdict, not credential
// resolution. Everything else in the module stays real. The same goes for
// validateAiApiKey — it calls the provider's real endpoint, and these tests
// direct its verdict instead of the network.
const mockPrepareManagedAiRuntime = vi.hoisted(() => vi.fn());
vi.mock("../services/ai-connection-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ai-connection-runtime.js")>()),
  prepareManagedAiRuntime: mockPrepareManagedAiRuntime,
}));
const mockValidateAiApiKey = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../routes/ai-connections.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/ai-connections.js")>()),
  validateAiApiKey: mockValidateAiApiKey,
}));

function mockManagedRuntime(method: "api_key" | "subscription") {
  mockPrepareManagedAiRuntime.mockImplementation(
    async (_db: unknown, input: { config: Record<string, unknown> }) => ({
      config: {
        ...input.config,
        // The real preparation injects the credential under the provider's
        // env key; the adoption re-verification reads it from there.
        env: { ...(method === "api_key" ? { ANTHROPIC_API_KEY: "sk-ant-test-key" } : {}) },
        managedAiConnection: {
          connectionId: "conn-1",
          grantId: "grant-1",
          provider: "anthropic",
          method,
          mode: "responsible_user",
          responsibleUserId: "local-board",
          identity: "grant-1:local-board:0000000000000000",
        },
      },
      attribution: {
        connectionId: "conn-1",
        grantId: "grant-1",
        provider: "anthropic",
        method,
        mode: "responsible_user",
        responsibleUserId: "local-board",
      },
      accountName: "My Claude Account",
      accountOwnerUserId: "local-board",
      identity: "grant-1:local-board:0000000000000000",
      cleanup: vi.fn(async () => {}),
    }),
  );
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}


const PLATFORM_KEY = "sk-platform-default-never-leaks-1234567890";
const ROUTER_KEY = "rr-one-shot-router-key-never-leaks-7895";
const hermesSpy = vi.fn();

/**
 * TECH-7895: the opt-in create-purpose environment test. It forecasts (read-only) the defaults a NEW
 * Hermes agent would get, tests that effective configuration, and returns only a safe projection.
 */
describe("create-purpose test-environment (Hermes create defaults)", () => {
  let previousHermes: ServerAdapterModule | null = null;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    platformKey.value = null;
    routerPlatformKey.value = null;
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "Allowed" });
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue([]);
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);
    mockSecretService.forecastPlatformDefaultCompanySecret.mockResolvedValue({ outcome: "created", wouldBind: true });
    hermesSpy.mockImplementation(async (ctx: { config: Record<string, unknown> }) => ({
      adapterType: "hermes_local",
      status: "pass",
      checks: [{ code: "probe_ran", level: "info", message: `provider=${String(ctx.config.provider)}` }],
      testedAt: new Date(0).toISOString(),
    }));
    const { registerServerAdapter, getServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    previousHermes = getServerAdapter("hermes_local") ?? null;
    unregisterServerAdapter("hermes_local");
    registerServerAdapter({ type: "hermes_local", execute: async () => ({ exitCode: 0, signal: null, timedOut: false }), testEnvironment: hermesSpy });
  });

  afterEach(async () => {
    const { registerServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    unregisterServerAdapter("hermes_local");
    if (previousHermes) registerServerAdapter(previousHermes);
  });

  const post = async (body: Record<string, unknown>) =>
    request(await createApp()).post("/api/companies/company-1/adapters/hermes_local/test-environment").send(body);

  it("tests an untouched draft as the server's Router default and returns the safe projection", async () => {
    const res = await post({ purpose: "create", adapterConfig: {} });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.createDefaults).toEqual({ provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: false });
    // The actual Router readiness test runs against the projected Router config.
    expect(hermesSpy).toHaveBeenCalledTimes(1);
    expect(hermesSpy.mock.calls[0][0].config).toMatchObject({ provider: "router", model: "auto-jev-routing" });
    // No deployment key: the platform secret is not even consulted.
    expect(mockSecretService.forecastPlatformDefaultCompanySecret).not.toHaveBeenCalled();
  });

  it("treats a typed auto model as unchosen", async () => {
    const res = await post({ purpose: "create", adapterConfig: { model: "auto" } });
    expect(res.body.createDefaults).toMatchObject({ source: "router_default", requiresRouterReadiness: true });
  });

  it("reports the platform OpenAI default without probing a vendor or leaking the key", async () => {
    platformKey.value = PLATFORM_KEY;
    const res = await post({ purpose: "create", adapterConfig: {} });
    expect(res.status).toBe(200);
    expect(res.body.createDefaults).toEqual({ provider: null, model: null, source: "platform_openai", requiresRouterReadiness: false, platformRouterKeyBound: false });
    expect(mockSecretService.forecastPlatformDefaultCompanySecret).toHaveBeenCalledWith("company-1", expect.objectContaining({ key: "openai_api_key" }));
    // Only the ordinary adapter test runs (no extra vendor probe), with the intent config unchanged.
    expect(hermesSpy).toHaveBeenCalledTimes(1);
    expect(hermesSpy.mock.calls[0][0].config.provider).toBeUndefined();
    expect(res.body.checks.map((c: { code: string }) => c.code)).toContain("create_defaults_platform_openai");
    expect(JSON.stringify(res.body)).not.toContain(PLATFORM_KEY);
  });

  it("applies the Router default when the platform secret would not actually bind", async () => {
    platformKey.value = PLATFORM_KEY;
    mockSecretService.forecastPlatformDefaultCompanySecret.mockResolvedValue({ outcome: "skipped_inactive_existing", wouldBind: false });
    const res = await post({ purpose: "create", adapterConfig: {} });
    expect(res.body.createDefaults).toMatchObject({ source: "router_default" });
  });

  it("counts a one-shot credential as a create credential, probes with it, and never returns it", async () => {
    const res = await post({ purpose: "create", adapterConfig: { provider: "router" }, testCredentials: { RAMP_ROUTER_API_KEY: ROUTER_KEY } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.createDefaults).toEqual({ provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: false });
    expect(hermesSpy.mock.calls[0][0].config.env).toEqual({ RAMP_ROUTER_API_KEY: ROUTER_KEY });
    expect(mockSecretService.normalizeAdapterConfigForPersistence.mock.calls[0]?.[1]).not.toHaveProperty("env");
    expect(JSON.stringify(res.body)).not.toContain(ROUTER_KEY);

    const untouchedWithKey = await post({ purpose: "create", adapterConfig: {}, testCredentials: { RAMP_ROUTER_API_KEY: ROUTER_KEY } });
    expect(untouchedWithKey.body.createDefaults).toMatchObject({ provider: null, source: "explicit_or_inferred" });
  });

  it("rejects a foreign environment before any forecast read", async () => {
    platformKey.value = PLATFORM_KEY;
    mockEnvironmentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111", companyId: "company-1", name: "Sandbox QA", driver: "sandbox", config: { provider: "fake-plugin" },
    });
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue(["company-2"]);
    const res = await post({ purpose: "create", adapterConfig: {}, environmentId: "11111111-1111-4111-8111-111111111111" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(JSON.stringify(res.body)).toContain("environment_company_mismatch");
    expect(readPlatformKeySpy).not.toHaveBeenCalled();
    expect(mockSecretService.forecastPlatformDefaultCompanySecret).not.toHaveBeenCalled();
    expect(hermesSpy).not.toHaveBeenCalled();
  });

  it("leaves the saved-agent/draft test unchanged and refuses purpose create with agentId", async () => {
    const plain = await post({ adapterConfig: {} });
    expect(plain.status).toBe(200);
    expect(plain.body).not.toHaveProperty("createDefaults");
    expect(hermesSpy.mock.calls[0][0].config.provider).toBeUndefined();
    expect(readPlatformKeySpy).not.toHaveBeenCalled();

    const combined = await post({ purpose: "create", agentId: "22222222-2222-4222-8222-222222222222", adapterConfig: {} });
    expect(combined.status).toBe(400);
  });

  it("returns no projection for an adapter without create-time defaults", async () => {
    const { registerServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    unregisterServerAdapter("external_test");
    const spy = vi.fn(async () => ({ adapterType: "external_test", status: "pass" as const, checks: [], testedAt: new Date(0).toISOString() }));
    registerServerAdapter({ type: "external_test", execute: async () => ({ exitCode: 0, signal: null, timedOut: false }), testEnvironment: spy });
    try {
      const res = await request(await createApp())
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({ purpose: "create", adapterConfig: {} });
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("createDefaults");
    } finally {
      unregisterServerAdapter("external_test");
    }
  });

  describe("platform Router key (TECH-7959)", () => {
    const PLATFORM_ROUTER_KEY = "rr-platform-router-key-never-leaks-7959-123456";
    // Mirrors the adapter's key gate: a Router config without RAMP_ROUTER_API_KEY reports it missing.
    const routerAwareSpy = async (ctx: { config: Record<string, unknown> }) => {
      const env = (ctx.config.env ?? {}) as Record<string, unknown>;
      const hasKey = typeof env.RAMP_ROUTER_API_KEY === "string" && env.RAMP_ROUTER_API_KEY.length > 0;
      return {
        adapterType: "hermes_local",
        status: hasKey ? "pass" : "fail",
        checks: [hasKey
          ? { code: "hermes_router_key_found", level: "info", message: "found" }
          : { code: "hermes_router_key_missing", level: "error", message: "missing" }],
        testedAt: new Date(0).toISOString(),
      };
    };

    it("tests the Router default with a fixed placeholder (never the real key) and reports the org key", async () => {
      routerPlatformKey.value = PLATFORM_ROUTER_KEY;
      platformKey.value = PLATFORM_KEY;
      hermesSpy.mockImplementation(routerAwareSpy);
      const res = await post({ purpose: "create", adapterConfig: {} });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.createDefaults).toEqual({
        provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: true,
      });
      // Create order: Router secret first, then OpenAI.
      expect(mockSecretService.forecastPlatformDefaultCompanySecret.mock.calls.map((call) => (call as unknown[])[1]))
        .toEqual([expect.objectContaining({ key: "ramp_router_api_key" }), expect.objectContaining({ key: "openai_api_key" })]);
      const tested = hermesSpy.mock.calls[0][0].config;
      expect(tested).toMatchObject({ provider: "router", model: "auto-jev-routing" });
      expect(tested.env.RAMP_ROUTER_API_KEY).toBe("paperclip-platform-router-key-not-tested");
      expect(tested.env.RAMP_ROUTER_API_KEY).not.toBe(PLATFORM_ROUTER_KEY);
      const codes = res.body.checks.map((c: { code: string }) => c.code);
      expect(codes).toContain("create_defaults_platform_router");
      expect(codes).not.toContain("hermes_router_key_missing");
      expect(codes).not.toContain("create_defaults_platform_openai");
      expect(res.body.status).toBe("pass");
      expect(JSON.stringify(res.body)).not.toContain(PLATFORM_ROUTER_KEY);
      expect(JSON.stringify(res.body)).not.toContain(PLATFORM_KEY);
      // Persistence normalization never sees the placeholder.
      for (const call of mockSecretService.normalizeAdapterConfigForPersistence.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("paperclip-platform-router-key-not-tested");
      }
    });

    it("injects nothing when the Router secret would be skipped (today's behavior)", async () => {
      routerPlatformKey.value = PLATFORM_ROUTER_KEY;
      mockSecretService.forecastPlatformDefaultCompanySecret.mockResolvedValue({ outcome: "skipped_name_conflict", wouldBind: false });
      hermesSpy.mockImplementation(routerAwareSpy);
      const res = await post({ purpose: "create", adapterConfig: {} });
      expect(res.body.createDefaults).toMatchObject({ source: "router_default", platformRouterKeyBound: false });
      expect(hermesSpy.mock.calls[0][0].config.env?.RAMP_ROUTER_API_KEY).toBeUndefined();
      const codes = res.body.checks.map((c: { code: string }) => c.code);
      expect(codes).not.toContain("create_defaults_platform_router");
      expect(codes).toContain("hermes_router_key_missing");
    });

    it("keeps an explicit blank Router key (no platform binding, no placeholder)", async () => {
      routerPlatformKey.value = PLATFORM_ROUTER_KEY;
      hermesSpy.mockImplementation(routerAwareSpy);
      const res = await post({ purpose: "create", adapterConfig: { provider: "router", env: { RAMP_ROUTER_API_KEY: "" } } });
      expect(res.body.createDefaults).toMatchObject({ platformRouterKeyBound: false });
      expect(mockSecretService.forecastPlatformDefaultCompanySecret).not.toHaveBeenCalledWith("company-1", expect.objectContaining({ key: "ramp_router_api_key" }));
      expect(hermesSpy.mock.calls[0][0].config.env?.RAMP_ROUTER_API_KEY).not.toBe("paperclip-platform-router-key-not-tested");
    });

    it("reports the org Router key in the synthesized (no execution target) branch too", async () => {
      routerPlatformKey.value = PLATFORM_ROUTER_KEY;
      mockEnvironmentService.getById.mockResolvedValue(null);
      const res = await post({ purpose: "create", adapterConfig: {}, environmentId: "33333333-3333-4333-8333-333333333333" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(hermesSpy).not.toHaveBeenCalled();
      const codes = res.body.checks.map((c: { code: string }) => c.code);
      expect(codes).toContain("environment_not_found");
      expect(codes).toContain("create_defaults_platform_router");
      expect(res.body.createDefaults).toMatchObject({ platformRouterKeyBound: true });
      expect(JSON.stringify(res.body)).not.toContain(PLATFORM_ROUTER_KEY);
    });
  });
});

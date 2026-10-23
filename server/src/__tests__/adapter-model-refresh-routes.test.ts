import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as openCodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import type { ServerAdapterModule } from "../adapters/index.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockListOpenCodeModels = vi.hoisted(() => vi.fn());
const mockListOpenRouterModels = vi.hoisted(() => vi.fn());

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>("@paperclipai/adapter-opencode-local/server");
    return {
      ...actual,
      listOpenCodeModels: mockListOpenCodeModels,
    };
  });

  vi.doMock("../services/openrouter-models.js", () => ({
    listOpenRouterModels: mockListOpenRouterModels,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => ({}),
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
}

const refreshableAdapterType = "refreshable_adapter_route_test";

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}

describe("adapter model refresh route", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.getById.mockResolvedValue(null);
    mockListOpenCodeModels.mockReset();
    mockListOpenCodeModels.mockResolvedValue([{ id: "dynamic-opencode-model", label: "dynamic-opencode-model" }]);
    mockListOpenRouterModels.mockReset();
    mockListOpenRouterModels.mockResolvedValue([{ id: "openrouter/mock/model", label: "Mock model" }]);
    await unregisterTestAdapter(refreshableAdapterType);
  });

  afterEach(async () => {
    await unregisterTestAdapter(refreshableAdapterType);
  });

  it("uses refreshModels when refresh=1 is requested", async () => {
    const listModels = vi.fn(async () => [{ id: "stale-model", label: "stale-model" }]);
    const refreshModels = vi.fn(async () => [{ id: "fresh-model", label: "fresh-model" }]);
    const { registerServerAdapter } = await import("../adapters/index.js");
    const adapter: ServerAdapterModule = {
      type: refreshableAdapterType,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: refreshableAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      listModels,
      refreshModels,
    };
    registerServerAdapter(adapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/company-1/adapters/${refreshableAdapterType}/models?refresh=1`),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([{ id: "fresh-model", label: "fresh-model" }]);
    expect(refreshModels).toHaveBeenCalledTimes(1);
    expect(listModels).not.toHaveBeenCalled();
  });

  it("skips OpenCode model discovery for non-local environments", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      companyId: "company-1",
      name: "Remote SSH",
      driver: "ssh",
      config: {},
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/adapters/opencode_local/models?environmentId=env-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(openCodeFallbackModels);
    expect(mockListOpenCodeModels).not.toHaveBeenCalled();
  });

  it("keeps OpenCode model discovery enabled for local environments", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      companyId: "company-1",
      name: "Local",
      driver: "local",
      config: {},
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/adapters/opencode_local/models?environmentId=env-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([{ id: "dynamic-opencode-model", label: "dynamic-opencode-model" }]);
    expect(mockListOpenCodeModels).toHaveBeenCalledTimes(1);
  });

  describe("Hermes Local provider model catalog", () => {
    const hermesModels = (baseUrl: string, query: string) =>
      request(baseUrl).get(`/api/companies/company-1/adapters/hermes_local/models${query}`);
    // The model IDs the OpenAI API accepts out of the existing Codex catalog. `codex-mini-latest` is a
    // Codex CLI alias, not an API model ID, so it must never be offered for the OpenAI provider.
    const openAiApiIds = [
      "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini",
      "gpt-5", "gpt-5-mini", "gpt-5-nano", "o3", "o4-mini", "o3-mini",
    ];

    it("serves the existing static Claude catalog for the anthropic provider", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=anthropic"));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body).toEqual(claudeModels);
        expect(mockListOpenRouterModels).not.toHaveBeenCalled();
        expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("serves only API-compatible IDs from the existing Codex catalog for the openai provider", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=openai"));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const ids = (res.body as Array<{ id: string }>).map((model) => model.id);
        expect([...ids].sort()).toEqual([...openAiApiIds].sort());
        expect(ids).not.toContain("codex-mini-latest");
        // Every offered ID already exists in the Codex adapter catalog; none are invented here.
        const catalogIds = new Set(codexModels.map((model) => model.id));
        expect(ids.every((id) => catalogIds.has(id))).toBe(true);
        expect(res.body).not.toEqual(codexModels);
        expect(mockListOpenRouterModels).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("delegates the openrouter provider to the existing OpenRouter discovery", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=openrouter"));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([{ id: "mock/model", label: "Mock model" }]);
      expect(mockListOpenRouterModels).toHaveBeenCalledWith(false);

      const refreshed = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=openrouter&refresh=1"));
      expect(refreshed.status).toBe(200);
      expect(mockListOpenRouterModels).toHaveBeenLastCalledWith(true);
    });

    it("serves native OpenRouter IDs by stripping exactly one prefix without mutating the shared catalog", async () => {
      const shared = [
        { id: "openrouter/anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "openrouter/openrouter/free", label: "Free" },
        { id: "already/native", label: "Native" },
      ];
      const snapshot = structuredClone(shared);
      mockListOpenRouterModels.mockResolvedValue(shared);
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=openrouter"));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([
        { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "openrouter/free", label: "Free" },
        { id: "already/native", label: "Native" },
      ]);
      expect(shared).toEqual(snapshot);

      mockListOpenRouterModels.mockResolvedValue([]);
      const empty = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=openrouter"));
      expect(empty.body).toEqual([]);
    });

    it("matches the provider case-insensitively", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=%20Anthropic%20"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual(claudeModels);
    });

    it.each(["", "?provider=", "?provider=%20", "?provider=zai", "?provider=groq", "?provider=ollama", "?provider=kimi-coding"])(
      "falls back to the registry list (empty by default) without a cataloged provider (%s)",
      async (query) => {
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) => hermesModels(baseUrl, query));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toEqual([]);
        expect(mockListOpenRouterModels).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["a repeated provider", "?provider=anthropic&provider=openai"],
      ["a provider with a path", "?provider=..%2Fetc"],
      ["a provider with a URL", "?provider=https%3A%2F%2Fexample.com"],
      ["a provider with spaces", "?provider=open%20ai"],
      ["an overlong provider", `?provider=${"a".repeat(65)}`],
    ])("rejects %s with 400", async (_name, query) => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => hermesModels(baseUrl, query));
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(mockListOpenRouterModels).not.toHaveBeenCalled();
    });

    it("keeps the company access guard ahead of provider validation and routing", async () => {
      // local_implicit boards bypass the company check, so use a scoped session board.
      const app = await createApp({
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "session",
        isInstanceAdmin: false,
      });
      const forbidden = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-2/adapters/hermes_local/models?provider=anthropic"),
      );
      expect(forbidden.status).toBe(403);
      const forbiddenMalformed = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-2/adapters/hermes_local/models?provider=a&provider=b"),
      );
      expect(forbiddenMalformed.status).toBe(403);

      const unauthenticated = await createApp({ type: "none", source: "none" });
      const denied = await requestApp(unauthenticated, (baseUrl) => hermesModels(baseUrl, "?provider=anthropic"));
      expect(denied.status).toBe(401);
      expect(mockListOpenRouterModels).not.toHaveBeenCalled();
    });

    describe("registry fallback without a cataloged provider", () => {
      const declared = [{ id: "declared-hermes", label: "Declared Hermes" }];
      const declaredEnv = JSON.stringify({
        hermes_local: declared,
        claude_local: [{ id: "declared-claude", label: "Declared Claude" }],
      });

      beforeEach(() => {
        process.env.PAPERCLIP_ADAPTER_MODELS = declaredEnv;
      });
      afterEach(async () => {
        delete process.env.PAPERCLIP_ADAPTER_MODELS;
        await unregisterTestAdapter("hermes_local");
      });

      it.each(["", "?provider=", "?provider=%20", "?provider=zai", "?provider=kimi-coding", "?provider=ollama"])(
        "serves the operator-declared Hermes models (%s)",
        async (query) => {
          const app = await createApp();
          const res = await requestApp(app, (baseUrl) => hermesModels(baseUrl, query));
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(res.body).toEqual(declared);
          expect(mockListOpenRouterModels).not.toHaveBeenCalled();
        },
      );

      it("does not let a declared list replace a provider's own catalog", async () => {
        const app = await createApp();
        const anthropic = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=anthropic"));
        expect(anthropic.body).toEqual(claudeModels);
        const openai = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=openai"));
        expect((openai.body as Array<{ id: string }>).map((model) => model.id).sort()).toEqual([...openAiApiIds].sort());
      });

      it("keeps an empty OpenRouter discovery empty and propagates its errors instead of falling back", async () => {
        const app = await createApp();
        mockListOpenRouterModels.mockResolvedValue([]);
        const empty = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=openrouter"));
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual([]);

        mockListOpenRouterModels.mockRejectedValue(new Error("discovery failed"));
        const failed = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=openrouter"));
        expect(failed.status).toBe(500);
        expect(failed.body).not.toEqual(declared);
      });

      it("honors an active adapter override for list and refresh without a provider", async () => {
        delete process.env.PAPERCLIP_ADAPTER_MODELS;
        const listModels = vi.fn(async () => [{ id: "override-listed", label: "Listed" }]);
        const refreshModels = vi.fn(async () => [{ id: "override-refreshed", label: "Refreshed" }]);
        const { registerServerAdapter } = await import("../adapters/index.js");
        registerServerAdapter({
          type: "hermes_local",
          execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
          testEnvironment: async () => ({
            adapterType: "hermes_local",
            status: "pass",
            checks: [],
            testedAt: new Date(0).toISOString(),
          }),
          listModels,
          refreshModels,
        });
        const app = await createApp();

        const listed = await requestApp(app, (baseUrl) => hermesModels(baseUrl, ""));
        expect(listed.body).toEqual([{ id: "override-listed", label: "Listed" }]);
        const refreshed = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?refresh=1"));
        expect(refreshed.body).toEqual([{ id: "override-refreshed", label: "Refreshed" }]);
        expect(refreshModels).toHaveBeenCalledTimes(1);
        const zai = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=zai&refresh=1"));
        expect(zai.body).toEqual([{ id: "override-refreshed", label: "Refreshed" }]);

        // A cataloged provider is still served from its own catalog, not the override.
        const anthropic = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=anthropic"));
        expect(anthropic.body).toEqual(claudeModels);
      });

      it("rejects a malformed provider and an unauthorized company before any registry lookup", async () => {
        const app = await createApp();
        const malformed = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=a&provider=b"));
        expect(malformed.status).toBe(400);
        const invalid = await requestApp(app, (baseUrl) => hermesModels(baseUrl, "?provider=..%2Fetc"));
        expect(invalid.status).toBe(400);
        const scoped = await createApp({
          type: "board",
          userId: "user-1",
          companyIds: ["company-1"],
          source: "session",
          isInstanceAdmin: false,
        });
        const forbidden = await requestApp(scoped, (baseUrl) =>
          request(baseUrl).get("/api/companies/company-2/adapters/hermes_local/models"),
        );
        expect(forbidden.status).toBe(403);
      });

      it("leaves other adapters on their existing declared-model behavior", async () => {
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) =>
          request(baseUrl).get("/api/companies/company-1/adapters/claude_local/models?provider=openai"),
        );
        expect(res.body).toEqual([{ id: "declared-claude", label: "Declared Claude" }]);
      });
    });

    it("still rejects an unknown adapter type before provider routing", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-1/adapters/not_an_adapter/models?provider=anthropic"),
      );
      expect(res.status).toBe(422);
    });

    it("does not apply Hermes provider routing to other adapters", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-1/adapters/claude_local/models?provider=openai"),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual(claudeModels);
    });
  });
});

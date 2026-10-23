import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));
const mockResync = vi.hoisted(() => vi.fn());
const stub = () => ({});

vi.mock("@paperclipai/shared/telemetry", () => ({ trackAgentCreated: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

vi.mock("../services/comms-catalog-resync.js", async () => {
  const actual = await vi.importActual<typeof import("../services/comms-catalog-resync.js")>("../services/comms-catalog-resync.js");
  return { ...actual, resyncCommsCatalogs: mockResync };
});

vi.mock("../services/index.js", () => ({
  agentService: stub,
  agentInstructionsService: stub,
  accessService: () => mockAccessService,
  approvalService: stub,
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: stub,
  budgetService: stub,
  heartbeatService: stub,
  issueApprovalService: stub,
  issueService: stub,
  logActivity: vi.fn(),
  secretService: stub,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: stub,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([import("../middleware/index.js"), import("../routes/agents.js")]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor, companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function post(app: express.Express, body: unknown, id = companyId, route = "comms-catalog-resync") {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return await request(`http://127.0.0.1:${address.port}`).post(`/api/companies/${id}/default-mcp/${route}`).send(body as object);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const member = (role: string | null, extra: Record<string, unknown> = {}) => ({
  type: "board",
  userId: "board-user",
  companyIds: [companyId],
  memberships: role ? [{ companyId, status: "active", membershipRole: role }] : [],
  source: "session",
  isInstanceAdmin: false,
  ...extra,
});

describe.sequential("POST /companies/:companyId/default-mcp/comms-catalog-resync", () => {
  beforeEach(() => {
    mockResync.mockReset();
    mockResync.mockResolvedValue({ dryRun: true, scanned: 0, outcomes: [], counts: {}, nextCursor: null });
    mockAccessService.hasPermission.mockReset();
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("rejects non-board actors, cross-company access and non-managers without calling the service", async () => {
    expect((await post(await createApp({ type: "agent", agentId: "a", companyId, source: "agent_key" }), {})).status).toBe(403);
    expect((await post(await createApp(member("owner")), {}, otherCompanyId)).status).toBe(403);
    expect((await post(await createApp(member("member")), {})).status).toBe(403);
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("allows an owner, an admin, an instance admin and a tools:manage_connections holder; defaults to a dry run", async () => {
    for (const actor of [member("owner"), member("admin"), member(null, { isInstanceAdmin: true })]) {
      mockResync.mockClear();
      const res = await post(await createApp(actor), {});
      expect(res.status).toBe(200);
      expect(mockResync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId, dryRun: true }));
    }
    mockResync.mockClear();
    mockAccessService.hasPermission.mockResolvedValue(true);
    expect((await post(await createApp(member("member")), {})).status).toBe(200);
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(companyId, "user", "board-user", "tools:manage_connections");
  });

  it("validates the body and maps a missing confirmation to 400 and a concurrent run to 409", async () => {
    const app = await createApp(member("owner"));
    expect((await post(app, { dryRun: "no" })).status).toBe(400);
    expect((await post(app, { confirm: 5 })).status).toBe(400);
    expect((await post(app, { limit: 0 })).status).toBe(400);
    expect((await post(app, { limit: 26 })).status).toBe(400);
    expect((await post(app, { afterId: "nope" })).status).toBe(400);
    const { CommsCatalogResyncConfirmationError, CommsCatalogResyncInProgressError } = await import("../services/comms-catalog-resync.js");
    mockResync.mockRejectedValueOnce(new CommsCatalogResyncConfirmationError());
    expect((await post(app, { dryRun: false })).status).toBe(400);
    mockResync.mockRejectedValueOnce(new CommsCatalogResyncInProgressError());
    expect((await post(app, { dryRun: false, confirm: "x" })).status).toBe(409);
  });

  it("passes confirm, limit and afterId through for a real run", async () => {
    const afterId = "44444444-4444-4444-8444-444444444444";
    const res = await post(await createApp(member("owner")), { dryRun: false, confirm: "resync-comms-board-catalogs", limit: 5, afterId });
    expect(res.status).toBe(200);
    expect(mockResync).toHaveBeenCalledWith(expect.anything(), { companyId, dryRun: false, confirm: "resync-comms-board-catalogs", limit: 5, afterId });
  });
});

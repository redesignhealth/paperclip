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
const mockSync = vi.hoisted(() => vi.fn());
const stub = () => ({});

vi.mock("@paperclipai/shared/telemetry", () => ({ trackAgentCreated: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

vi.mock("../services/comms-owner-sync.js", async () => {
  const actual = await vi.importActual<typeof import("../services/comms-owner-sync.js")>("../services/comms-owner-sync.js");
  return { ...actual, syncCommsOwner: mockSync };
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

async function post(app: express.Express, body: unknown, id = companyId, route = "comms-owner-sync") {
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

const agentA = "55555555-5555-4555-8555-555555555555";
const agentB = "66666666-6666-4666-8666-666666666666";

describe("POST /companies/:companyId/default-mcp/comms-owner-sync", { sequential: true }, () => {
  beforeEach(() => {
    mockSync.mockReset();
    mockSync.mockResolvedValue({ dryRun: true, scanned: 0, outcomes: [], counts: {}, nextCursor: null });
    mockAccessService.hasPermission.mockReset();
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("rejects agents, cross-company access and non-managers without calling the service", async () => {
    expect((await post(await createApp({ type: "agent", agentId: "a", companyId, source: "agent_key" }), {})).status).toBe(403);
    expect((await post(await createApp(member("owner")), {}, otherCompanyId)).status).toBe(403);
    expect((await post(await createApp(member("member")), {})).status).toBe(403);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("allows managers and defaults to a dry run", async () => {
    for (const actor of [member("owner"), member("admin"), member(null, { isInstanceAdmin: true })]) {
      mockSync.mockClear();
      const res = await post(await createApp(actor), {});
      expect(res.status).toBe(200);
      expect(mockSync).toHaveBeenCalledWith(expect.anything(), { companyId, dryRun: true, confirm: undefined, limit: undefined, afterId: undefined });
    }
  });

  it("allows a member holding tools:manage_connections", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    expect((await post(await createApp(member("member")), {})).status).toBe(200);
  });

  it("never passes an owner from the body to the service", async () => {
    await post(await createApp(member("owner")), { ownerUserId: "attacker", owner: "attacker", newOwnerEmail: "x@y.z" });
    const options = mockSync.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(options).sort()).toEqual(["afterId", "companyId", "confirm", "dryRun", "limit"]);
  });

  it("validates dryRun, confirm, limit and afterId", async () => {
    const app = await createApp(member("owner"));
    expect((await post(app, { dryRun: "no" })).status).toBe(400);
    expect((await post(app, { confirm: 5 })).status).toBe(400);
    expect((await post(app, { limit: 0 })).status).toBe(400);
    expect((await post(app, { limit: 26 })).status).toBe(400);
    expect((await post(app, { limit: 1.5 })).status).toBe(400);
    expect((await post(app, { afterId: "nope" })).status).toBe(400);
    expect(mockSync).not.toHaveBeenCalled();
    expect((await post(app, { limit: 25, afterId: agentA })).status).toBe(200);
  });

  it("maps a missing confirmation to 400, a concurrent run to 409, and passes the confirmation through", async () => {
    const app = await createApp(member("owner"));
    const { CommsOwnerSyncConfirmationError, CommsOwnerSyncInProgressError } = await import("../services/comms-owner-sync.js");
    mockSync.mockRejectedValueOnce(new CommsOwnerSyncConfirmationError());
    expect((await post(app, { dryRun: false })).status).toBe(400);
    mockSync.mockRejectedValueOnce(new CommsOwnerSyncInProgressError());
    expect((await post(app, { dryRun: false, confirm: "sync-comms-board-owner" })).status).toBe(409);
    mockSync.mockClear();
    expect((await post(app, { dryRun: false, confirm: "sync-comms-board-owner" })).status).toBe(200);
    expect(mockSync).toHaveBeenCalledWith(expect.anything(), { companyId, dryRun: false, confirm: "sync-comms-board-owner", limit: undefined, afterId: undefined });
  });
});

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
const mockShared = vi.hoisted(() => vi.fn());
const mockVisibility = vi.hoisted(() => vi.fn());
const stub = () => ({});

vi.mock("@paperclipai/shared/telemetry", () => ({ trackAgentCreated: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

vi.mock("../services/comms-shared-sync.js", async () => {
  const actual = await vi.importActual<typeof import("../services/comms-shared-sync.js")>("../services/comms-shared-sync.js");
  return { ...actual, syncCommsShared: mockShared };
});

vi.mock("../services/company-visibility-backfill.js", async () => {
  const actual = await vi.importActual<typeof import("../services/company-visibility-backfill.js")>("../services/company-visibility-backfill.js");
  return { ...actual, backfillCompanyVisibility: mockVisibility };
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

async function post(app: express.Express, body: unknown, id = companyId, path = "default-mcp/comms-shared-sync") {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return await request(`http://127.0.0.1:${address.port}`).post(`/api/companies/${id}/${path}`).send(body as object);
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

describe.sequential("POST /companies/:companyId/default-mcp/comms-shared-sync", () => {
  beforeEach(() => {
    mockShared.mockReset();
    mockShared.mockResolvedValue({ dryRun: true, scanned: 0, outcomes: [], counts: {}, nextCursor: null });
    mockAccessService.hasPermission.mockReset();
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("rejects non-board actors, cross-company access and non-managers without calling the service", async () => {
    expect((await post(await createApp({ type: "agent", agentId: "a", companyId, source: "agent_key" }), {})).status).toBe(403);
    expect((await post(await createApp(member("owner")), {}, otherCompanyId)).status).toBe(403);
    expect((await post(await createApp(member("member")), {})).status).toBe(403);
    expect(mockShared).not.toHaveBeenCalled();
  });

  it("allows an owner, an admin, an instance admin and a tools:manage_connections holder; defaults to a dry run", async () => {
    for (const actor of [member("owner"), member("admin"), member(null, { isInstanceAdmin: true })]) {
      mockShared.mockClear();
      const res = await post(await createApp(actor), {});
      expect(res.status).toBe(200);
      expect(mockShared).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId, dryRun: true }));
    }
    mockShared.mockClear();
    mockAccessService.hasPermission.mockResolvedValue(true);
    expect((await post(await createApp(member("member")), {})).status).toBe(200);
  });

  it("validates the body and maps a missing confirmation to 400 and a concurrent run to 409", async () => {
    const app = await createApp(member("owner"));
    expect((await post(app, { dryRun: "no" })).status).toBe(400);
    expect((await post(app, { confirm: 5 })).status).toBe(400);
    expect((await post(app, { limit: 0 })).status).toBe(400);
    expect((await post(app, { limit: 26 })).status).toBe(400);
    expect((await post(app, { afterId: "nope" })).status).toBe(400);
    const { CommsSharedSyncConfirmationError, CommsSharedSyncInProgressError } = await import("../services/comms-shared-sync.js");
    mockShared.mockRejectedValueOnce(new CommsSharedSyncConfirmationError());
    expect((await post(app, { dryRun: false })).status).toBe(400);
    mockShared.mockRejectedValueOnce(new CommsSharedSyncInProgressError());
    expect((await post(app, { dryRun: false, confirm: "x" })).status).toBe(409);
  });

  it("passes confirm, limit and afterId through for a real run", async () => {
    const afterId = "44444444-4444-4444-8444-444444444444";
    const res = await post(await createApp(member("owner")), { dryRun: false, confirm: "sync-comms-board-shared", limit: 5, afterId });
    expect(res.status).toBe(200);
    expect(mockShared).toHaveBeenCalledWith(expect.anything(), { companyId, dryRun: false, confirm: "sync-comms-board-shared", limit: 5, afterId });
  });
});

describe.sequential("POST /companies/:companyId/visibility-backfill", () => {
  const visibilityPost = (app: express.Express, body: unknown, id = companyId) => post(app, body, id, "visibility-backfill");
  beforeEach(() => {
    mockVisibility.mockReset();
    mockVisibility.mockResolvedValue({ dryRun: true, companyId, requested: "shared", before: null, after: "shared", result: "would_set" });
  });

  it("allows only an owner or an instance admin (an admin or manager is not enough); rejects non-board and cross-company", async () => {
    expect((await visibilityPost(await createApp({ type: "agent", agentId: "a", companyId, source: "agent_key" }), { visibility: "shared" })).status).toBe(403);
    expect((await visibilityPost(await createApp(member("owner")), { visibility: "shared" }, otherCompanyId)).status).toBe(403);
    expect((await visibilityPost(await createApp(member("admin")), { visibility: "shared" })).status).toBe(403);
    expect((await visibilityPost(await createApp(member("member")), { visibility: "shared" })).status).toBe(403);
    expect(mockVisibility).not.toHaveBeenCalled();
    expect((await visibilityPost(await createApp(member("owner")), { visibility: "shared" })).status).toBe(200);
    expect((await visibilityPost(await createApp(member(null, { isInstanceAdmin: true })), { visibility: "private" })).status).toBe(200);
  });

  it("requires a valid visibility, validates types, defaults to a dry run and maps a missing confirmation to 400", async () => {
    const app = await createApp(member("owner"));
    expect((await visibilityPost(app, {})).status).toBe(400);
    expect((await visibilityPost(app, { visibility: "public" })).status).toBe(400);
    expect((await visibilityPost(app, { visibility: "shared", dryRun: "no" })).status).toBe(400);
    expect((await visibilityPost(app, { visibility: "shared", confirm: 5 })).status).toBe(400);
    expect((await visibilityPost(app, { visibility: "shared", allowNarrowing: "yes" })).status).toBe(400);
    expect(mockVisibility).not.toHaveBeenCalled();
    await visibilityPost(app, { visibility: "shared" });
    expect(mockVisibility).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId, visibility: "shared", dryRun: true, allowNarrowing: false }));
    const { CompanyVisibilityConfirmationError } = await import("../services/company-visibility-backfill.js");
    mockVisibility.mockRejectedValueOnce(new CompanyVisibilityConfirmationError());
    expect((await visibilityPost(app, { visibility: "shared", dryRun: false })).status).toBe(400);
  });

  it("passes confirm and allowNarrowing through for a real run, with the acting user", async () => {
    const res = await visibilityPost(await createApp(member("owner")), { visibility: "private", dryRun: false, confirm: "set-company-visibility", allowNarrowing: true });
    expect(res.status).toBe(200);
    expect(mockVisibility).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId, visibility: "private", dryRun: false, confirm: "set-company-visibility", allowNarrowing: true, actor: expect.objectContaining({ actorType: "user" }) }));
  });
});

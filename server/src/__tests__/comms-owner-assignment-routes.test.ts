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
const mockAssign = vi.hoisted(() => vi.fn());
const stub = () => ({});

vi.mock("@paperclipai/shared/telemetry", () => ({ trackAgentCreated: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

vi.mock("../services/comms-owner-assignment.js", async () => {
  const actual = await vi.importActual<typeof import("../services/comms-owner-assignment.js")>("../services/comms-owner-assignment.js");
  return { ...actual, assignCommsBoardOwner: mockAssign };
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

async function post(app: express.Express, body: unknown, id = companyId, route = "comms-owner-assignment") {
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

describe("POST /companies/:companyId/default-mcp/comms-owner-assignment", { sequential: true }, () => {
  beforeEach(() => {
    mockAssign.mockReset();
    mockAssign.mockResolvedValue({ dryRun: true, scanned: 0, outcomes: [], counts: {} });
    mockAccessService.hasPermission.mockReset();
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("rejects agents, cross-company access and non-managers without calling the service", async () => {
    expect((await post(await createApp({ type: "agent", agentId: "a", companyId, source: "agent_key" }), { agentIds: [agentA] })).status).toBe(403);
    expect((await post(await createApp(member("owner")), { agentIds: [agentA] }, otherCompanyId)).status).toBe(403);
    expect((await post(await createApp(member("member")), { agentIds: [agentA] })).status).toBe(403);
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("allows managers, defaults to a dry run and always passes the authenticated user as the owner", async () => {
    for (const actor of [member("owner"), member("admin"), member(null, { isInstanceAdmin: true })]) {
      mockAssign.mockClear();
      const res = await post(await createApp(actor), { agentIds: [agentA, agentB] });
      expect(res.status).toBe(200);
      expect(mockAssign).toHaveBeenCalledWith(expect.anything(), { companyId, ownerUserId: "board-user", agentIds: [agentA, agentB], dryRun: true, confirm: undefined });
    }
  });

  it("ignores an owner supplied in the body", async () => {
    await post(await createApp(member("owner")), { agentIds: [agentA], ownerUserId: "attacker", owner: "attacker" });
    expect(mockAssign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerUserId: "board-user" }));
  });

  it("requires an explicit, valid agentIds list and validates the other fields", async () => {
    const app = await createApp(member("owner"));
    expect((await post(app, {})).status).toBe(400);
    expect((await post(app, { agentIds: [] })).status).toBe(400);
    expect((await post(app, { agentIds: ["nope"] })).status).toBe(400);
    expect((await post(app, { agentIds: Array.from({ length: 26 }, () => agentA) })).status).toBe(400);
    expect((await post(app, { agentIds: [agentA], dryRun: "no" })).status).toBe(400);
    expect((await post(app, { agentIds: [agentA], confirm: 5 })).status).toBe(400);
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("maps a missing confirmation to 400 and passes the confirmation through for a real run", async () => {
    const app = await createApp(member("owner"));
    const { CommsOwnerAssignmentConfirmationError } = await import("../services/comms-owner-assignment.js");
    mockAssign.mockRejectedValueOnce(new CommsOwnerAssignmentConfirmationError());
    expect((await post(app, { agentIds: [agentA], dryRun: false })).status).toBe(400);
    mockAssign.mockClear();
    expect((await post(app, { agentIds: [agentA], dryRun: false, confirm: "assign-comms-board-owner" })).status).toBe(200);
    expect(mockAssign).toHaveBeenCalledWith(expect.anything(), { companyId, ownerUserId: "board-user", agentIds: [agentA], dryRun: false, confirm: "assign-comms-board-owner" });
  });
});

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
const mockReprovision = vi.hoisted(() => vi.fn());
const stub = () => ({});

vi.mock("@paperclipai/shared/telemetry", () => ({ trackAgentCreated: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

vi.mock("../services/comms-template-reprovision.js", async () => {
  const actual = await vi.importActual<typeof import("../services/comms-template-reprovision.js")>("../services/comms-template-reprovision.js");
  return { ...actual, reprovisionCommsTemplate: mockReprovision };
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

async function post(app: express.Express, body: unknown, id = companyId, route = "comms-template-reprovision") {
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

describe("POST /companies/:companyId/default-mcp/comms-template-reprovision", { sequential: true }, () => {
  beforeEach(() => {
    mockReprovision.mockReset();
    mockReprovision.mockResolvedValue({ dryRun: true, companyId, result: "would_restore", agentsLeftUntouched: 0 });
    mockAccessService.hasPermission.mockReset();
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("is instance-admin only: owners, admins, agents and other companies are refused without calling the service", async () => {
    expect((await post(await createApp({ type: "agent", agentId: "a", companyId, source: "agent_key" }), {})).status).toBe(403);
    expect((await post(await createApp(member("owner")), {})).status).toBe(403);
    expect((await post(await createApp(member("admin")), {})).status).toBe(403);
    expect((await post(await createApp(member(null, { isInstanceAdmin: true })), {}, otherCompanyId)).status).toBe(403);
    expect(mockReprovision).not.toHaveBeenCalled();
  });

  it("defaults to a dry run for an instance admin and passes the confirmation through for a real run", async () => {
    const app = await createApp(member(null, { isInstanceAdmin: true }));
    expect((await post(app, {})).status).toBe(200);
    expect(mockReprovision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId, dryRun: true }));
    mockReprovision.mockClear();
    expect((await post(app, { dryRun: false, confirm: "reprovision-comms-board-template" })).status).toBe(200);
    expect(mockReprovision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId, dryRun: false, confirm: "reprovision-comms-board-template" }));
  });

  it("validates the body and maps a missing confirmation to 400 and a concurrent run to 409", async () => {
    const app = await createApp(member(null, { isInstanceAdmin: true }));
    expect((await post(app, { dryRun: "no" })).status).toBe(400);
    expect((await post(app, { confirm: 5 })).status).toBe(400);
    const { CommsTemplateReprovisionConfirmationError, CommsTemplateReprovisionInProgressError } = await import("../services/comms-template-reprovision.js");
    mockReprovision.mockRejectedValueOnce(new CommsTemplateReprovisionConfirmationError());
    expect((await post(app, { dryRun: false })).status).toBe(400);
    mockReprovision.mockRejectedValueOnce(new CommsTemplateReprovisionInProgressError());
    expect((await post(app, { dryRun: false, confirm: "x" })).status).toBe(409);
  });
});

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({ ensureMembership: vi.fn() }));
const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => ({ list: vi.fn() }),
  companyPortabilityService: () => ({ exportBundle: vi.fn(), previewExport: vi.fn(), previewImport: vi.fn(), importBundle: vi.fn() }),
  companyService: () => mockCompanyService,
  feedbackService: () => ({ listIssueVotesForUser: vi.fn(), listFeedbackTraces: vi.fn(), getFeedbackTraceById: vi.fn(), saveIssueVote: vi.fn() }),
  instanceSettingsService: () => ({ getExperimental: vi.fn() }),
  logActivity: mockLogActivity,
}));

const company = { id: "company-1", name: "Paperclip", status: "active", requireBoardApprovalForNewAgents: false, commsBoardWakeEnabled: false };

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardMember = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
};

describe("PATCH /api/companies/:companyId commsBoardWakeEnabled (TECH-9912)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue(company);
    mockCompanyService.update.mockImplementation(async (_id: string, body: Record<string, unknown>) => ({ ...company, ...body }));
  });

  it("lets an instance admin turn the setting on and off", async () => {
    const app = await createApp({ ...boardMember, isInstanceAdmin: true });
    const on = await request(app).patch("/api/companies/company-1").send({ commsBoardWakeEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.commsBoardWakeEnabled).toBe(true);
    expect(mockCompanyService.update).toHaveBeenLastCalledWith("company-1", { commsBoardWakeEnabled: true }, expect.anything());
    const off = await request(app).patch("/api/companies/company-1").send({ commsBoardWakeEnabled: false });
    expect(off.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenLastCalledWith("company-1", { commsBoardWakeEnabled: false }, expect.anything());
  });

  it("refuses a board member of the company who is not an instance admin", async () => {
    const app = await createApp(boardMember);
    const res = await request(app).patch("/api/companies/company-1").send({ commsBoardWakeEnabled: true });
    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("still lets that member change other settings", async () => {
    const app = await createApp(boardMember);
    const res = await request(app).patch("/api/companies/company-1").send({ requireBoardApprovalForNewAgents: true });
    expect(res.status).toBe(200);
  });

  it("refuses a CEO agent, which can only change branding", async () => {
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1", role: "ceo" });
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key", runId: "run-1" });
    const res = await request(app).patch("/api/companies/company-1").send({ commsBoardWakeEnabled: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});

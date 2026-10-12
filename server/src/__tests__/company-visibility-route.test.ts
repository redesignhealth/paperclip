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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanyArtifactsService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => mockCompanyArtifactsService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  instanceSettingsService: () => ({
    getExperimental: vi.fn(),
  }),
  logActivity: mockLogActivity,
}));

function createCompany(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    visibility: "private",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

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

const boardActor = { type: "board", source: "local_implicit", userId: "user-1", companyIds: ["company-1"] };

describe("POST /api/companies (TECH-7390 visibility)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("rejects a create request with no visibility", async () => {
    const app = await createApp(boardActor);

    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(400);
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("rejects a create request with an invalid visibility value", async () => {
    const app = await createApp(boardActor);

    const res = await request(app)
      .post("/api/companies")
      .send({ name: "Acme", visibility: "public" });

    expect(res.status).toBe(400);
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("creates with an explicit visibility and passes it through to the service, with no silent default", async () => {
    const company = createCompany({ visibility: "shared" });
    mockCompanyService.create.mockResolvedValue(company);
    const app = await createApp(boardActor);

    const res = await request(app)
      .post("/api/companies")
      .send({ name: "Acme", visibility: "shared" });

    expect(res.status).toBe(201);
    expect(mockCompanyService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme", visibility: "shared" }),
    );
  });
});

describe("PATCH /api/companies/:companyId (TECH-7390 visibility is immutable)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("rejects any update payload that includes visibility, without calling the service", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    const app = await createApp(boardActor);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ visibility: "shared" });

    expect(res.status).toBe(422);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects an update that only sets visibility to the same value it already has", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany({ visibility: "private" }));
    const app = await createApp(boardActor);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ visibility: "private" });

    expect(res.status).toBe(422);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("still allows an ordinary update that doesn't touch visibility", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockCompanyService.update.mockResolvedValue(createCompany({ description: "Updated" }));
    const app = await createApp(boardActor);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ description: "Updated" });

    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalled();
  });
});

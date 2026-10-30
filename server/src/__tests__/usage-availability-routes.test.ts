import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({ report: vi.fn(), decide: vi.fn() }));
vi.mock("../services/usage-availability.js", () => ({ usageAvailabilityReport: mocks.report }));
vi.mock("../routes/ai-connections.js", () => ({ canManageAiConnections: vi.fn() }));
vi.mock("../services/index.js", () => ({
  heartbeatService: () => ({}), costService: () => ({}), financeService: () => ({}), budgetService: () => ({}),
  companyService: () => ({}), agentService: () => ({}), issueService: () => ({}), accessService: () => ({ decide: mocks.decide }),
}));
vi.mock("../services/accounting-integrity.js", () => ({ accountingIntegrityService: () => ({}) }));
vi.mock("../services/billing-reconciliation.js", () => ({ billingReconciliationService: () => ({}) }));

const companyId = "11111111-1111-4111-8111-111111111111";
const path = `/api/companies/${companyId}/costs/usage-availability`;
function app(type: "board" | "agent" = "board", agentCompanyId = companyId) {
  const instance = express(); instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = type === "board"
      ? { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] } as typeof req.actor
      : { type: "agent", agentId: "agent", companyId: agentCompanyId } as typeof req.actor;
    next();
  });
  instance.use("/api", costRoutes({} as Db)); instance.use(errorHandler); return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decide.mockResolvedValue({ allowed: true });
  mocks.report.mockResolvedValue({ companyId, reconciled: true });
});

describe("usage-availability route authorization", () => {
  it("serves a cost-read actor and passes the parsed date range through", async () => {
    const response = await request(app()).get(`${path}?from=2026-10-01&to=2026-10-09`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ companyId, reconciled: true });
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith(expect.anything(), companyId, expect.objectContaining({ from: expect.any(Date), to: expect.any(Date) }));
  });

  it("allows an agent in the same company that holds cost-read permission", async () => {
    expect((await request(app("agent")).get(path)).status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "company_scope:read" }));
  });

  it("refuses other companies, denied cost visibility and invalid date bounds before reading", async () => {
    expect((await request(app("agent", "other-company")).get(path)).status).toBe(403);
    expect((await request(app()).get("/api/companies/other/costs/usage-availability")).status).toBe(403);
    expect((await request(app()).get(`${path}?from=2026-10-09&to=2026-10-01`)).status).toBe(400);
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).get(path)).status).toBe(403);
    expect(mocks.report).not.toHaveBeenCalled();
  });
});

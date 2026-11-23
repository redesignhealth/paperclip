import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  enrolCommsWakeAgents: vi.fn(),
  listCommsWakeStatus: vi.fn(),
  rotateCommsWakeSecret: vi.fn(),
  unsubscribeCommsWakeAgent: vi.fn(),
}));
vi.mock("../services/comms-wake-admin.js", async () => ({
  ...(await vi.importActual<typeof import("../services/comms-wake-admin.js")>("../services/comms-wake-admin.js")),
  ...svc,
}));

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const base = `/api/companies/${COMPANY}/comms-wake`;

async function createApp(actor: Record<string, unknown>) {
  const [{ commsWakeAdminRoutes }, { errorHandler }] = await Promise.all([import("../routes/comms-wake-admin.js"), import("../middleware/index.js")]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", commsWakeAdminRoutes({} as any));
  app.use(errorHandler);
  return app;
}
const admin = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: true, companyIds: [COMPANY], memberships: [{ companyId: COMPANY, membershipRole: "owner", status: "active" }] };
const owner = { ...admin, isInstanceAdmin: false };

describe("comms wake admin routes (TECH-9914)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.enrolCommsWakeAgents.mockResolvedValue({ dryRun: true, scanned: 0, outcomes: [], counts: {}, nextCursor: null });
    svc.listCommsWakeStatus.mockResolvedValue({ companyId: COMPANY, agents: [] });
    svc.rotateCommsWakeSecret.mockResolvedValue({ agentId: AGENT, result: "rotated", board: "new_secret", secretVersion: 2 });
    svc.unsubscribeCommsWakeAgent.mockResolvedValue({ agentId: AGENT, result: "unsubscribed", board: "removed", registration: "removed", secret: "removed" });
  });

  const endpoints: Array<[string, "get" | "post", string]> = [
    ["status", "get", `${base}/status`],
    ["enrol", "post", `${base}/enrol`],
    ["unsubscribe", "post", `${base}/agents/${AGENT}/unsubscribe`],
    ["rotate", "post", `${base}/agents/${AGENT}/rotate-secret`],
  ];

  it.each(endpoints)("%s: refuses a company owner who is not an instance admin, an agent key and an anonymous caller", async (_name, method, url) => {
    for (const actor of [owner, { type: "agent", agentId: AGENT, companyId: COMPANY, source: "agent_key" }, { type: "none" }]) {
      const res = await request(await createApp(actor))[method](url).send({});
      expect(res.status).toBeGreaterThanOrEqual(401);
      expect(res.status).toBeLessThanOrEqual(403);
    }
    expect(Object.values(svc).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it.each(endpoints)("%s: refuses an instance admin whose session does not reach the company", async (_name, method, url) => {
    const res = await request(await createApp({ ...admin, companyIds: [OTHER] }))[method](url).send({});
    expect(res.status).toBe(403);
    expect(Object.values(svc).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("enrol defaults to a dry run and passes the agent, limit and cursor through", async () => {
    const app = await createApp(admin);
    const res = await request(app).post(`${base}/enrol`).send({ agentId: AGENT, limit: 5, afterId: AGENT });
    expect(res.status).toBe(200);
    expect(svc.enrolCommsWakeAgents).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY, agentId: AGENT, dryRun: true, confirm: undefined, limit: 5, afterId: AGENT }, expect.anything());
  });

  it("enrol validates its input and turns a missing confirmation into a 400", async () => {
    const app = await createApp(admin);
    expect((await request(app).post(`${base}/enrol`).send({ agentId: "nope" })).status).toBe(400);
    expect((await request(app).post(`${base}/enrol`).send({ dryRun: "no" })).status).toBe(400);
    expect((await request(app).post(`${base}/enrol`).send({ limit: 1000 })).status).toBe(400);
    const { CommsWakeConfirmationError } = await import("../services/comms-wake-admin.js");
    svc.enrolCommsWakeAgents.mockRejectedValueOnce(new CommsWakeConfirmationError());
    expect((await request(app).post(`${base}/enrol`).send({ dryRun: false })).status).toBe(400);
  });

  it("unsubscribe and rotate map their results to status codes, and reject a malformed agent id", async () => {
    const app = await createApp(admin);
    expect((await request(app).post(`${base}/agents/${AGENT}/unsubscribe`)).status).toBe(200);
    expect(svc.unsubscribeCommsWakeAgent).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY, agentId: AGENT, actorUserId: "user-1" }, expect.anything());
    svc.unsubscribeCommsWakeAgent.mockResolvedValueOnce({ result: "board_remove_failed" });
    expect((await request(app).post(`${base}/agents/${AGENT}/unsubscribe`)).status).toBe(502);
    expect((await request(app).post(`${base}/agents/${AGENT}/rotate-secret`)).status).toBe(200);
    svc.rotateCommsWakeSecret.mockResolvedValueOnce({ result: "board_failed" });
    expect((await request(app).post(`${base}/agents/${AGENT}/rotate-secret`)).status).toBe(502);
    svc.rotateCommsWakeSecret.mockResolvedValueOnce({ result: "not_registered" });
    expect((await request(app).post(`${base}/agents/${AGENT}/rotate-secret`)).status).toBe(409);
    expect((await request(app).post(`${base}/agents/not-a-uuid/rotate-secret`)).status).toBe(400);
  });

  it("status passes paging through and rejects a bad cursor", async () => {
    const app = await createApp(admin);
    expect((await request(app).get(`${base}/status?limit=10&afterId=${AGENT}`)).status).toBe(200);
    expect(svc.listCommsWakeStatus).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY, limit: 10, afterId: AGENT });
    expect((await request(app).get(`${base}/status?afterId=x`)).status).toBe(400);
  });
});

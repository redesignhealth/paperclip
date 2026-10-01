import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TECH-7095: under the enforced managed-only agent auth policy the board chat relay (which
// spawns `claude` with the server's own login) must fail closed before any other gate.
const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
}));

async function createApp(deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({} as any, { deploymentMode }));
  return app;
}

describe("POST /api/board/chat/stream agent auth policy gate (TECH-7095)", () => {
  const saved = process.env.PAPERCLIP_AGENT_AUTH_POLICY;
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCLIP_AGENT_AUTH_POLICY;
    else process.env.PAPERCLIP_AGENT_AUTH_POLICY = saved;
  });

  it("returns 403 ai_connection_required under managed_only, even on local_trusted with the flag on", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const app = await createApp("local_trusted");
    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ai_connection_required");
    expect(typeof res.body.error).toBe("string");
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockGetExperimental).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("fires before the deployment-mode gate", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const app = await createApp("authenticated");
    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ai_connection_required");
  });

  it("host_fallback keeps the existing behaviour (passes the gate, stops at validation)", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const app = await createApp("local_trusted");
    const res = await request(app).post("/api/board/chat/stream").send({});
    expect(res.status).toBe(400);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("managed_only_report does not refuse (report-only)", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only_report";
    const app = await createApp("authenticated");
    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });
    expect(res.body.code).toBe("DEPLOYMENT_MODE_UNSUPPORTED");
  });
});

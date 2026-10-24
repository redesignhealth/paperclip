import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

/**
 * TECH-7895: the optional create-defaults consistency assertion threaded through the hire and create
 * routes. It is not an agent column, it is never persisted, and omitting it changes nothing.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
const ROUTER_DEFAULTS = { provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true };
const PLATFORM_DEFAULTS = { provider: null, model: null, source: "platform_openai", requiresRouterReadiness: false };

describeEmbeddedPostgres("hire/create expectedCreateDefaults", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-create-defaults-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-create-defaults-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  // Every test seeds its own company, so no cross-test cleanup is needed (the database is dropped).

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Defaults Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function app() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"];
      next();
    });
    server.use("/api", agentRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const body = (extra: Record<string, unknown> = {}) => ({
    name: `Hermes ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "hermes_local",
    adapterConfig: {},
    ...extra,
  });

  for (const route of ["agent-hires", "agents"] as const) {
    it(`${route}: a matching expectation creates the agent and is not persisted`, async () => {
      const companyId = await seedCompany();
      const res = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body({ expectedCreateDefaults: ROUTER_DEFAULTS }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const agent = res.body.agent ?? res.body;
      expect(agent.adapterConfig).toMatchObject({ provider: "router", model: "auto-jev-routing" });
      const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(JSON.stringify(row)).not.toContain("expectedCreateDefaults");
    });

    it(`${route}: a stale expectation is a retryable 409 and nothing is created`, async () => {
      const companyId = await seedCompany();
      const res = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body({ expectedCreateDefaults: PLATFORM_DEFAULTS }));
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain("agent_create_defaults_changed");
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    });

    it(`${route}: omitting the expectation keeps existing behavior`, async () => {
      const companyId = await seedCompany();
      const res = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body());
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
  }

  it("rejects a malformed expectation", async () => {
    const companyId = await seedCompany();
    const res = await request(app())
      .post(`/api/companies/${companyId}/agent-hires`)
      .send(body({ expectedCreateDefaults: { ...ROUTER_DEFAULTS, env: { OPENAI_API_KEY: "x" } } }));
    expect(res.status).toBe(400);
  });
});

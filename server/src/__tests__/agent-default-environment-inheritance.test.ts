import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, builtInManagedResources, companies, createDb, environments } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { resolveAgentFallbackEnvironmentId } from "../services/agent-default-environment.js";
import { environmentService } from "../services/environments.js";

/**
 * TECH-10878: a new agent inherits the company default environment when the create/hire request names none. The
 * resolved id is stored on the agent row. "process" agents only support the local driver, so an ssh company default
 * is the "not usable for this adapter" case.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("company default environment inheritance", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-company-default-env-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-default-env-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(defaultEnvironmentId: string | null = null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Env Co ${companyId.slice(0, 8)}`,
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultEnvironmentId,
    });
    return companyId;
  }

  async function localEnvironmentId() {
    return (await environmentService(db).ensureLocalEnvironment()).id;
  }

  async function sshEnvironment(overrides: Partial<typeof environments.$inferInsert> = {}) {
    const [row] = await db
      .insert(environments)
      .values({ name: `ssh-${randomUUID().slice(0, 8)}`, driver: "ssh", status: "active", config: {}, ...overrides })
      .returning();
    return row!;
  }

  function app() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"];
      next();
    });
    server.use("/api", instanceSettingsRoutes(db));
    server.use("/api/companies", companyRoutes(db));
    server.use("/api", agentRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const body = (extra: Record<string, unknown> = {}) => ({
    name: `Worker ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: { command: "echo" },
    ...extra,
  });

  async function storedEnvironmentId(agentId: string) {
    const [row] = await db.select({ defaultEnvironmentId: agents.defaultEnvironmentId }).from(agents).where(eq(agents.id, agentId));
    return row!.defaultEnvironmentId;
  }

  for (const route of ["agents", "agent-hires"] as const) {
    describe(`POST /companies/:id/${route}`, () => {
      it("inherits the company default when the request names no environment", async () => {
        const localId = await localEnvironmentId();
        const companyId = await seedCompany(localId);
        const res = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body());
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const agent = res.body.agent ?? res.body;
        expect(await storedEnvironmentId(agent.id)).toBe(localId);
      });

      it("an explicit null overrides the company default", async () => {
        const localId = await localEnvironmentId();
        const companyId = await seedCompany(localId);
        const res = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body({ defaultEnvironmentId: null }));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await storedEnvironmentId((res.body.agent ?? res.body).id)).toBeNull();
      });

      it("an explicit environment overrides a company default the adapter cannot use", async () => {
        const localId = await localEnvironmentId();
        const ssh = await sshEnvironment();
        const companyId = await seedCompany(ssh.id);
        const res = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body({ defaultEnvironmentId: localId }));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await storedEnvironmentId((res.body.agent ?? res.body).id)).toBe(localId);
      });

      it("falls back to null when the inherited environment is not allowed for the adapter type", async () => {
        const ssh = await sshEnvironment();
        const companyId = await seedCompany(ssh.id);
        const res = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body());
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await storedEnvironmentId((res.body.agent ?? res.body).id)).toBeNull();
      });

      it("falls back to null when the inherited environment is archived or bound to another company", async () => {
        const archived = await sshEnvironment({ status: "archived" });
        const archivedCompany = await seedCompany(archived.id);
        const first = await request(app()).post(`/api/companies/${archivedCompany}/${route}`).send(body());
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        expect(await storedEnvironmentId((first.body.agent ?? first.body).id)).toBeNull();

        const otherCompany = await seedCompany();
        const bound = await sshEnvironment();
        await db.insert(builtInManagedResources).values({
          companyId: otherCompany, bundleKey: "test", resourceKind: "environment", resourceKey: "bound",
          resourceId: bound.id, stockVersion: "1", stockHash: "x",
        });
        const boundCompany = await seedCompany(bound.id);
        const second = await request(app()).post(`/api/companies/${boundCompany}/${route}`).send(body());
        expect(second.status, JSON.stringify(second.body)).toBe(201);
        expect(await storedEnvironmentId((second.body.agent ?? second.body).id)).toBeNull();
      });

      it("leaves the environment null when the company has no default", async () => {
        const companyId = await seedCompany();
        const res = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body());
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await storedEnvironmentId((res.body.agent ?? res.body).id)).toBeNull();
      });
    });
  }

  it("does not move an existing agent when the company default changes", async () => {
    const companyId = await seedCompany();
    const created = await request(app()).post(`/api/companies/${companyId}/agents`).send(body());
    const agentId = (created.body.agent ?? created.body).id;
    const patched = await request(app()).patch(`/api/companies/${companyId}`).send({ defaultEnvironmentId: await localEnvironmentId() });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await storedEnvironmentId(agentId)).toBeNull();
  });

  describe("instance newAgentDefaultEnvironmentId (TECH-10878)", () => {
    async function setInstance(environmentId: string | null) {
      return instanceSettingsService(db).update({ newAgentDefaultEnvironmentId: environmentId });
    }

    afterEach(async () => {
      await setInstance(null);
    });

    it("resolves explicit > company > instance > none, skipping unusable candidates", async () => {
      const a = await sshEnvironment();
      const b = await sshEnvironment();
      const company = await seedCompany(a.id);
      await setInstance(b.id);
      expect(await resolveAgentFallbackEnvironmentId(db, company, "codex_local")).toBe(a.id);
      await db.update(companies).set({ defaultEnvironmentId: null }).where(eq(companies.id, company));
      expect(await resolveAgentFallbackEnvironmentId(db, company, "codex_local")).toBe(b.id);
      await db.update(companies).set({ defaultEnvironmentId: a.id }).where(eq(companies.id, company));
      await db.update(environments).set({ status: "archived" }).where(eq(environments.id, a.id));
      expect(await resolveAgentFallbackEnvironmentId(db, company, "codex_local")).toBe(b.id);
      await db.update(environments).set({ status: "archived" }).where(eq(environments.id, b.id));
      expect(await resolveAgentFallbackEnvironmentId(db, company, "codex_local")).toBeNull();
      await setInstance(null);
      expect(await resolveAgentFallbackEnvironmentId(await db, await seedCompany(), "codex_local")).toBeNull();
    });

    it("skips an instance default bound to another company or not allowed for the adapter", async () => {
      const ssh = await sshEnvironment();
      await setInstance(ssh.id);
      const company = await seedCompany();
      expect(await resolveAgentFallbackEnvironmentId(db, company, "process")).toBeNull();
      const other = await seedCompany();
      await db.insert(builtInManagedResources).values({
        companyId: other, bundleKey: "test", resourceKind: "environment", resourceKey: "bound",
        resourceId: ssh.id, stockVersion: "1", stockHash: "x",
      });
      expect(await resolveAgentFallbackEnvironmentId(db, company, "codex_local")).toBeNull();
      expect(await resolveAgentFallbackEnvironmentId(db, other, "codex_local")).toBe(ssh.id);
    });

    for (const route of ["agents", "agent-hires"] as const) {
      it(`${route}: a new agent stores the instance default when the company has none; explicit values win`, async () => {
        const localId = await localEnvironmentId();
        await setInstance(localId);
        const companyId = await seedCompany();
        const inherited = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body());
        expect(inherited.status, JSON.stringify(inherited.body)).toBe(201);
        expect(await storedEnvironmentId((inherited.body.agent ?? inherited.body).id)).toBe(localId);
        const none = await request(app()).post(`/api/companies/${companyId}/${route}`).send(body({ defaultEnvironmentId: null }));
        expect(await storedEnvironmentId((none.body.agent ?? none.body).id)).toBeNull();
      });
    }

    it("leaves an existing agent untouched when the instance setting changes", async () => {
      const companyId = await seedCompany();
      const created = await request(app()).post(`/api/companies/${companyId}/agents`).send(body());
      const agentId = (created.body.agent ?? created.body).id;
      await setInstance(await localEnvironmentId());
      expect(await storedEnvironmentId(agentId)).toBeNull();
    });

    it("PATCH /instance/settings validates and returns the setting, and leaves defaultEnvironmentId alone", async () => {
      const ssh = await sshEnvironment();
      const before = (await request(app()).get("/api/instance/settings")).body.defaultEnvironmentId;
      const set = await request(app()).patch("/api/instance/settings").send({ newAgentDefaultEnvironmentId: ssh.id });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body.newAgentDefaultEnvironmentId).toBe(ssh.id);
      expect(set.body.defaultEnvironmentId).toBe(before);
      expect((await request(app()).get("/api/instance/settings")).body.newAgentDefaultEnvironmentId).toBe(ssh.id);
      const missing = await request(app()).patch("/api/instance/settings").send({ newAgentDefaultEnvironmentId: randomUUID() });
      expect(missing.status).toBe(422);
      const archived = await sshEnvironment({ status: "archived" });
      expect((await request(app()).patch("/api/instance/settings").send({ newAgentDefaultEnvironmentId: archived.id })).status).toBe(422);
      expect((await request(app()).patch("/api/instance/settings").send({ newAgentDefaultEnvironmentId: "local" })).status).toBe(400);
      const cleared = await request(app()).patch("/api/instance/settings").send({ newAgentDefaultEnvironmentId: null });
      expect(cleared.body.newAgentDefaultEnvironmentId).toBeNull();
    });
  });

  describe("PATCH /companies/:id defaultEnvironmentId", () => {
    it("sets, returns and clears the company default", async () => {
      const companyId = await seedCompany();
      const ssh = await sshEnvironment();
      const set = await request(app()).patch(`/api/companies/${companyId}`).send({ defaultEnvironmentId: ssh.id });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body.defaultEnvironmentId).toBe(ssh.id);
      const read = await request(app()).get(`/api/companies/${companyId}`);
      expect(read.body.defaultEnvironmentId).toBe(ssh.id);
      const cleared = await request(app()).patch(`/api/companies/${companyId}`).send({ defaultEnvironmentId: null });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(cleared.body.defaultEnvironmentId).toBeNull();
    });

    it("rejects a missing, archived, or other-company environment", async () => {
      const companyId = await seedCompany();
      const missing = await request(app()).patch(`/api/companies/${companyId}`).send({ defaultEnvironmentId: randomUUID() });
      expect(missing.status).toBe(422);
      const archived = await sshEnvironment({ status: "archived" });
      const gone = await request(app()).patch(`/api/companies/${companyId}`).send({ defaultEnvironmentId: archived.id });
      expect(gone.status).toBe(422);
      const otherCompany = await seedCompany();
      const bound = await sshEnvironment();
      await db.insert(builtInManagedResources).values({
        companyId: otherCompany, bundleKey: "test", resourceKind: "environment", resourceKey: "bound",
        resourceId: bound.id, stockVersion: "1", stockHash: "x",
      });
      const foreign = await request(app()).patch(`/api/companies/${companyId}`).send({ defaultEnvironmentId: bound.id });
      expect(foreign.status).toBe(422);
    });

    it("rejects a value that is not a uuid", async () => {
      const companyId = await seedCompany();
      const res = await request(app()).patch(`/api/companies/${companyId}`).send({ defaultEnvironmentId: "local" });
      expect(res.status).toBe(400);
    });
  });
});

describe("fallbackEnvironmentRejection (TECH-10878)", () => {
  const base = { companyId: "company-1", boundCompanyIds: [] as string[] };
  const sandbox = (adapters?: Array<Record<string, unknown>>) => ({ driver: "sandbox", status: "active", config: { provider: "kubernetes", ...(adapters ? { adapters } : {}) } });

  it("accepts an unrestricted sandbox for a sandbox-capable adapter and a bound-to-this-company environment", async () => {
    const { fallbackEnvironmentRejection } = await import("../services/agent-default-environment.js");
    expect(fallbackEnvironmentRejection(sandbox(), { ...base, adapterType: "paperclip_runner" })).toBeNull();
    expect(fallbackEnvironmentRejection(sandbox(), { ...base, adapterType: "paperclip_runner", boundCompanyIds: ["company-1"] })).toBeNull();
  });

  it("requires an enabled registry entry for the adapter when the sandbox lists adapters", async () => {
    const { fallbackEnvironmentRejection } = await import("../services/agent-default-environment.js");
    const env = sandbox([{ adapterType: "hermes_local", enabled: true }, { adapterType: "pi_local", enabled: false }]);
    expect(fallbackEnvironmentRejection(env, { ...base, adapterType: "hermes_local" })).toBeNull();
    expect(fallbackEnvironmentRejection(env, { ...base, adapterType: "pi_local" })).toMatch(/does not list an enabled/);
    expect(fallbackEnvironmentRejection(env, { ...base, adapterType: "claude_local" })).toMatch(/does not list an enabled|not allowed/);
  });

  it("rejects missing, archived, foreign and fake-provider environments", async () => {
    const { fallbackEnvironmentRejection } = await import("../services/agent-default-environment.js");
    expect(fallbackEnvironmentRejection(null, { ...base, adapterType: "paperclip_runner" })).toBeTruthy();
    expect(fallbackEnvironmentRejection({ driver: "ssh", status: "archived" }, { ...base, adapterType: "paperclip_runner" })).toMatch(/archived/);
    expect(fallbackEnvironmentRejection({ driver: "ssh", status: "active" }, { ...base, adapterType: "paperclip_runner", boundCompanyIds: ["other"] })).toMatch(/another company/);
    expect(fallbackEnvironmentRejection({ driver: "sandbox", status: "active", config: { provider: "fake" } }, { ...base, adapterType: "paperclip_runner" })).toMatch(/fake/);
  });
});

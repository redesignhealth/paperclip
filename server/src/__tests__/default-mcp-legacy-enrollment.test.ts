import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import { agentService } from "../services/agents.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  censusLegacyAgentsPendingDefaultMcp,
  enrollLegacyAgentsWithDefaultMcp,
} from "../services/default-mcp-legacy-enrollment.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

describeEmbeddedPostgres("TECH-7339: legacy agent enrollment into the default MCP spec", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-legacy-enrollment-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-legacy-enrollment");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    delete process.env[FEATURE_ENV];
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    delete process.env[FEATURE_ENV];
  });

  afterAll(async () => {
    await stopDb?.();
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  // ---- seeding ------------------------------------------------------------------------------

  async function seedCompany(opts: { status?: "active" | "paused" | "archived" } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: opts.status ?? "active",
    });
    return companyId;
  }

  async function seedOwner(companyId: string, email = "owner@redesignhealth.com") {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  /** Creates an agent the way the routes do, with the feature flag however it currently is. */
  async function createAgent(companyId: string, ownerUserId: string | null = null) {
    return agentService(db).create(
      companyId,
      {
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
  }

  /** A "legacy" agent: created while the feature flag was off, so it has no `defaultMcp` key at all. */
  async function createLegacyAgent(companyId: string) {
    delete process.env[FEATURE_ENV];
    const created = await createAgent(companyId);
    const row = await rowOf(created.id);
    expect(readDefaultMcpState(row.metadata)).toBeNull();
    return created;
  }

  const rowOf = (agentId: string) => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);

  function enableFeature() {
    process.env[FEATURE_ENV] = "true";
  }

  // ---- gating ---------------------------------------------------------------------------------

  it("feature flag off: scans nothing and writes nothing", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    await createLegacyAgent(companyId);

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report).toEqual({ scanned: 0, outcomes: [], nextCursor: null });
  });

  it("dry run performs a census with zero writes", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId);
    enableFeature();

    const report = await censusLegacyAgentsPendingDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "would_enroll" }]);
    const row = await rowOf(legacy.id);
    expect(readDefaultMcpState(row.metadata)).toBeNull();
  });

  // ---- enrollment -------------------------------------------------------------------------

  it("enrolls a legacy agent through the same snapshot path new agents get, and schedules setup", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId);
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const row = await rowOf(legacy.id);
    const state = readDefaultMcpState(row.metadata);
    expect(state).not.toBeNull();
    expect(state!.entries["comms-board"]!.ownerUserId).toBe(ownerId);
  });

  it("a second pass over the same agent is a no-op: no duplicate enrollment, no outcome reported", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId);
    enableFeature();

    await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();
    const firstState = readDefaultMcpState((await rowOf(legacy.id)).metadata);

    const second = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(second.outcomes).toEqual([]);
    const secondState = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(secondState).toEqual(firstState);
  });

  it("an agent created after the feature already shipped is left alone (nothing to enroll)", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    enableFeature();
    const modern = await createAgent(companyId, null);
    await waitForScheduledDefaultMcpSetups();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes.find((o) => o.agentId === modern.id)).toBeUndefined();
  });

  it("reports and skips a corrupted defaultMcp key instead of overwriting it", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId);
    await db.update(agents).set({ metadata: { defaultMcp: { version: 2 } } }).where(eq(agents.id, legacy.id));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "corrupted_existing_state" }]);
    const row = await rowOf(legacy.id);
    expect(row.metadata).toEqual({ defaultMcp: { version: 2 } });
  });

  it("skips and reports an archived company without enrolling its agents", async () => {
    const companyId = await seedCompany({ status: "active" });
    await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId);
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "company_archived" }]);
  });

  it("skips and reports a company outside the frozen rollout scope", async () => {
    const inScope = await seedCompany();
    const outOfScope = await seedCompany();
    await seedOwner(inScope);
    await seedOwner(outOfScope);
    const legacyOut = await createLegacyAgent(outOfScope);
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS: inScope });
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId: outOfScope });

    expect(report.outcomes).toEqual([{ agentId: legacyOut.id, companyId: outOfScope, result: "skipped", reason: "company_out_of_scope" }]);
  });

  it("reports owner_required when the company has no eligible verified owner", async () => {
    const companyId = await seedCompany();
    const legacy = await createLegacyAgent(companyId);
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
  });

  it("pages through more legacy agents than fit in one batch via nextCursor", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const legacyIds: string[] = [];
    for (let i = 0; i < 3; i++) legacyIds.push((await createLegacyAgent(companyId)).id);
    enableFeature();

    const first = await enrollLegacyAgentsWithDefaultMcp(db, { companyId, limit: 2 });
    expect(first.outcomes).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await enrollLegacyAgentsWithDefaultMcp(db, { companyId, limit: 2, afterId: first.nextCursor! });
    expect(second.outcomes).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const enrolledIds = [...first.outcomes, ...second.outcomes].map((o) => o.agentId).sort();
    expect(enrolledIds).toEqual([...legacyIds].sort());
  });

  it("two overlapping batches racing the same agent enroll it exactly once", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId);
    enableFeature();

    const [first, second] = await Promise.all([
      enrollLegacyAgentsWithDefaultMcp(db, { companyId }),
      enrollLegacyAgentsWithDefaultMcp(db, { companyId }),
    ]);

    const enrolledOutcomes = [...first.outcomes, ...second.outcomes].filter((o) => o.result === "enrolled");
    expect(enrolledOutcomes).toHaveLength(1);
    expect(enrolledOutcomes[0]!.agentId).toBe(legacy.id);
  });
});

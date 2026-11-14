import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  companyMemoryUpgrades,
  agents,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  eq,
} from "./memory-upgrade-sweep-helpers.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import { runExport } from "../../server/src/services/company-memory-upgrade/export.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("export agent admission and read-only proof (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-adm");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const tenantSql = env.tenantWorkerSql;
  const company = env.company;
  const agent = env.agent;

  async function createUpgrade() {
    const [row] = await cpDb.insert(companyMemoryUpgrades).values({
      companyId: company.id,
      state: "sweeping",
      converterId: "test-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    }).returning();
    return row;
  }

  await t.test("agent validation: unknown agent, non-hermes_local, or terminated rejected", async () => {
    const upgrade = await createUpgrade();

    // Unknown agent
    const fakeAgentId = randomUUID();
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: fakeAgentId,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "AGENT_NOT_FOUND",
    );

    // Non-hermes_local agent
    const [claudeAgent] = await cpDb.insert(agents).values({
      companyId: company.id,
      name: "Claude Agent",
      adapterType: "claude_local",
      status: "active",
    }).returning();

    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: claudeAgent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "AGENT_INELIGIBLE",
    );

    // Terminated hermes agent
    const [termAgent] = await cpDb.insert(agents).values({
      companyId: company.id,
      name: "Terminated Hermes",
      adapterType: "hermes_local",
      status: "terminated",
    }).returning();

    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: termAgent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "AGENT_INELIGIBLE",
    );

    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });

  await t.test("read-only proof: mutation inside export transaction fails closed", async () => {
    const upgrade = await createUpgrade();

    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, {
        cpDb,
        tenantSql,
        _internalOnTransaction: async (tx) => {
          await tx.unsafe("INSERT INTO mem0_memories (id, payload, vector) VALUES ($1, $2, $3)", [
            randomUUID(),
            { data: "fail" },
            "mock-vec",
          ]);
        },
      }),
      (err: any) => {
        const msg = String(err?.message ?? "");
        assert.ok(msg.includes("cannot execute INSERT in a read-only transaction"));
        return true;
      },
    );

    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });
});

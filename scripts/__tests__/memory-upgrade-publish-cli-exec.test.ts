/**
 * CLI execution tests: dry-run non-mutation, formats, and dispatch (TECH-8191).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { main } from "../memory-upgrade.js";
import { runPublishCli } from "../memory-upgrade-publish.js";
import {
  companyMemoryUpgrades,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
} from "./memory-upgrade-sweep-helpers.js";
import {
  seedLedgerRow,
  seedStagedMemory,
  setupPublishTestEnvironment,
} from "./memory-upgrade-publish-helpers.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";

test("publish CLI execution and formatting", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("publish-cli-exec");
  t.after(async () => {
    await env.cleanup();
  });

  // Seed active sweeping upgrade
  const [upgrade] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "sweeping",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      publishedCount: 0,
    })
    .returning();

  // Seed 1 source with 2 staged memories
  const sId = randomUUID();
  const text = "Memory source content for CLI test";
  await insertTenantMemoryRow(env.tenantSql, { id: sId, agentId: env.agent.id, data: text });
  const m1 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: sId, agentId: env.agent.id });
  const m2 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: sId, agentId: env.agent.id });
  await seedLedgerRow(env.tenantSql, {
    upgradeId: upgrade.id,
    sourceId: sId,
    agentId: env.agent.id,
    outcome: "published",
    outputIds: [m1.outputId, m2.outputId],
    sourceContentSha256: computeSourceContentSha256(text),
  });

  const defaultOpts = [
    "--database-url", "postgres://u:p@127.0.0.1:5432/db",
    "--control-plane-url", "postgres://u:p@127.0.0.1:5432/cp",
    "--company", env.company.id,
    "--dry-run",
  ];
  const testDeps = { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true };

  await t.test("dry run does not mutate live table or staging rows", async () => {
    let stdout = "";
    const orig = console.log;
    console.log = (msg: string) => { stdout += msg + "\n"; };

    try {
      const exit = await runPublishCli([...defaultOpts, "--confirm", env.company.id], testDeps);
      assert.equal(exit, 0);
      assert.match(stdout, /DRY RUN/);

      const [{ live_count }] = (await env.tenantSql.unsafe(
        "SELECT count(*)::int as live_count FROM mem0_memories WHERE id != $1::uuid;",
        [sId],
      )) as Array<{ live_count: number }>;
      assert.equal(live_count, 0);

      const [{ pending_count }] = (await env.tenantSql.unsafe(
        "SELECT count(*)::int as pending_count FROM paperclip_memory_upgrade_staging WHERE published_at IS NULL;",
      )) as Array<{ pending_count: number }>;
      assert.equal(pending_count, 2);
    } finally {
      console.log = orig;
    }
  });

  await t.test("format output shape: json and text", async () => {
    let stdout = "";
    const orig = console.log;
    console.log = (msg: string) => { stdout += msg + "\n"; };

    try {
      stdout = "";
      assert.equal(await runPublishCli([...defaultOpts, "--format", "json"], testDeps), 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.isDryRun, true);
      assert.equal(parsed.companyId, env.company.id);
      assert.equal(typeof parsed.counts.pendingRows, "number");

      stdout = "";
      assert.equal(await runPublishCli([...defaultOpts, "--format", "text"], testDeps), 0);
      assert.match(stdout, /=== Memory Upgrade Publish Report ===/);
      assert.match(stdout, /Pending rows:\s+2/);
    } finally {
      console.log = orig;
    }
  });

  await t.test("main dispatch routes to publish", async () => {
    let stdout = "";
    const orig = console.log;
    console.log = (msg: string) => { stdout += msg + "\n"; };
    try {
      assert.equal(await main(["node", "memory-upgrade", "publish", "--help"]), 0);
      assert.match(stdout, /Usage: pnpm memory:upgrade publish/);
    } finally {
      console.log = orig;
    }
  });
});

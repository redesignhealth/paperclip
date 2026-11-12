/**
 * Flip orchestrator E->F->G->H step ordering verification (TECH-8191 review finding Low).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";
import { runFlip } from "../../server/src/services/company-memory-upgrade/flip.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("flip orchestrator actual E->F->G->H step ordering (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("flip-ordering");
  t.after(async () => {
    await env.cleanup();
  });

  const [active] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "sweeping",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    })
    .returning();

  const snapshots: Array<{
    step: string;
    state: string;
    markerCompletedAt: Date | null;
    upgradeMarkedAt: Date | null;
  }> = [];

  const report = await runFlip(
    {
      companyId: env.company.id,
      confirm: env.company.id,
      controlPlaneDatabaseUrl: "postgres://unused",
      tenantDatabaseUrl: "postgres://unused",
      ackAgentScopeFlag: true,
    },
    {
      cpDb: env.cpWorkerDb,
      tenantSql: env.tenantWorkerSql,
      _internalSkipVectorIdentityCheck: true,
      _internalStepHook: async (step) => {
        const [u] = await env.cpDb
          .select({ state: companyMemoryUpgrades.state, markedAt: companyMemoryUpgrades.markedAt })
          .from(companyMemoryUpgrades)
          .where(eq(companyMemoryUpgrades.id, active.id));
        const [m] = await env.cpDb
          .select({ completedAt: companyMemoryDatabases.scopeMigrationCompletedAt })
          .from(companyMemoryDatabases)
          .where(eq(companyMemoryDatabases.companyId, env.company.id));
        snapshots.push({
          step,
          state: u.state,
          markerCompletedAt: m?.completedAt ?? null,
          upgradeMarkedAt: u?.markedAt ?? null,
        });
      },
    },
  );

  assert.equal(report.state, "draining");
  assert.deepEqual(snapshots.map((s) => s.step), ["E", "F", "G", "H"]);

  // E: advanceState sweeping -> flipping before marker write
  assert.equal(snapshots[0].step, "E");
  assert.equal(snapshots[0].state, "flipping");
  assert.equal(snapshots[0].markerCompletedAt, null, "Marker must NOT be set at step E");
  assert.equal(snapshots[0].upgradeMarkedAt, null, "markedAt must NOT be set at step E");

  // F: marker write before markedAt
  assert.equal(snapshots[1].step, "F");
  assert.equal(snapshots[1].state, "flipping");
  assert.ok(snapshots[1].markerCompletedAt != null, "Marker MUST be written at step F");
  assert.equal(snapshots[1].upgradeMarkedAt, null, "markedAt must NOT be set before step G");

  // G: markedAt before flipping -> draining
  assert.equal(snapshots[2].step, "G");
  assert.equal(snapshots[2].state, "flipping", "State must remain flipping at step G");
  assert.ok(snapshots[2].markerCompletedAt != null);
  assert.ok(snapshots[2].upgradeMarkedAt != null, "markedAt MUST be recorded at step G");
  assert.equal(
    snapshots[2].upgradeMarkedAt!.getTime(),
    snapshots[2].markerCompletedAt!.getTime(),
    "markedAt must match marker completedAt",
  );

  // H: flipping -> draining
  assert.equal(snapshots[3].step, "H");
  assert.equal(snapshots[3].state, "draining");
});

/**
 * Blocking pre-flip Hermes run queries boundary and limit tests (TECH-8191 §Q3, PR5.5).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  countBlockingPreFlipRuns,
  findBlockingPreFlipRuns,
} from "../../server/src/services/company-memory-upgrade/drain-runs.js";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("blocking pre-flip run query boundaries and limits (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-runs-bnd-");
  const cpDb = createDb(fixture.connectionString);

  t.after(async () => {
    await cpDb.$client.end({ timeout: 1 });
    await fixture.cleanup();
  });

  const [companyA] = await cpDb.insert(companies).values({ name: "Company A", issuePrefix: "CMPA" }).returning();

  const [hermesAgent] = await cpDb.insert(agents).values({
    companyId: companyA.id,
    name: "Hermes Agent",
    adapterType: "hermes_local",
  }).returning();

  const markedAt = new Date("2026-11-11T12:00:00.000Z");
  const tBefore = new Date("2026-11-11T11:50:00.000Z");
  const tAt = new Date("2026-11-11T12:00:00.000Z");
  const tAfter = new Date("2026-11-11T12:10:00.000Z");

  // started_at exactly markedAt -> should NOT block
  await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "running", startedAt: tAt, createdAt: tAt,
  });

  // started_at after markedAt -> should NOT block
  await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "running", startedAt: tAfter, createdAt: tAfter,
  });

  assert.equal(await countBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt }), 0);

  // started_at null, created_at before markedAt -> blocks via coalesce
  const [coalesceBlock] = await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "queued", startedAt: null, createdAt: tBefore,
  }).returning();

  assert.equal(await countBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt }), 1);
  const blocked = await findBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, coalesceBlock.id);

  // started_at null, created_at at markedAt -> does NOT block
  await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "queued", startedAt: null, createdAt: tAt,
  });
  assert.equal(await countBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt }), 1);

  await cpDb.delete(heartbeatRuns);

  // Limit and sorting oldest-first
  const t1 = new Date("2026-11-11T11:00:00.000Z");
  const t2 = new Date("2026-11-11T11:10:00.000Z");
  const t3 = new Date("2026-11-11T11:20:00.000Z");

  const [r1] = await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "running", startedAt: t1, createdAt: t1,
  }).returning();
  const [r2] = await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "running", startedAt: t2, createdAt: t2,
  }).returning();
  await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "running", startedAt: t3, createdAt: t3,
  });

  const limited = await findBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt, limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].id, r1.id);
  assert.equal(limited[1].id, r2.id);
});

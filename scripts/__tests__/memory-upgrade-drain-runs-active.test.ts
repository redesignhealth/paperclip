/**
 * Active pre-flip Hermes run query tests (TECH-8191 §Q3, PR5.5).
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

test("active pre-flip Hermes runs block drain (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-runs-act-");
  const cpDb = createDb(fixture.connectionString);

  t.after(async () => {
    await cpDb.$client.end({ timeout: 1 });
    await fixture.cleanup();
  });

  const [companyA] = await cpDb.insert(companies).values({ name: "Company A", issuePrefix: "CMPA" }).returning();
  const [companyB] = await cpDb.insert(companies).values({ name: "Company B", issuePrefix: "CMPB" }).returning();

  const [hermesAgent] = await cpDb.insert(agents).values({
    companyId: companyA.id,
    name: "Hermes Agent",
    adapterType: "hermes_local",
  }).returning();

  const [hermesAgentB] = await cpDb.insert(agents).values({
    companyId: companyB.id,
    name: "Company B Hermes Agent",
    adapterType: "hermes_local",
  }).returning();

  const markedAt = new Date("2026-11-11T12:00:00.000Z");
  const tBefore = new Date("2026-11-11T11:50:00.000Z");

  // Active statuses: running, queued, scheduled_retry
  const [rRun] = await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "running", startedAt: tBefore, createdAt: tBefore,
  }).returning();
  const [rQue] = await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "queued", startedAt: tBefore, createdAt: tBefore,
  }).returning();
  const [rRet] = await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "scheduled_retry", startedAt: tBefore, createdAt: tBefore,
  }).returning();

  // Other company active run (must not block)
  await cpDb.insert(heartbeatRuns).values({
    companyId: companyB.id, agentId: hermesAgentB.id, status: "running", startedAt: tBefore, createdAt: tBefore,
  });

  const count = await countBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt });
  assert.equal(count, 3);

  const runs = await findBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt });
  assert.equal(runs.length, 3);
  const ids = runs.map((r) => r.id);
  assert.ok(ids.includes(rRun.id));
  assert.ok(ids.includes(rQue.id));
  assert.ok(ids.includes(rRet.id));
});

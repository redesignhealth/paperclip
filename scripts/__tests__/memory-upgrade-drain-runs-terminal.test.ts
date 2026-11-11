/**
 * Terminal and non-Hermes run query tests (TECH-8191 §Q3, PR5.5).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  countBlockingPreFlipRuns,
  findBlockingPreFlipRuns,
} from "../../server/src/services/company-memory-upgrade/drain-runs.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("terminal and non-Hermes runs do not block drain (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-runs-trm-");
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

  const [processAgent] = await cpDb.insert(agents).values({
    companyId: companyA.id,
    name: "Process Agent",
    adapterType: "process",
  }).returning();

  const markedAt = new Date("2026-11-11T12:00:00.000Z");
  const tBefore = new Date("2026-11-11T11:50:00.000Z");

  // Terminal runs for Hermes agent
  await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "succeeded", startedAt: tBefore, createdAt: tBefore,
  });
  await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "failed", startedAt: tBefore, createdAt: tBefore,
  });

  // Non-Hermes running run
  await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: processAgent.id, status: "running", startedAt: tBefore, createdAt: tBefore,
  });

  assert.equal(await countBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt }), 0);
  assert.equal((await findBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt })).length, 0);

  // Active run for projection check
  const [activeRun] = await cpDb.insert(heartbeatRuns).values({
    companyId: companyA.id, agentId: hermesAgent.id, status: "running", startedAt: tBefore, createdAt: tBefore,
  }).returning();

  const [run] = await findBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt });
  assert.ok(run);
  assert.equal(run.id, activeRun.id);
  assert.deepEqual(Object.keys(run).sort(), ["agentId", "createdAt", "id", "startedAt", "status"]);
  assert.equal((run as any).contextSnapshot, undefined);

  // Validation
  await assert.rejects(
    async () => findBlockingPreFlipRuns(cpDb, { companyId: "not-uuid", markedAt }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    async () => findBlockingPreFlipRuns(cpDb, { companyId: companyA.id, markedAt: new Date("bad") }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
});

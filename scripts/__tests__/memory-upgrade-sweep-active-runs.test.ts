/**
 * Tests for active company run counting and quiescence gating (TECH-8191).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  countActiveCompanyRuns,
  createActiveRunGate,
} from "../../server/src/services/company-memory-upgrade/active-runs.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  ManualClock,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("active-runs: countActiveCompanyRuns and createActiveRunGate", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("sweep-active-runs-");
  const db = createDb(fixture.connectionString);

  t.after(async () => {
    await db?.$client?.end();
    await fixture?.cleanup();
  });

  // Create companies and agents
  const [companyA] = await db.insert(companies).values({ name: "Company A", issuePrefix: "CA" }).returning();
  const [companyB] = await db.insert(companies).values({ name: "Company B", issuePrefix: "CB" }).returning();

  const [agentA] = await db.insert(agents).values({
    companyId: companyA.id,
    name: "Agent A",
    adapterType: "hermes_local",
  }).returning();

  const [agentB] = await db.insert(agents).values({
    companyId: companyB.id,
    name: "Agent B",
    adapterType: "hermes_local",
  }).returning();

  await t.test("countActiveCompanyRuns counts only active runs for target company", async () => {
    assert.equal(await countActiveCompanyRuns(db, companyA.id), 0);

    // Insert active runs for Company A
    await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "scheduled_retry",
    });

    // Inactive runs for Company A
    await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "succeeded",
    });
    await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "failed",
    });

    // Active runs for Company B (must be excluded)
    await db.insert(heartbeatRuns).values({
      companyId: companyB.id,
      agentId: agentB.id,
      status: "running",
    });

    const activeA = await countActiveCompanyRuns(db, companyA.id);
    assert.equal(activeA, 3);

    const activeB = await countActiveCompanyRuns(db, companyB.id);
    assert.equal(activeB, 1);
  });

  await t.test("createActiveRunGate disables when threshold is 0", async () => {
    const clock = new ManualClock();
    let leaseCalls = 0;

    const gate = createActiveRunGate({
      db,
      companyId: companyA.id,
      threshold: 0,
      clock,
      sleeper: clock,
      assertLeaseActive: () => { leaseCalls++; },
    });

    await gate.waitUntilQuiet();
    assert.equal(gate.stats().pauseCount, 0);
    assert.equal(gate.stats().totalPausedMs, 0);
  });

  await t.test("createActiveRunGate returns immediately when below threshold", async () => {
    const clock = new ManualClock();
    let leaseCalls = 0;

    const gate = createActiveRunGate({
      db,
      companyId: companyA.id,
      threshold: 10, // companyA currently has 3 active runs
      pollMs: 15_000,
      clock,
      sleeper: clock,
      assertLeaseActive: () => { leaseCalls++; },
    });

    await gate.waitUntilQuiet();
    assert.equal(leaseCalls, 1);
    assert.equal(gate.stats().pauseCount, 0);
    assert.equal(gate.stats().totalPausedMs, 0);

    // Call again within pollMs: clock throttling skips DB re-query
    await gate.waitUntilQuiet();
    assert.equal(leaseCalls, 2);
    assert.equal(gate.stats().pauseCount, 0);
  });

  await t.test("createActiveRunGate pauses, sleeps in steps, asserts lease, and resumes when quiet", async () => {
    // Clean up existing runs
    await db.delete(heartbeatRuns);

    // Seed 2 active runs
    const [run1] = await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "running",
    }).returning();

    const clock = new ManualClock(1_000_000);
    let pauseNotified = 0;
    let resumeNotified = 0;
    let leaseAsserts = 0;

    const gate = createActiveRunGate({
      db,
      companyId: companyA.id,
      threshold: 1, // 2 active >= 1 -> triggers pause
      pollMs: 10_000,
      clock,
      sleeper: {
        async sleep(ms: number) {
          clock.advance(ms);
          // After 20 seconds, mark run as succeeded to unblock gate
          if (clock.nowMs() >= 1_020_000) {
            await db.delete(heartbeatRuns);
          }
        },
      },
      onPause: () => { pauseNotified++; },
      onResume: () => { resumeNotified++; },
      assertLeaseActive: () => { leaseAsserts++; },
    });

    await gate.waitUntilQuiet();

    assert.equal(pauseNotified, 1);
    assert.equal(resumeNotified, 1);
    assert.ok(leaseAsserts >= 3);
    assert.equal(gate.stats().pauseCount, 1);
    assert.ok(gate.stats().totalPausedMs >= 20_000);
  });

  await t.test("createActiveRunGate throws paused_too_long when maxPauseMs exceeded", async () => {
    await db.delete(heartbeatRuns);

    await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "running",
    });

    const clock = new ManualClock(2_000_000);

    const gate = createActiveRunGate({
      db,
      companyId: companyA.id,
      threshold: 1,
      pollMs: 5_000,
      maxPauseMs: 15_000,
      clock,
      sleeper: clock,
    });

    await assert.rejects(
      async () => {
        await gate.waitUntilQuiet();
      },
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "paused_too_long");
        return true;
      },
    );

    assert.equal(gate.stats().pauseCount, 1);
    assert.ok(gate.stats().totalPausedMs >= 15_000);
  });

  await t.test("createActiveRunGate re-polls before declaring paused_too_long and resumes if runs cleared", async () => {
    await db.delete(heartbeatRuns);
    await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "running",
    });

    const clock = new ManualClock(3_000_000);
    let sleeps = 0;

    const gate = createActiveRunGate({
      db,
      companyId: companyA.id,
      threshold: 1,
      pollMs: 10_000,
      maxPauseMs: 15_000,
      clock,
      sleeper: {
        async sleep(ms: number) {
          sleeps++;
          clock.advance(ms);
          // Just before maxPauseMs is reached, the active run completes
          if (clock.nowMs() >= 3_010_000) {
            await db.delete(heartbeatRuns);
          }
        },
      },
    });

    // Should NOT throw because re-poll catches that runs subsided
    await gate.waitUntilQuiet();
    assert.ok(sleeps > 0);
    assert.equal(gate.stats().pauseCount, 1);
  });

  await t.test("createActiveRunGate caps sleep at remaining budget and handles maxPauseMs < pollMs", async () => {
    await db.delete(heartbeatRuns);
    await db.insert(heartbeatRuns).values({
      companyId: companyA.id,
      agentId: agentA.id,
      status: "running",
    });

    const clock = new ManualClock(4_000_000);
    const sleepDurations: number[] = [];

    const gate = createActiveRunGate({
      db,
      companyId: companyA.id,
      threshold: 1,
      pollMs: 15_000,
      maxPauseMs: 7_000, // maxPauseMs is smaller than pollMs
      clock,
      sleeper: {
        async sleep(ms: number) {
          sleepDurations.push(ms);
          clock.advance(ms);
        },
      },
    });

    await assert.rejects(
      async () => {
        await gate.waitUntilQuiet();
      },
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "paused_too_long");
        return true;
      },
    );

    // First sleep was min(5000, 15000, 7000) = 5000
    // Second sleep was min(5000, 15000, 2000 remaining) = 2000
    assert.deepEqual(sleepDurations, [5000, 2000]);
    assert.equal(gate.stats().totalPausedMs, 7_000);
  });

  await t.test("createActiveRunGate tracks cumulative paused time accurately across multiple pauses", async () => {
    await db.delete(heartbeatRuns);

    const clock = new ManualClock(5_000_000);

    const gate = createActiveRunGate({
      db,
      companyId: companyA.id,
      threshold: 1,
      pollMs: 5_000,
      maxPauseMs: 50_000,
      clock,
      sleeper: {
        async sleep(ms: number) {
          clock.advance(ms);
          // When called, unblock active runs
          await db.delete(heartbeatRuns);
        },
      },
    });

    // Pause 1
    await db.insert(heartbeatRuns).values({ companyId: companyA.id, agentId: agentA.id, status: "running" });
    await gate.waitUntilQuiet();

    assert.equal(gate.stats().pauseCount, 1);
    const pausedAfter1 = gate.stats().totalPausedMs;
    assert.ok(pausedAfter1 >= 5_000);

    // Advance clock past pollMs so next check triggers
    clock.advance(10_000);

    // Pause 2
    await db.insert(heartbeatRuns).values({ companyId: companyA.id, agentId: agentA.id, status: "running" });
    await gate.waitUntilQuiet();

    assert.equal(gate.stats().pauseCount, 2);
    assert.ok(gate.stats().totalPausedMs >= pausedAfter1 + 5_000);
  });

  await t.test("countActiveCompanyRuns throws bounded UNEXPECTED_FAILURE when row is undefined", async () => {
    const mockDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return []; // empty array -> [row] is undefined
              },
            };
          },
        };
      },
    } as any;

    await assert.rejects(
      async () => {
        await countActiveCompanyRuns(mockDb, companyA.id);
      },
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "UNEXPECTED_FAILURE");
        assert.ok(!err.message.includes(companyA.id));
        return true;
      },
    );
  });

  await t.test("createActiveRunGate accumulates totalPausedMs when assertion throws during pause", async () => {
    await db.delete(heartbeatRuns);
    const clock = new ManualClock(1_000_000);

    const gate = createActiveRunGate({
      db,
      companyId: companyA.id,
      threshold: 1,
      pollMs: 1_000,
      clock,
      sleeper: {
        async sleep(ms: number) {
          clock.advance(ms);
        },
      },
      assertLeaseActive: () => {
        if (clock.nowMs() > 1_000_000) {
          throw new CompanyMemoryUpgradeError("Lease lost", "LEASE_FENCED_OUT");
        }
      },
    });

    await db.insert(heartbeatRuns).values({ companyId: companyA.id, agentId: agentA.id, status: "running" });

    await assert.rejects(
      async () => {
        await gate.waitUntilQuiet();
      },
      (err: any) => {
        assert.equal(err.code, "LEASE_FENCED_OUT");
        return true;
      },
    );

    assert.equal(gate.stats().pauseCount, 1);
    assert.ok(gate.stats().totalPausedMs > 0);
  });
});

/**
 * Pure evaluation function unit tests for drain evidence (TECH-8191 §Q1, §Q3, PR5.7).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDrainEvidence, type EvaluateDrainEvidenceParams } from "../../server/src/services/company-memory-upgrade/drain-evidence.js";

test("evaluateDrainEvidence pure function", async (t) => {
  const markedAt = new Date("2026-11-11T12:00:00.000Z");
  const observedAfter = new Date("2026-11-11T12:05:00.000Z");
  const cleanProbe = { blockingSources: 0, missingScopeBlockingSources: 0 };

  const evalEv = (overrides: Partial<EvaluateDrainEvidenceParams> = {}) =>
    evaluateDrainEvidence({
      probe: cleanProbe,
      blockingRuns: [],
      agentScopeObservedAt: observedAfter,
      markedAt,
      streakStartedAt: null,
      leaseHeldByOther: false,
      now: new Date("2026-11-11T12:10:00Z"),
      ...overrides,
    });

  await t.test("streak start: first clean probe starts streak, does not confirm", () => {
    const now = new Date("2026-11-11T12:10:00Z");
    const res = evalEv({ now });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.deepEqual(res.blockedBy, []);
    assert.equal(res.nextStreakStartedAt?.getTime(), now.getTime());
  });

  await t.test("9-minute re-probe preserves streak and does NOT confirm", () => {
    const sStart = new Date("2026-11-11T12:10:00Z");
    const res = evalEv({ streakStartedAt: sStart, now: new Date("2026-11-11T12:19:00Z") });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.deepEqual(res.blockedBy, []);
    assert.equal(res.nextStreakStartedAt?.getTime(), sStart.getTime());
  });

  await t.test("11-minute re-probe counts and confirms drain", () => {
    const sStart = new Date("2026-11-11T12:10:00Z");
    const res = evalEv({ streakStartedAt: sStart, now: new Date("2026-11-11T12:21:00Z") });
    assert.equal(res.counts, true);
    assert.equal(res.confirmed, true);
    assert.deepEqual(res.blockedBy, []);
    assert.equal(res.nextStreakStartedAt?.getTime(), sStart.getTime());
  });

  await t.test("non-empty probe resets streak to null", () => {
    const sStart = new Date("2026-11-11T12:10:00.000Z");
    const res = evalEv({ probe: { blockingSources: 2, missingScopeBlockingSources: 0 }, streakStartedAt: sStart });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.equal(res.nextStreakStartedAt, null);
    assert.ok(res.blockedBy.includes("blocking_sources"));
  });

  await t.test("missing scope sources reset streak to null", () => {
    const sStart = new Date("2026-11-11T12:10:00.000Z");
    const res = evalEv({ probe: { blockingSources: 0, missingScopeBlockingSources: 1 }, streakStartedAt: sStart });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.equal(res.nextStreakStartedAt, null);
    assert.ok(res.blockedBy.includes("missing_scope_blocking_sources"));
  });

  await t.test("blocking pre-flip run resets streak to null", () => {
    const sStart = new Date("2026-11-11T12:10:00.000Z");
    const res = evalEv({ blockingRuns: [{ id: "run-pre-flip-1" }], streakStartedAt: sStart });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.equal(res.nextStreakStartedAt, null);
    assert.ok(res.blockedBy.includes("blocking_runs"));
  });

  await t.test("no agent-scope observation never counts and resets streak", () => {
    const sStart = new Date("2026-11-11T12:10:00.000Z");
    const res = evalEv({ agentScopeObservedAt: null, streakStartedAt: sStart });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.equal(res.nextStreakStartedAt, null);
    assert.ok(res.blockedBy.includes("agent_scope_not_observed"));
  });

  await t.test("observation before marked_at never counts", () => {
    const sStart = new Date("2026-11-11T12:10:00.000Z");
    const stale = new Date("2026-11-11T11:59:00.000Z");
    const res = evalEv({ agentScopeObservedAt: stale, streakStartedAt: sStart });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.equal(res.nextStreakStartedAt, null);
    assert.ok(res.blockedBy.includes("agent_scope_not_observed"));
  });

  await t.test("observation exactly at marked_at does not count (strictly after required)", () => {
    const res = evalEv({ agentScopeObservedAt: markedAt });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.ok(res.blockedBy.includes("agent_scope_not_observed"));
  });

  await t.test("another owner holding the lease never counts and resets streak", () => {
    const sStart = new Date("2026-11-11T12:10:00.000Z");
    const res = evalEv({ streakStartedAt: sStart, leaseHeldByOther: true });
    assert.equal(res.counts, false);
    assert.equal(res.confirmed, false);
    assert.equal(res.nextStreakStartedAt, null);
    assert.ok(res.blockedBy.includes("a sweep or publish is in flight"));
  });
});

/**
 * Report formatting, disclaimer block, and secret/memory-text omission (TECH-8191 §Q4).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  formatVerifyReport,
  WHAT_VERIFY_DOES_NOT_PROVE,
  type VerifyReport,
} from "../../server/src/services/company-memory-upgrade/verify.js";

test("verify report content and disclaimer assertions", async (t) => {
  const sampleReport: VerifyReport = {
    isDryRun: true,
    companyId: randomUUID(),
    companyName: "Acme Corp",
    upgradeId: randomUUID(),
    state: "draining",
    priorState: "draining",
    verifiedAt: null,
    drainConfirmedAt: new Date("2026-11-12T10:00:00Z"),
    markedAt: new Date("2026-11-12T09:30:00Z"),
    agentScopeObservedAt: new Date("2026-11-12T09:45:00Z"),
    scopeMigrationMode: "copy",
    pendingPublishableRows: 0,
    pendingPublishableSources: 0,
    probeBlockingSources: 0,
    probeMissingScopeSources: 0,
    blockingRunsCount: 0,
    quarantinedCount: 2,
    allowQuarantined: true,
    droppedNoiseCount: 5,
    droppedSensitiveCount: 1,
    durationMs: 123,
    whatThisDoesNotProve: WHAT_VERIFY_DOES_NOT_PROVE,
  };

  await t.test("text report contains the explicit 'what this does not prove' block", () => {
    const text = formatVerifyReport(sampleReport, "text");
    assert.match(text, /What this verification does NOT prove/);
    assert.match(text, /That every legacy memory is now recallable/);
    assert.match(text, /That all agents observed agent scope/);
    assert.match(text, /That the observation means a run succeeded/);
    assert.match(text, /That no further company-scoped write can occur/);
    assert.match(text, /That legacy rows are safe to delete/);
    assert.match(text, /That the configuration is durable/);
    assert.match(text, /Quarantined: 2 \(allowed by --allow-quarantined\)/);
    assert.match(text, /Dropped noise: 5 \(intentional outcome\)/);
  });

  await t.test("json report round-trips and includes disclaimer array", () => {
    const jsonStr = formatVerifyReport(sampleReport, "json");
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.companyId, sampleReport.companyId);
    assert.equal(parsed.isDryRun, true);
    assert.equal(parsed.quarantinedCount, 2);
    assert.ok(Array.isArray(parsed.whatThisDoesNotProve));
    assert.equal(parsed.whatThisDoesNotProve.length, 7);
  });

  await t.test("report contains no memory text or excerpt fields", () => {
    const jsonStr = formatVerifyReport(sampleReport, "json");
    const parsed = JSON.parse(jsonStr);

    const forbiddenKeys = ["data", "memory", "text", "payload", "content", "excerpt"];
    const checkNoForbiddenKeys = (obj: any) => {
      for (const k of Object.keys(obj)) {
        assert.ok(!forbiddenKeys.includes(k.toLowerCase()), `Forbidden memory key found: ${k}`);
        if (obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k])) {
          checkNoForbiddenKeys(obj[k]);
        }
      }
    };
    checkNoForbiddenKeys(parsed);
  });
});

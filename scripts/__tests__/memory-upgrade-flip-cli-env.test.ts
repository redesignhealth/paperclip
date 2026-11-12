/**
 * Flip CLI environment checks: prod gate, flag isolation, format output (TECH-8191 §Q1, §Q2, PR5.6).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ALLOWED_FLIP_FLAGS,
  BOOLEAN_FLIP_FLAGS,
  runFlipCli,
} from "../memory-upgrade-flip.js";
import { formatFlipReport, type FlipReport } from "../../server/src/services/company-memory-upgrade/flip.js";
import { validateNoUnknownFlags } from "../memory-upgrade.js";

test("flip CLI prod gate, foreign flags, and report formatting", async (t) => {
  const localDsn = "postgres://user:pass@127.0.0.1:5432/test_tenant";
  const remoteDsn = "postgres://app_user:secret123@rds.us-east-1.amazonaws.com:5432/app_db";
  const validUuid1 = randomUUID();
  const validUuid2 = randomUUID();

  const capture = () => {
    let buf = "";
    const orig = console.error;
    console.error = (msg: string) => { buf += msg + "\n"; };
    return { get: () => buf, restore: () => { console.error = orig; } };
  };

  await t.test("prod gate enforces --prod and MEMORY_UPGRADE_ALLOW_PROD=1 on BOTH DSNs", async () => {
    const c = capture();
    try {
      const eA = await runFlipCli(["--database-url", remoteDsn, "--control-plane-url", localDsn, "--confirm", validUuid1], { env: {} });
      assert.equal(eA, 1);
      assert.match(c.get(), /\[PROD_GUARD_ENFORCED\]/);
      assert.ok(!c.get().includes("secret123"));

      const eB = await runFlipCli(["--database-url", remoteDsn, "--control-plane-url", localDsn, "--confirm", validUuid1, "--prod"], { env: {} });
      assert.equal(eB, 1);
      assert.match(c.get(), /\[PROD_GUARD_ENFORCED\]/);

      const eC = await runFlipCli(["--database-url", localDsn, "--control-plane-url", remoteDsn, "--confirm", validUuid1], { env: {} });
      assert.equal(eC, 1);
      assert.match(c.get(), /\[PROD_GUARD_ENFORCED\]/);
    } finally {
      c.restore();
    }
  });

  await t.test("flip rejects flags belonging to other subcommands", () => {
    assert.throws(
      () => validateNoUnknownFlags(["--max-cost-usd=100"], ALLOWED_FLIP_FLAGS, "flip", BOOLEAN_FLIP_FLAGS),
      /Unknown option '--max-cost-usd'/,
    );
    assert.throws(
      () => validateNoUnknownFlags(["--batch-sources=50"], ALLOWED_FLIP_FLAGS, "flip", BOOLEAN_FLIP_FLAGS),
      /Unknown option '--batch-sources'/,
    );
    assert.throws(
      () => validateNoUnknownFlags(["--max-drain-hours=10"], ALLOWED_FLIP_FLAGS, "flip", BOOLEAN_FLIP_FLAGS),
      /Unknown option '--max-drain-hours'/,
    );
  });

  await t.test("formatFlipReport text and JSON shapes contain assertion note and no memory text", () => {
    const dummyReport: FlipReport = {
      isDryRun: false,
      companyId: validUuid1,
      companyName: "Acme Corp",
      upgradeId: validUuid2,
      state: "draining",
      priorState: "flipping",
      mode: "copy",
      markedAt: new Date("2026-11-11T12:00:00.000Z"),
      alreadySet: false,
      pendingRows: 0,
      pendingSources: 0,
      alreadyPublishedRows: 42,
      blockingSources: 0,
      missingScopeBlockingSources: 0,
      durationMs: 123,
      ackAgentScopeFlag: true,
      ackAgentScopeAssertion: "assertion note",
      agentScopePilotSummary: {
        totalHermesAgents: 3,
        agentsWithFlagInConfig: [validUuid1],
        note: "note",
      },
      scopeWarning: "warning: all Hermes agents switch",
    };

    const text = formatFlipReport(dummyReport, "text");
    assert.match(text, /=== Memory Upgrade Flip Report ===/);
    assert.match(text, /Total hermes_local agents: 3/);

    const jsonStr = formatFlipReport(dummyReport, "json");
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.companyId, validUuid1);
    assert.equal(parsed.ackAgentScopeFlag, true);
    assert.equal(parsed.agentScopePilotSummary.totalHermesAgents, 3);
    assert.deepEqual(parsed.agentScopePilotSummary.agentsWithFlagInConfig, [validUuid1]);
    assert.equal(parsed.data, undefined);
  });
});

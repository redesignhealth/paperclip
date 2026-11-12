/**
 * Memory upgrade recover CLI argument, flag isolation, and sweep message tests (TECH-8191 §Q6, PR5.11).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runRecover } from "../../server/src/services/company-memory-upgrade/index.js";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { ALLOWED_RECOVER_FLAGS, BOOLEAN_RECOVER_FLAGS } from "../memory-upgrade-recover-flags.js";
import { parseRecoverArgs } from "../memory-upgrade-recover-args.js";
import { runRecoverCli } from "../memory-upgrade-recover.js";
import { sanitizeCliErrorMessage, validateNoUnknownFlags } from "../memory-upgrade.js";
import {
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertRecoverUpgrade,
  setupPublishTestEnvironment,
} from "./memory-upgrade-recover-helpers.js";

test("recover CLI arguments, isolation, and sweep error verbatim (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("recover-cli");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const company = env.company;

  t.beforeEach(async () => {
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));
  });

  await t.test("mismatched --confirm throws; recover rejects other commands' flags", async () => {
    const wrongUuid = randomUUID();
    await assert.rejects(
      () => runRecover({ companyId: company.id, confirm: wrongUuid }, { cpDb }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );

    const argErr = new CompanyMemoryUpgradeError(
      "Confirmation company ID does not match target company ID.",
      "INVALID_ARGUMENT",
    );
    assert.equal(
      sanitizeCliErrorMessage(argErr),
      "[INVALID_ARGUMENT] Confirmation company ID does not match target company ID.",
    );

    const flagErr = new CompanyMemoryUpgradeError(
      "Flag --confirm <uuid> must strictly match --company <uuid>.",
      "INVALID_ARGUMENT",
    );
    assert.equal(
      sanitizeCliErrorMessage(flagErr),
      "[INVALID_ARGUMENT] Flag --confirm <uuid> must strictly match --company <uuid>.",
    );

    const origError = console.error;
    let errorOutput = "";
    console.error = (...args: any[]) => {
      errorOutput += args.join(" ") + "\n";
    };
    try {
      const exitCode = await runRecoverCli(
        ["--company", company.id, "--confirm", wrongUuid],
        { cpDb, env: { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() } },
      );
      assert.equal(exitCode, 1);
      assert.ok(errorOutput.includes("Flag --confirm <uuid> must strictly match --company <uuid>."));
    } finally {
      console.error = origError;
    }

    assert.throws(
      () =>
        parseRecoverArgs(
          ["--company", company.id, "--confirm", wrongUuid],
          { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() },
          process.cwd(),
        ),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );

    for (const flag of ["--table", "--database-url", "--model", "--max-rows"]) {
      assert.throws(
        () => validateNoUnknownFlags([flag], ALLOWED_RECOVER_FLAGS, "recover", BOOLEAN_RECOVER_FLAGS),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
      );
    }
  });

  await t.test("sweep's needs_recovery message is the allowlisted text verbatim", async () => {
    await insertRecoverUpgrade(cpDb, company.id, { state: "needs_recovery", recoverToState: "sweeping" });

    const expectedMessage = "Upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' before resuming sweep.";
    let caughtErr: unknown = null;
    try {
      await runSweep(
        { companyId: company.id, databaseUrl: env.tenantUrl.toString(), controlPlaneUrl: env.cpUrl.toString() },
        { controlPlaneDb: cpDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
      );
    } catch (err: unknown) {
      caughtErr = err;
    }

    assert.ok(caughtErr instanceof CompanyMemoryUpgradeError);
    assert.equal(caughtErr.code, "STATE_MISMATCH");
    assert.equal(caughtErr.message, expectedMessage);
    assert.equal(sanitizeCliErrorMessage(caughtErr), `[STATE_MISMATCH] ${expectedMessage}`);
  });

  await t.test("runRecoverCli execution and report formatting", async () => {
    const upgrade = await insertRecoverUpgrade(cpDb, company.id, { state: "needs_recovery", recoverToState: "draining" });

    const dryRunCode = await runRecoverCli(
      ["--company", company.id, "--dry-run"],
      { cpDb, env: { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() } },
    );
    assert.equal(dryRunCode, 0);

    const confirmedCode = await runRecoverCli(
      ["--company", company.id, "--confirm", company.id, "--format", "json"],
      { cpDb, env: { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() } },
    );
    assert.equal(confirmedCode, 0);

    const [row] = await cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "draining");
    assert.equal(row.recoverToState, null);
    assert.equal(row.leaseToken, null);
  });

  await t.test("runRecoverCli tx failure exits 1 with RECOVER_NOT_APPLIED text", async () => {
    await insertRecoverUpgrade(cpDb, company.id, {
      state: "needs_recovery",
      recoverToState: "sweeping",
    });

    const origError = console.error;
    let errorOutput = "";
    console.error = (...args: any[]) => {
      errorOutput += args.join(" ") + "\n";
    };
    try {
      const exitCode = await runRecoverCli(
        ["--company", company.id, "--confirm", company.id],
        {
          cpDb,
          env: { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() },
          _internalTxHook: () => {
            throw new Error("simulated control-plane db error in tx");
          },
        },
      );
      assert.equal(exitCode, 1);
      assert.ok(errorOutput.includes("[RECOVER_NOT_APPLIED]"));
      assert.ok(
        errorOutput.includes(
          "Recover failed before anything changed: the upgrade is still in 'needs_recovery'",
        ),
      );
    } finally {
      console.error = origError;
    }
  });

  await t.test("runRecoverCli post-commit failure exits 0 with readback confirmation", async () => {
    await insertRecoverUpgrade(cpDb, company.id, {
      state: "needs_recovery",
      recoverToState: "sweeping",
    });

    const origLog = console.log;
    let logOutput = "";
    console.log = (...args: any[]) => {
      logOutput += args.join(" ") + "\n";
    };
    try {
      const exitCode = await runRecoverCli(
        ["--company", company.id, "--confirm", company.id],
        {
          cpDb,
          env: { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() },
          _internalPostCommitHook: () => {
            throw new Error("simulated post-commit client disconnect");
          },
        },
      );
      assert.equal(exitCode, 0);
      assert.ok(logOutput.includes("Recovery Confirmed By Readback: yes"));
      assert.ok(
        logOutput.includes(
          "The recover command lost its connection before it could confirm the result",
        ),
      );
    } finally {
      console.log = origLog;
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { runCensusCli, runSweepCli } from "../memory-upgrade.js";
import { runPublishCli } from "../memory-upgrade-publish.js";

test("CLI entry points reject foreign command flags before DB connections (TECH-8191)", async (t) => {
  await t.test("regression #342: sweep rejects --dry-run before opening any database connection", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };
    let connectionAttempted = false;

    try {
      const exit = await runSweepCli([
        "--database-url", "postgres://u:p@localhost:5432/tenant",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--confirm", "00000000-0000-4000-8000-000000000001",
        "--dry-run",
      ], {
        openTenantClient: (() => { connectionAttempted = true; throw new Error("must not connect"); }) as any,
        openControlPlaneClient: (() => { connectionAttempted = true; throw new Error("must not connect"); }) as any,
      } as any);

      assert.equal(exit, 1);
      assert.ok(stderr.includes("Unknown option '--dry-run'"));
      assert.ok(stderr.includes("Only sweep options are accepted."));
      assert.equal(connectionAttempted, false, "Must not attempt connection when foreign flag is passed");
    } finally {
      console.error = origError;
    }
  });

  await t.test("census rejects --dry-run and foreign lifecycle flags before opening connection", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };
    let connectionAttempted = false;

    try {
      const exitDryRun = await runCensusCli([
        "--database-url", "postgres://u:p@localhost:5432/tenant",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--dry-run",
      ], {
        openTenantClient: (() => { connectionAttempted = true; throw new Error("must not connect"); }) as any,
      } as any);
      assert.equal(exitDryRun, 1);
      assert.ok(stderr.includes("Unknown option '--dry-run'"));
      assert.ok(stderr.includes("Only read-only census options are accepted."));
      assert.equal(connectionAttempted, false);

      stderr = "";
      const exitConfirm = await runCensusCli([
        "--database-url", "postgres://u:p@localhost:5432/tenant",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--confirm", "00000000-0000-4000-8000-000000000001",
      ], {
        openTenantClient: (() => { connectionAttempted = true; throw new Error("must not connect"); }) as any,
      } as any);
      assert.equal(exitConfirm, 1);
      assert.ok(stderr.includes("Unknown option '--confirm'"));
      assert.ok(stderr.includes("Only read-only census options are accepted."));
      assert.equal(connectionAttempted, false);
    } finally {
      console.error = origError;
    }
  });

  await t.test("publish rejects foreign flags from sweep/lifecycle before running publish logic", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };
    let runnerCalled = false;

    try {
      const exitModel = await runPublishCli([
        "--database-url", "postgres://u:p@localhost:5432/tenant",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--confirm", "00000000-0000-4000-8000-000000000001",
        "--model", "gpt-5.4-mini",
      ], {
        cpDb: { transaction: () => { runnerCalled = true; throw new Error("must not run"); } } as any,
      });
      assert.equal(exitModel, 1);
      assert.ok(stderr.includes("Unknown option '--model'"));
      assert.ok(stderr.includes("Only publish options are accepted."));
      assert.equal(runnerCalled, false);

      stderr = "";
      const exitMode = await runPublishCli([
        "--database-url", "postgres://u:p@localhost:5432/tenant",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--confirm", "00000000-0000-4000-8000-000000000001",
        "--mode", "copy",
      ], {
        cpDb: { transaction: () => { runnerCalled = true; throw new Error("must not run"); } } as any,
      });
      assert.equal(exitMode, 1);
      assert.ok(stderr.includes("Unknown option '--mode'"));
      assert.ok(stderr.includes("Only publish options are accepted."));
      assert.equal(runnerCalled, false);
    } finally {
      console.error = origError;
    }
  });
});

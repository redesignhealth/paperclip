/**
 * Regressions for non-waitable missing scope detection (TECH-8191 §Q3, PR5.7 RC-4).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runDrain } from "../../server/src/services/company-memory-upgrade/drain.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { sanitizeCliErrorMessage } from "../memory-upgrade.js";
import { runDrainCli } from "../memory-upgrade-drain.js";
import { LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES } from "../memory-upgrade-lifecycle-errors.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("drain missing-scope regression: immediate refusal, non-waitable (RC-4)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-missing-sc");
  t.after(async () => {
    await env.cleanup();
  });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 30 * 60_000);
  const observedAt = new Date(t0.getTime() - 25 * 60_000);

  await env.cpDb
    .update(companyMemoryDatabases)
    .set({
      scopeMigrationCompletedAt: markedAt,
      scopeMigrationMode: "copy",
      scopeMigrationAgentScopeObservedAt: observedAt,
      updatedAt: markedAt,
    })
    .where(eq(companyMemoryDatabases.companyId, env.company.id));

  const initialStreak = new Date("2026-11-11T10:00:00.000Z");
  const [upgrade] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "draining",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      markedAt,
      drainProbeStreakStartedAt: initialStreak,
      drainConfirmedAt: null,
    })
    .returning();

  // Insert live row whose payload has NO 'user_id'
  const secretMemoryText = "SECRET_CLASSIFIED_MEMORY_TEXT_NEVER_LOG";
  const unscopedRowId = randomUUID();
  await env.tenantSql`
    INSERT INTO mem0_memories (id, payload, vector)
    VALUES (
      ${unscopedRowId}::uuid,
      ${{ agent_id: env.agent.id, data: secretMemoryText, created_at: new Date().toISOString() }},
      'mock-vector-data'
    )
  `;

  let sleepCallCount = 0;
  const mockSleep = async () => {
    sleepCallCount++;
  };

  let capturedLogs = "";
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    capturedLogs += args.map(String).join(" ") + "\n";
    origError(...args);
  };

  try {
    // 1. Confirmed mode throws DRAIN_BLOCKED_MISSING_SCOPE immediately
    await assert.rejects(
      () =>
        runDrain(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            tenantDatabaseUrl: "postgres://unused",
            controlPlaneDatabaseUrl: "postgres://unused",
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            sleep: mockSleep,
            _internalSkipVectorIdentityCheck: true,
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "DRAIN_BLOCKED_MISSING_SCOPE",
    );

    // 2. Dry-run mode also throws DRAIN_BLOCKED_MISSING_SCOPE immediately
    await assert.rejects(
      () =>
        runDrain(
          {
            companyId: env.company.id,
            dryRun: true,
            tenantDatabaseUrl: "postgres://unused",
            controlPlaneDatabaseUrl: "postgres://unused",
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            sleep: mockSleep,
            _internalSkipVectorIdentityCheck: true,
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "DRAIN_BLOCKED_MISSING_SCOPE",
    );
  } finally {
    console.error = origError;
  }

  // 3. Sleep was never called (no waiting for timeout)
  assert.equal(sleepCallCount, 0);

  // 4. Stored timestamps are untouched
  const [current] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.equal(current.drainProbeStreakStartedAt?.toISOString(), initialStreak.toISOString());
  assert.equal(current.drainConfirmedAt, null);

  // 5. Diagnostic log check: count and probe limit present, zero memory text
  assert.ok(capturedLogs.includes("[drain_blocked_missing_scope]"));
  assert.ok(capturedLogs.includes("1"));
  assert.ok(capturedLogs.includes("1000"));
  assert.equal(capturedLogs.includes(secretMemoryText), false);

  // 6. Generic error message sanitization (upper and lower case forms)
  const upperErr = new CompanyMemoryUpgradeError("ignored raw message", "DRAIN_BLOCKED_MISSING_SCOPE");
  assert.equal(
    sanitizeCliErrorMessage(upperErr),
    `[DRAIN_BLOCKED_MISSING_SCOPE] ${LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES.DRAIN_BLOCKED_MISSING_SCOPE}`,
  );

  const lowerErr = new CompanyMemoryUpgradeError("ignored raw message", "drain_blocked_missing_scope");
  assert.equal(
    sanitizeCliErrorMessage(lowerErr),
    `[drain_blocked_missing_scope] ${LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES.drain_blocked_missing_scope}`,
  );

  // 7. runDrainCli returns exit code 1
  const cliExitCode = await runDrainCli(
    [
      "--database-url", env.tenantUrl,
      "--control-plane-url", env.cpUrl,
      "--company", env.company.id,
      "--confirm", env.company.id,
      "--once",
    ],
    { env: { MEMORY_UPGRADE_ALLOW_PROD: "1" } },
  );
  assert.equal(cliExitCode, 1);
});

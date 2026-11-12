/**
 * Single-agent pilot summary invalid token isolation and privacy tests
 * (TECH-8191 review finding 5).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  agents,
  companyMemoryUpgrades,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";
import { formatFlipReport, runFlip } from "../../server/src/services/company-memory-upgrade/flip.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("flip report pilot summary isolates invalid flag config and leaks no secrets (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("flip-pilot-invalid");
  t.after(async () => {
    await env.cleanup();
  });

  await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "sweeping",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

  // Valid flag agent
  const [flagAgent] = await env.cpDb
    .insert(agents)
    .values({
      companyId: env.company.id,
      name: "Valid Flag Agent",
      adapterType: "hermes_local",
      adapterConfig: {
        env: {
          PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0",
          SECRET_KEY_A: "secret_value_alpha",
        },
      },
    })
    .returning();

  // Invalid flag config agent
  const [invalidAgent] = await env.cpDb
    .insert(agents)
    .values({
      companyId: env.company.id,
      name: "Invalid Flag Agent",
      adapterType: "hermes_local",
      adapterConfig: {
        env: {
          PAPERCLIP_MEMORY_HARDENING: "unknown-flag-token,another-bad-token",
          TOP_SECRET_INVALID_VAL: "secret_should_never_leak_xyz",
        },
      },
    })
    .returning();

  // Run dry run flip
  const dryReport = await runFlip(
    {
      companyId: env.company.id,
      tenantDatabaseUrl: "postgres://unused",
      controlPlaneDatabaseUrl: "postgres://unused",
    },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );

  // finding 5 assertions:
  // 1. Invalid agent appears in invalid list
  assert.ok(
    dryReport.agentScopePilotSummary.agentsWithInvalidFlagConfig.includes(invalidAgent.id),
    "Invalid agent must appear in agentsWithInvalidFlagConfig",
  );
  assert.ok(
    dryReport.agentsWithInvalidFlagConfig.includes(invalidAgent.id),
    "Invalid agent must appear in top-level agentsWithInvalidFlagConfig",
  );

  // 2. Invalid agent does NOT appear in flagged list
  assert.ok(
    !dryReport.agentScopePilotSummary.agentsWithFlagInConfig.includes(invalidAgent.id),
    "Invalid agent must NOT appear in agentsWithFlagInConfig",
  );
  assert.deepEqual(dryReport.agentScopePilotSummary.agentsWithFlagInConfig, [flagAgent.id]);

  // 3. Text output contains invalid agent ID and warning line, but zero secrets
  const textReport = formatFlipReport(dryReport, "text");
  assert.ok(textReport.includes(invalidAgent.id));
  assert.match(textReport, /Warning: Agent config will fail at run time until fixed/);
  assert.ok(!textReport.includes("unknown-flag-token"));
  assert.ok(!textReport.includes("another-bad-token"));
  assert.ok(!textReport.includes("TOP_SECRET_INVALID_VAL"));
  assert.ok(!textReport.includes("secret_should_never_leak_xyz"));
  assert.ok(!textReport.includes("secret_value_alpha"));
  assert.ok(!textReport.includes("SECRET_KEY_A"));

  // 4. JSON output contains invalid agent ID, but zero secrets
  const jsonReport = formatFlipReport(dryReport, "json");
  assert.ok(jsonReport.includes(invalidAgent.id));
  assert.ok(!jsonReport.includes("unknown-flag-token"));
  assert.ok(!jsonReport.includes("another-bad-token"));
  assert.ok(!jsonReport.includes("TOP_SECRET_INVALID_VAL"));
  assert.ok(!jsonReport.includes("secret_should_never_leak_xyz"));
  assert.ok(!jsonReport.includes("secret_value_alpha"));
  assert.ok(!jsonReport.includes("SECRET_KEY_A"));
});

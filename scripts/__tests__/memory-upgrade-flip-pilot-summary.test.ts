/**
 * Single-agent pilot summary and env privacy tests (TECH-8191 PR5.6 scope addition).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { agents, companyMemoryUpgrades, getEmbeddedPostgresTestSupport, handleEmbeddedPostgresUnsupported } from "./memory-upgrade-sweep-helpers.js";
import { formatFlipReport, runFlip } from "../../server/src/services/company-memory-upgrade/flip.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("flip report single-agent pilot summary and privacy (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("flip-pilot");
  t.after(async () => { await env.cleanup(); });

  const [upgrade] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id, state: "sweeping",
      converterId: "paperclip.memory-upgrade.atomic-converter", converterVersion: 1, collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
    })
    .returning();

  // Create two additional agents:
  // Agent 1: Hermes agent WITH PAPERCLIP_MEMORY_HARDENING="agent-scoped-mem0" and a secret env key
  const [flagAgent] = await env.cpDb
    .insert(agents)
    .values({
      companyId: env.company.id,
      name: "Chief of Staff",
      adapterType: "hermes_local",
      adapterConfig: {
        env: {
          PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0",
          SUPER_SECRET_ENV_KEY: "secret_value_12345",
        },
      },
    })
    .returning();

  // Agent 2: Hermes agent WITHOUT hardening flag, with sensitive env key
  const [noFlagAgent] = await env.cpDb
    .insert(agents)
    .values({
      companyId: env.company.id,
      name: "Researcher",
      adapterType: "hermes_local",
      adapterConfig: {
        env: {
          OTHER_ENV_KEY: "another_secret_67890",
        },
      },
    })
    .returning();

  // Agent 3: Non-Hermes agent WITH hardening flag (should NOT be counted in hermes_local)
  await env.cpDb
    .insert(agents)
    .values({
      companyId: env.company.id,
      name: "External Bot",
      adapterType: "other_adapter",
      adapterConfig: {
        env: { PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0" },
      },
    });

  // Run dry run flip
  const dryReport = await runFlip(
    { companyId: env.company.id, tenantDatabaseUrl: "postgres://unused", controlPlaneDatabaseUrl: "postgres://unused" },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );

  // Total Hermes agents: setupPublishTestEnvironment created 1 agent ("env.agent"), plus flagAgent and noFlagAgent = 3
  assert.equal(dryReport.agentScopePilotSummary.totalHermesAgents, 3);
  assert.deepEqual(dryReport.agentScopePilotSummary.agentsWithFlagInConfig, [flagAgent.id]);
  assert.ok(!dryReport.agentScopePilotSummary.agentsWithFlagInConfig.includes(noFlagAgent.id));
  assert.match(dryReport.scopeWarning, /every Hermes agent in the company switches/);

  // Text report check: contains flag agent ID, does NOT contain secret env values or keys
  const textReport = formatFlipReport(dryReport, "text");
  assert.ok(textReport.includes(flagAgent.id));
  assert.ok(!textReport.includes("secret_value_12345"));
  assert.ok(!textReport.includes("SUPER_SECRET_ENV_KEY"));
  assert.ok(!textReport.includes("another_secret_67890"));

  // JSON report check: contains flag agent ID, does NOT contain secret env values or keys
  const jsonReport = formatFlipReport(dryReport, "json");
  assert.ok(jsonReport.includes(flagAgent.id));
  assert.ok(!jsonReport.includes("secret_value_12345"));
  assert.ok(!jsonReport.includes("SUPER_SECRET_ENV_KEY"));
  assert.ok(!jsonReport.includes("another_secret_67890"));
});

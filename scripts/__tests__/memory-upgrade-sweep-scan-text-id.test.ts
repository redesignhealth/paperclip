/**
 * Tests for source scan exclusion on text-id collections with index usage (TECH-8191 §5.1).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  iterateSourcePages,
  openTenantClient,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("source scan excludes published and partial-crash rows on text-id collection with index usage (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("sw-ex-text-");
  const tenantSql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  const upgradeId = randomUUID();
  const agentId = randomUUID();

  // Create staging tables with idempotent DDL including indexes
  await ensureUpgradeTables(tenantSql, "text");

  // Create text-id collection table
  await tenantSql.unsafe(`
    CREATE TABLE IF NOT EXISTS mem0_text_memories (
      id text PRIMARY KEY,
      payload jsonb NOT NULL,
      vector text NOT NULL
    );
  `);

  const textPubOutputId = randomUUID();
  const textCrashOutputId = randomUUID();

  // Insert published row into staging
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
    ) VALUES (
      ${upgradeId}::uuid, ${randomUUID()}::uuid, ${textPubOutputId}::uuid, ${agentId}::uuid,
      '{"data": "published-text"}'::jsonb, 'vec', 'sha1', now()
    );
  `;

  // Insert partial-crash row into staging (published_at IS NULL)
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
    ) VALUES (
      ${upgradeId}::uuid, ${randomUUID()}::uuid, ${textCrashOutputId}::uuid, ${agentId}::uuid,
      '{"data": "crashed-text"}'::jsonb, 'vec', 'sha2', NULL
    );
  `;

  // Populate live text collection table:
  // - textPubOutputId in uppercase to test case-insensitivity with COLLATE "C"
  // - textCrashOutputId in lowercase (partial-crash live insert)
  // - two un-upgraded legacy text rows
  const legacy1 = "legacy-text-aaa";
  const legacy2 = "legacy-text-zzz";
  await tenantSql.unsafe(
    `INSERT INTO mem0_text_memories (id, payload, vector) VALUES
      ($1, '{"data": "pub"}'::jsonb, 'vec'),
      ($2, '{"data": "crash"}'::jsonb, 'vec'),
      ($3, '{"data": "leg1"}'::jsonb, 'vec'),
      ($4, '{"data": "leg2"}'::jsonb, 'vec');`,
    [textPubOutputId.toUpperCase(), textCrashOutputId.toLowerCase(), legacy1, legacy2],
  );

  // Verify EXPLAIN plan for text exclusion uses lower expression index
  await tenantSql.unsafe("SET enable_hashjoin = off; SET enable_mergejoin = off; SET enable_seqscan = off;");
  const planText = await tenantSql.unsafe(`
    EXPLAIN SELECT lower(t.id::text) AS id FROM mem0_text_memories t
    WHERE NOT EXISTS (SELECT 1 FROM paperclip_memory_upgrade_staging s WHERE lower(s.output_id::text) = lower(t.id::text))
  `) as Array<Record<string, string>>;
  const planTextStr = planText.map((r) => Object.values(r)[0]).join("\n");
  assert.ok(
    planTextStr.includes("pmu_staging_output_id_lower_idx"),
    `Text query plan must use pmu_staging_output_id_lower_idx: ${planTextStr}`,
  );
  await tenantSql.unsafe("SET enable_hashjoin = on; SET enable_mergejoin = on; SET enable_seqscan = on;");

  // Iterate pages with small page size to exercise both initial and continuation keyset branches
  const yielded: string[] = [];
  for await (const page of iterateSourcePages(tenantSql, "mem0_text_memories", {
    pageSize: 1,
    isUuidId: false,
  })) {
    for (const row of page) {
      yielded.push(row.id);
    }
  }

  // Published row (even uppercase in live) must be excluded
  assert.ok(!yielded.includes(textPubOutputId.toLowerCase()), "published output must be excluded");
  // Partial-crash row (published_at IS NULL) must be excluded
  assert.ok(!yielded.includes(textCrashOutputId.toLowerCase()), "partial-crash output must be excluded");
  // Only legitimate legacy rows yielded
  assert.deepEqual(yielded.sort(), [legacy1, legacy2].sort());
});

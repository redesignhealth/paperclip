/**
 * Real pgvector Docker integration tests (TECH-8191 PR 4a).
 * Tests 24, 25, 27 from §7.4.
 *
 * Gated on PAPERCLIP_RUN_DOCKER_PGVECTOR_TESTS === "true".
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ensureUpgradeTables,
  introspectCollection,
  openTenantClient,
  stageSourceRecords,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  publishSourceBatch,
  resolveLiveVectorCast,
} from "../../server/src/services/company-memory-upgrade/publish-tenant.js";

test("pgvector docker integration", { skip: process.env.PAPERCLIP_RUN_DOCKER_PGVECTOR_TESTS !== "true" }, async (t) => {
  const dockerDsn = process.env.PAPERCLIP_TEST_DOCKER_PGVECTOR_URL;
  if (!dockerDsn) {
    return;
  }

  const sql = openTenantClient(dockerDsn);
  t.after(async () => {
    await sql.end();
  });

  const uniqueSuffix = Date.now().toString(36);
  const liveTable = `mem0_docker_live_${uniqueSuffix}`;
  const upgradeId = randomUUID();
  const agentId = randomUUID();
  const sourceId = randomUUID();
  const outputId = randomUUID();
  const fakeEmbedding = Array.from({ length: 1536 }, (_, i) => (i % 100) / 100);

  // Test 24: CREATE EXTENSION IF NOT EXISTS vector, create live table with vector(1536), ensureUpgradeTables with vector(1536)
  await t.test("Test 24: ensureUpgradeTables creates real pgvector(1536) staging column", async () => {
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${liveTable}" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        payload jsonb NOT NULL,
        vector vector(1536) NOT NULL
      );
    `);

    await ensureUpgradeTables(sql, "vector(1536)");

    const stagingColRows = (await sql`
      SELECT
        format_type(a.atttypid, a.atttypmod) AS formatted_type
      FROM pg_attribute a
      WHERE a.attrelid = to_regclass('paperclip_memory_upgrade_staging')
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped;
    `) as Array<{ formatted_type: string }>;

    assert.equal(stagingColRows.length, 1);
    assert.equal(stagingColRows[0].formatted_type, "vector(1536)");
  });

  // Test 27: introspectCollection with NO skipVectorIdentityCheck
  await t.test("Test 27: introspectCollection passes pgvector identity check and returns embeddingTypeRaw === 'vector(1536)'", async () => {
    const shape = await introspectCollection(sql, liveTable, { skipVectorIdentityCheck: false });
    assert.equal(shape.embeddingType, "vector(1536)");
    assert.equal(shape.embeddingTypeRaw, "vector(1536)");
    assert.equal(shape.embeddingDims, 1536);
    assert.equal(shape.isUuidId, true);
  });

  // Test 25: stageSourceRecords with a real 1536-float embedding and NO vectorType: "text"
  await t.test("Test 25: stageSourceRecords parameterised cast inserts real vector and vector_dims returns 1536", async () => {
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

    const stageRes = await stageSourceRecords(
      sql,
      {
        upgradeId,
        sourceId,
        sourceContentSha256: "real_pgvector_sha",
        agentId,
        records: [
          {
            outputId,
            dataSha256: "real_vector_rec_sha",
            payload: { text: "real pgvector memory", migration_id: upgradeId, migrated_from: sourceId },
            embedding: fakeEmbedding,
          },
        ],
        vectorType: "vector(1536)",
      },
      fence,
    );

    assert.equal(stageRes.outcome, "published");
    assert.equal(stageRes.stagedCount, 1);

    // Verify vector_dims on the inserted staging row
    const dimsRows = (await sql`
      SELECT
        vector_dims(embedding) AS dims,
        (embedding)::text AS vec_text,
        jsonb_typeof(payload) AS payload_type,
        payload->>'text' AS payload_text,
        payload->>'migration_id' AS payload_migration_id
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputId}::uuid;
    `) as Array<{ dims: number; vec_text: string; payload_type: string; payload_text: string; payload_migration_id: string }>;

    assert.equal(dimsRows.length, 1);
    assert.equal(dimsRows[0].dims, 1536);
    assert.equal(dimsRows[0].payload_type, "object");
    assert.equal(dimsRows[0].payload_text, "real pgvector memory");
    assert.equal(dimsRows[0].payload_migration_id, upgradeId);
  });

  // Test 26: publishSourceBatch with resolveLiveVectorCast returning null
  await t.test("Test 26: publishSourceBatch with resolveLiveVectorCast null round-trips real pgvector floats", async () => {
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
    const shape = await introspectCollection(sql, liveTable, { skipVectorIdentityCheck: false });
    const vectorCast = resolveLiveVectorCast(shape, "vector(1536)");
    assert.equal(vectorCast, null);

    const pubRes = await publishSourceBatch(
      sql,
      { upgradeId, sourceIds: [sourceId], tableName: liveTable, shape, vectorCast },
      fence,
    );
    assert.equal(pubRes.insertedCount, 1);
    assert.equal(pubRes.publishedCount, 1);

    // Inspect fixture staged embedding
    const stagingVecRows = (await sql`
      SELECT
        vector_dims(embedding) AS dims,
        (embedding)::text AS vec_text
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputId}::uuid;
    `) as Array<{ dims: number; vec_text: string }>;

    assert.equal(stagingVecRows.length, 1);
    assert.equal(stagingVecRows[0].dims, 1536);

    // Inspect live table row
    const liveVecRows = (await sql.unsafe(`
      SELECT vector_dims(vector) as dims, vector::text as vec_text, jsonb_typeof(payload) as payload_type, payload->>'text' as payload_text, payload
      FROM "${liveTable}" WHERE id = $1::uuid;
    `, [outputId])) as Array<{ dims: number; vec_text: string; payload_type: string; payload_text: string; payload: any }>;

    assert.equal(liveVecRows.length, 1);
    assert.equal(liveVecRows[0].dims, 1536);
    assert.equal(liveVecRows[0].payload_type, "object");
    assert.equal(liveVecRows[0].payload_text, "real pgvector memory");
    assert.equal(typeof liveVecRows[0].payload, "object");
    assert.notEqual(liveVecRows[0].payload, null);

    // Verify live table vector exactly matches staged embedding and roundtrips input floats
    assert.equal(liveVecRows[0].vec_text, stagingVecRows[0].vec_text);
    const liveFloats = JSON.parse(liveVecRows[0].vec_text) as number[];
    assert.equal(liveFloats.length, fakeEmbedding.length);
    for (let i = 0; i < fakeEmbedding.length; i++) {
      assert.ok(
        Math.abs(liveFloats[i] - fakeEmbedding[i]) < 1e-5,
        `vector element ${i} mismatch: got ${liveFloats[i]}, expected ${fakeEmbedding[i]}`,
      );
    }
  });
});

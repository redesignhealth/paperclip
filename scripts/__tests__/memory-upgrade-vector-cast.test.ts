/**
 * Safe catalog type cast and staging embedding introspection tests (TECH-8191 PR 4a).
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
import {
  publishSourceBatch,
  resolveLiveVectorCast,
} from "../../server/src/services/company-memory-upgrade/publish-tenant.js";
import { computeRecordDataSha256 } from "../../server/src/services/company-memory-upgrade/converter-contract.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  assertSafeCatalogTypeCast,
  introspectStagingEmbeddingType,
  resolveStagingVectorType,
} from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("safe catalog type cast validation (unit)", () => {
  // Valid types
  const valid = [
    "vector(1536)",
    '"vector(1536)"',
    "extensions.vector(1536)",
    'public."vector"(1536)',
    "numeric(10,2)",
    "text",
    "jsonb",
    "uuid",
    "custom_type",
    '"my_schema"."my_type"',
  ];
  for (const t of valid) {
    assert.doesNotThrow(() => assertSafeCatalogTypeCast(t), `Expected "${t}" to be valid`);
  }

  // Invalid types
  const invalid = [
    "vector(1536); DROP TABLE t",
    "text) --",
    '"unclosed_quote',
    "",
    "   ",
    "a".repeat(129), // > 128 chars
    "type with spaces",
    "vector(1536) /* comment */",
  ];
  for (const t of invalid) {
    assert.throws(
      () => assertSafeCatalogTypeCast(t),
      (err: any) => err?.code === "UNSAFE_CATALOG_TYPE",
      `Expected "${t}" to be rejected with UNSAFE_CATALOG_TYPE`,
    );
  }
});

test("staging embedding type introspection (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("vector-cast-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(sql, "mem0_memories");
  await ensureUpgradeTables(sql, "text");

  await t.test("introspectStagingEmbeddingType returns unstripped type and validates safe catalog cast", async () => {
    const stagingType = await introspectStagingEmbeddingType(sql);
    assert.equal(stagingType, "text");
  });
});

test("resolveStagingVectorType unit matrix (stub catalog reader)", async () => {
  const makeStub = (rows: Array<{ formatted_type: string }>) => {
    let calls = 0;
    return {
      sql: {
        unsafe: async (_query: string) => {
          calls++;
          return rows;
        },
      },
      getCalls: () => calls,
    };
  };

  // 1: [] (no rows) -> throws SCHEMA_INIT_FAILED
  {
    const stub = makeStub([]);
    await assert.rejects(
      () => resolveStagingVectorType(stub.sql, "text"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "SCHEMA_INIT_FAILED",
    );
    assert.equal(stub.getCalls(), 1);
  }

  // 2: detected text, requested vector(1536) -> throws STAGING_VECTOR_TYPE_MISMATCH (silent-text-storage case)
  {
    const stub = makeStub([{ formatted_type: "text" }]);
    await assert.rejects(
      () => resolveStagingVectorType(stub.sql, "vector(1536)"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STAGING_VECTOR_TYPE_MISMATCH",
    );
    assert.equal(stub.getCalls(), 1);
  }

  // 3: detected vector(1536), requested text -> throws STAGING_VECTOR_TYPE_MISMATCH (text path no longer skips introspection)
  {
    const stub = makeStub([{ formatted_type: "vector(1536)" }]);
    await assert.rejects(
      () => resolveStagingVectorType(stub.sql, "text"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STAGING_VECTOR_TYPE_MISMATCH",
    );
    assert.equal(stub.getCalls(), 1);
  }

  // 4: detected vector(768), requested vector(1536) -> throws UNSUPPORTED_VECTOR_TYPE (stale column cannot override contract)
  {
    const stub = makeStub([{ formatted_type: "vector(768)" }]);
    await assert.rejects(
      () => resolveStagingVectorType(stub.sql, "vector(1536)"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSUPPORTED_VECTOR_TYPE",
    );
    assert.equal(stub.getCalls(), 1);
  }

  // 5: detected public.vector(1536), requested vector(1536) -> throws UNSUPPORTED_VECTOR_TYPE (schema-qualified cannot sneak in via catalog)
  {
    const stub = makeStub([{ formatted_type: "public.vector(1536)" }]);
    await assert.rejects(
      () => resolveStagingVectorType(stub.sql, "vector(1536)"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSUPPORTED_VECTOR_TYPE",
    );
    assert.equal(stub.getCalls(), 1);
  }

  // 6: detected jsonb, requested text -> throws STAGING_VECTOR_TYPE_MISMATCH (not INVALID_ARGUMENT)
  {
    const stub = makeStub([{ formatted_type: "jsonb" }]);
    await assert.rejects(
      () => resolveStagingVectorType(stub.sql, "text"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STAGING_VECTOR_TYPE_MISMATCH",
    );
    assert.equal(stub.getCalls(), 1);
  }

  // 7: detected character varying(100), requested text -> throws UNSAFE_CATALOG_TYPE
  {
    const stub = makeStub([{ formatted_type: "character varying(100)" }]);
    await assert.rejects(
      () => resolveStagingVectorType(stub.sql, "text"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSAFE_CATALOG_TYPE",
    );
    assert.equal(stub.getCalls(), 1);
  }

  // 8: text / vector(1536) matches same -> resolves to "text" / "vector(1536)"
  {
    const stubText = makeStub([{ formatted_type: "text" }]);
    const resText = await resolveStagingVectorType(stubText.sql, "text");
    assert.equal(resText, "text");

    const stubVec = makeStub([{ formatted_type: "vector(1536)" }]);
    const resVec = await resolveStagingVectorType(stubVec.sql, "vector(1536)");
    assert.equal(resVec, "vector(1536)");
  }

  // 9: stub must not be called when requested is invalid/unsupported: public.vector(1536)
  {
    const stub = makeStub([{ formatted_type: "text" }]);
    await assert.rejects(
      () => resolveStagingVectorType(stub.sql, "public.vector(1536)"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSUPPORTED_VECTOR_TYPE",
    );
    assert.equal(stub.getCalls(), 0);
  }
});

test("staging vector type validation on drifted tables (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("vector-cast-drift-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(sql, "mem0_memories");

  // Case 12: Happy path unchanged: ensureUpgradeTables(sql, "text") twice resolves,
  // and resolveStagingVectorType(sql, "text") === "text".
  await t.test("happy path: ensureUpgradeTables idempotently resolves matching staging vector type", async () => {
    await ensureUpgradeTables(sql, "text");
    await ensureUpgradeTables(sql, "text");
    const resolved = await resolveStagingVectorType(sql, "text");
    assert.equal(resolved, "text");
  });

  // Alter staging embedding column to jsonb to simulate drift
  await sql.unsafe(`
    ALTER TABLE paperclip_memory_upgrade_staging
    ALTER COLUMN embedding TYPE jsonb USING '{}'::jsonb;
  `);

  // Case 10: Pre-created/drifted table with jsonb embedding -> ensureUpgradeTables(sql, "text") rejects
  await t.test("ensureUpgradeTables rejects pre-existing drifted staging table with mismatch", async () => {
    await assert.rejects(
      () => ensureUpgradeTables(sql, "text"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STAGING_VECTOR_TYPE_MISMATCH",
    );
  });

  // Case 11: stageSourceRecords on drifted table rejects and leaves staging count unchanged
  await t.test("stageSourceRecords rejects drifted staging table and rolls back without writing rows", async () => {
    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

    const [{ count: countBefore }] = (await sql.unsafe(
      "SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging",
    )) as Array<{ count: number }>;

    await assert.rejects(
      () =>
        stageSourceRecords(
          sql,
          {
            upgradeId,
            sourceId,
            sourceContentSha256: "hash-test",
            agentId,
            records: [
              {
                outputId: randomUUID(),
                dataSha256: computeRecordDataSha256("test memory data for drifted table"),
                payload: { data: "test memory data for drifted table", agent_id: agentId },
                embedding: new Array(1536).fill(0.01),
              },
            ],
            vectorType: "text",
          },
          fence,
        ),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STAGING_VECTOR_TYPE_MISMATCH",
    );

    const [{ count: countAfter }] = (await sql.unsafe(
      "SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging",
    )) as Array<{ count: number }>;

    assert.equal(countAfter, countBefore);
  });
});

test("staging and publish jsonb object payload regression (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("jsonb-regression-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  // 1. Tagged text-vector path (tx tagged template with ::jsonb)
  await t.test("tagged text-vector path stages and publishes true jsonb object", async () => {
    const liveTable = "mem0_text_live";
    await setupTenantMem0Table(sql, liveTable);
    await ensureUpgradeTables(sql, "text");

    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const outputId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

    const testPayload = {
      data: "text vector payload data",
      user_id: "user-text-123",
      agent_id: agentId,
      migration_id: upgradeId,
      migrated_from: sourceId,
    };

    const stageRes = await stageSourceRecords(
      sql,
      {
        upgradeId,
        sourceId,
        sourceContentSha256: "hash-text-stage",
        agentId,
        records: [
          {
            outputId,
            dataSha256: computeRecordDataSha256(testPayload.data),
            payload: testPayload,
            embedding: new Array(1536).fill(0.01),
          },
        ],
        vectorType: "text",
      },
      fence,
    );
    assert.equal(stageRes.outcome, "published");

    // Database assertions on staging row: NOT JS unwrap
    const [stagingRow] = (await sql`
      SELECT
        jsonb_typeof(payload) AS payload_type,
        payload->>'data' AS data,
        payload->>'user_id' AS user_id,
        payload->>'agent_id' AS agent_id,
        payload
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputId}::uuid;
    `) as Array<{
      payload_type: string;
      data: string | null;
      user_id: string | null;
      agent_id: string | null;
      payload: any;
    }>;

    assert.equal(stagingRow.payload_type, "object");
    assert.equal(stagingRow.data, "text vector payload data");
    assert.equal(stagingRow.user_id, "user-text-123");
    assert.equal(stagingRow.agent_id, agentId);
    assert.equal(typeof stagingRow.payload, "object");
    assert.notEqual(stagingRow.payload, null);

    // Staging -> publish roundtrip
    const shape = await introspectCollection(sql, liveTable, { skipVectorIdentityCheck: true });
    const vectorCast = resolveLiveVectorCast(shape, "text");
    const pubRes = await publishSourceBatch(
      sql,
      { upgradeId, sourceIds: [sourceId], tableName: liveTable, shape, vectorCast },
      fence,
    );
    assert.equal(pubRes.insertedCount, 1);
    assert.equal(pubRes.publishedCount, 1);

    // Database assertions on live collection table: NOT JS unwrap
    const [liveRow] = (await sql.unsafe(
      `SELECT
        jsonb_typeof(payload) AS live_payload_type,
        payload->>'data' AS live_data,
        payload->>'user_id' AS live_user_id,
        payload->>'agent_id' AS live_agent_id,
        payload
      FROM "${liveTable}"
      WHERE id = $1::uuid;`,
      [outputId],
    )) as Array<{
      live_payload_type: string;
      live_data: string | null;
      live_user_id: string | null;
      live_agent_id: string | null;
      payload: any;
    }>;

    assert.equal(liveRow.live_payload_type, "object");
    assert.equal(liveRow.live_data, "text vector payload data");
    assert.equal(liveRow.live_user_id, "user-text-123");
    assert.equal(liveRow.live_agent_id, agentId);
    assert.equal(typeof liveRow.payload, "object");
    assert.notEqual(liveRow.payload, null);
  });

  // 2. Unsafe domain-vector path (tx.unsafe with $5::jsonb and resolvedCastType)
  await t.test("unsafe domain-vector path stages and publishes true jsonb object", async () => {
    // Drop upgrade tables to re-create staging with vector(1536) embedding column
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_staging CASCADE;`;
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_ledger CASCADE;`;
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_dedupe CASCADE;`;
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_fence CASCADE;`;

    await sql.unsafe(`
      CREATE FUNCTION vector_in(cstring, oid, integer) RETURNS vector LANGUAGE internal IMMUTABLE STRICT AS 'textin';
      CREATE FUNCTION vector_out(vector) RETURNS cstring LANGUAGE internal IMMUTABLE STRICT AS 'textout';
      CREATE FUNCTION vector_typmod_in(cstring[]) RETURNS integer LANGUAGE internal IMMUTABLE STRICT AS 'varchartypmodin';
      CREATE FUNCTION vector_typmod_out(integer) RETURNS cstring LANGUAGE internal IMMUTABLE STRICT AS 'varchartypmodout';
      CREATE TYPE vector (
        INPUT = vector_in,
        OUTPUT = vector_out,
        TYPMOD_IN = vector_typmod_in,
        TYPMOD_OUT = vector_typmod_out
      );
    `);

    const liveTable = "mem0_domain_live";
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${liveTable}" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        payload jsonb NOT NULL,
        vector vector(1536) NOT NULL
      );
    `);
    await ensureUpgradeTables(sql, "vector(1536)");

    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const outputId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

    const testPayload = {
      data: "domain vector payload data",
      user_id: "user-domain-456",
      agent_id: agentId,
      migration_id: upgradeId,
      migrated_from: sourceId,
    };

    const stageRes = await stageSourceRecords(
      sql,
      {
        upgradeId,
        sourceId,
        sourceContentSha256: "hash-domain-stage",
        agentId,
        records: [
          {
            outputId,
            dataSha256: computeRecordDataSha256(testPayload.data),
            payload: testPayload,
            embedding: new Array(1536).fill(0.02),
          },
        ],
        vectorType: "vector(1536)",
      },
      fence,
    );
    assert.equal(stageRes.outcome, "published");

    // Database assertions on staging row: NOT JS unwrap
    const [stagingRow] = (await sql`
      SELECT
        jsonb_typeof(payload) AS payload_type,
        payload->>'data' AS data,
        payload->>'user_id' AS user_id,
        payload->>'agent_id' AS agent_id,
        payload
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputId}::uuid;
    `) as Array<{
      payload_type: string;
      data: string | null;
      user_id: string | null;
      agent_id: string | null;
      payload: any;
    }>;

    assert.equal(stagingRow.payload_type, "object");
    assert.equal(stagingRow.data, "domain vector payload data");
    assert.equal(stagingRow.user_id, "user-domain-456");
    assert.equal(stagingRow.agent_id, agentId);
    assert.equal(typeof stagingRow.payload, "object");
    assert.notEqual(stagingRow.payload, null);

    // Staging -> publish roundtrip
    const shape = await introspectCollection(sql, liveTable, { skipVectorIdentityCheck: true });
    const vectorCast = resolveLiveVectorCast(shape, "vector(1536)");
    const pubRes = await publishSourceBatch(
      sql,
      { upgradeId, sourceIds: [sourceId], tableName: liveTable, shape, vectorCast },
      fence,
    );
    assert.equal(pubRes.insertedCount, 1);
    assert.equal(pubRes.publishedCount, 1);

    // Database assertions on live collection table: NOT JS unwrap
    const [liveRow] = (await sql.unsafe(
      `SELECT
        jsonb_typeof(payload) AS live_payload_type,
        payload->>'data' AS live_data,
        payload->>'user_id' AS live_user_id,
        payload->>'agent_id' AS live_agent_id,
        payload
      FROM "${liveTable}"
      WHERE id = $1::uuid;`,
      [outputId],
    )) as Array<{
      live_payload_type: string;
      live_data: string | null;
      live_user_id: string | null;
      live_agent_id: string | null;
      payload: any;
    }>;

    assert.equal(liveRow.live_payload_type, "object");
    assert.equal(liveRow.live_data, "domain vector payload data");
    assert.equal(liveRow.live_user_id, "user-domain-456");
    assert.equal(liveRow.live_agent_id, agentId);
    assert.equal(typeof liveRow.payload, "object");
    assert.notEqual(liveRow.payload, null);
  });

  // 3. Live table with payload column type 'json' (tests s.payload::json cast path in publishSourceBatch)
  await t.test("live table with json payload column publishes true json object", async () => {
    // Drop upgrade tables to re-create staging with text embedding column
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_staging CASCADE;`;
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_ledger CASCADE;`;
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_dedupe CASCADE;`;
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_fence CASCADE;`;

    const liveTable = "mem0_json_col_live";
    await sql.unsafe(`
      DO $$ BEGIN
        CREATE DOMAIN "vector(1536)" AS text;
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${liveTable}" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        payload json NOT NULL,
        vector "vector(1536)" NOT NULL
      );
    `);
    await ensureUpgradeTables(sql, "text");

    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const outputId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

    const testPayload = {
      data: "json column payload data",
      user_id: "user-json-789",
      agent_id: agentId,
      migration_id: upgradeId,
      migrated_from: sourceId,
    };

    const stageRes = await stageSourceRecords(
      sql,
      {
        upgradeId,
        sourceId,
        sourceContentSha256: "hash-json-stage",
        agentId,
        records: [
          {
            outputId,
            dataSha256: computeRecordDataSha256(testPayload.data),
            payload: testPayload,
            embedding: new Array(1536).fill(0.01),
          },
        ],
        vectorType: "text",
      },
      fence,
    );
    assert.equal(stageRes.outcome, "published");

    const shape = await introspectCollection(sql, liveTable, { skipVectorIdentityCheck: true });
    assert.equal(shape.payloadType, "json");
    const vectorCast = resolveLiveVectorCast(shape, "text");
    const pubRes = await publishSourceBatch(
      sql,
      { upgradeId, sourceIds: [sourceId], tableName: liveTable, shape, vectorCast },
      fence,
    );
    assert.equal(pubRes.insertedCount, 1);
    assert.equal(pubRes.publishedCount, 1);

    // Database assertions on live collection table with json column: assert json_typeof in SQL
    const [liveRow] = (await sql.unsafe(
      `SELECT
        json_typeof(payload) AS live_payload_type,
        payload->>'data' AS live_data,
        payload->>'user_id' AS live_user_id,
        payload->>'agent_id' AS live_agent_id,
        payload
      FROM "${liveTable}"
      WHERE id = $1::uuid;`,
      [outputId],
    )) as Array<{
      live_payload_type: string;
      live_data: string | null;
      live_user_id: string | null;
      live_agent_id: string | null;
      payload: any;
    }>;

    assert.equal(liveRow.live_payload_type, "object");
    assert.equal(liveRow.live_data, "json column payload data");
    assert.equal(liveRow.live_user_id, "user-json-789");
    assert.equal(liveRow.live_agent_id, agentId);
    assert.equal(typeof liveRow.payload, "object");
    assert.notEqual(liveRow.payload, null);
  });
});

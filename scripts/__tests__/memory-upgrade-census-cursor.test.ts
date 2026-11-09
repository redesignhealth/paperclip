import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runCensus,
} from "../../server/src/services/company-memory-upgrade/census.js";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-census-helpers.js";

describe("census native cursor pagination and snapshot consistency integration tests", () => {
  it("paginates with native cursor crossing page boundaries with no skipped or repeated rows", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_pagination");
    const adminDb = createDb(fixture.connectionString);

    try {
      await adminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await adminDb.execute(sql`
        CREATE TABLE mem0_memories (
          id UUID PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`CREATE ROLE tenant_checker WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_checker;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_checker;`);

      // Insert 5 rows with UUID keys
      const rowIds = [
        "11111111-1111-4111-8111-000000000001",
        "11111111-1111-4111-8111-000000000002",
        "11111111-1111-4111-8111-000000000003",
        "11111111-1111-4111-8111-000000000004",
        "11111111-1111-4111-8111-000000000005",
      ];

      for (let i = 0; i < rowIds.length; i++) {
        await adminDb.execute(sql`
          INSERT INTO mem0_memories (id, vector, payload)
          VALUES (${rowIds[i]}::uuid, '[]', ${JSON.stringify({
            agent_id: "00000000-0000-4000-8000-000000000001",
            user_id: `user-${i + 1}`,
            data: `Substantive preference ${i + 1}`,
          })}::jsonb);
        `);
      }

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      // Run census with pageSize = 2 to force crossing 3 page boundaries
      const report = await runCensus({
        databaseUrl: tenantUrl.toString(),
        companyId: "00000000-0000-4000-8000-000000000001",
        pageSize: 2,
        _internalSkipVectorIdentityCheck: true,
      });

      assert.equal(report.census.totalRows, 5);
      assert.equal(report.census.distinctUserIds, 5);

      // Verify keyset query orders on native column t.id with index scan rather than alias sort
      // Assert native order explicitly
      const queryRows = (await adminDb.execute<{ id: string }>(sql`
        SELECT
          t.id::text AS id,
          t.payload->>'agent_id' AS agent_id
        FROM mem0_memories t
        WHERE t.id > ${rowIds[1]}::uuid
        ORDER BY t.id ASC
        LIMIT 2;
      `)) as unknown as Array<{ id: string }>;
      assert.deepEqual(queryRows.map((r) => r.id), [rowIds[2], rowIds[3]]);

      // Plan assertion with SET LOCAL enable_seqscan = off to verify index suitability
      const plan = await adminDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off;`);
        const explainRows = (await tx.execute<{ "QUERY PLAN": string }>(sql`
          EXPLAIN SELECT
            t.id::text AS id,
            t.payload->>'agent_id' AS agent_id
          FROM mem0_memories t
          WHERE t.id > ${rowIds[1]}::uuid
          ORDER BY t.id ASC
          LIMIT 2;
        `)) as unknown as Array<{ "QUERY PLAN": string }>;
        return explainRows.map((r) => r["QUERY PLAN"]).join("\n");
      });
      assert.ok(
        plan.includes("Index Scan") || plan.includes("mem0_memories_pkey"),
        `Expected plan to use native index scan, got: ${plan}`,
      );
      assert.ok(
        !plan.includes("Sort"),
        `Expected no explicit Sort node when keyset orders on native PK column with enable_seqscan=off, got: ${plan}`,
      );
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("preserves snapshot consistency during concurrent write from separate connection", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_concurrent_snapshot");
    const adminDb = createDb(fixture.connectionString);

    try {
      await adminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await adminDb.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`CREATE ROLE tenant_checker WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_checker;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_checker;`);

      // Seed initial 2 rows
      await adminDb.execute(sql`
        INSERT INTO mem0_memories (id, vector, payload) VALUES
        ('row-1', '[]', '{"agent_id": "11111111-1111-4111-8111-111111111111", "data": "initial 1"}'::jsonb),
        ('row-2', '[]', '{"agent_id": "11111111-1111-4111-8111-111111111111", "data": "initial 2"}'::jsonb);
      `);

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      // During onTransaction hook, insert a 3rd row from adminDb (separate connection/transaction)
      const report = await runCensus({
        databaseUrl: tenantUrl.toString(),
        tableName: "mem0_memories",
        companyId: "00000000-0000-4000-8000-000000000001",
        _internalSkipVectorIdentityCheck: true,
        onTransaction: async () => {
          await adminDb.execute(sql`
            INSERT INTO mem0_memories (id, vector, payload)
            VALUES ('row-3', '[]', '{"agent_id": "11111111-1111-4111-8111-111111111111", "data": "concurrent 3"}'::jsonb);
          `);
        },
      });

      // Repeatable read snapshot guarantees that census observes only the initial 2 rows
      assert.equal(report.shapeIntrospection.rowCount, 2);
      assert.equal(report.census.totalRows, 2);
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });
});

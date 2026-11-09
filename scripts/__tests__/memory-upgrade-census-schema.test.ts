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

describe("census schema, privileges, and read-only mode integration tests", () => {
  it("enforces strict privilege preflight on tenant and control-plane connections", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_privileges");
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

      // 1. Direct superuser rejected on tenant (default 'postgres' role)
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: fixture.connectionString,
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "SUPERUSER_REJECTED");
          assert.ok(err.message.includes("is a superuser"));
          return true;
        },
      );

      // Create regular unprivileged tenant role for testing control plane rejection
      await adminDb.execute(sql`CREATE ROLE tenant_ok WITH LOGIN PASSWORD 'pass' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_ok;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_ok;`);

      const tenantOkUrl = new URL(fixture.connectionString);
      tenantOkUrl.username = "tenant_ok";
      tenantOkUrl.password = "pass";

      // 2. Direct superuser rejected on control plane
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantOkUrl.toString(),
            controlPlaneUrl: fixture.connectionString, // superuser CP connection
            companyId: "00000000-0000-4000-8000-000000000001",
            _internalSkipVectorIdentityCheck: true,
          }),
        (err: any) => {
          assert.equal(err.code, "SUPERUSER_REJECTED");
          assert.ok(err.message.includes("control-plane database is a superuser"));
          return true;
        },
      );

      // 3. Direct BYPASSRLS rejected
      await adminDb.execute(sql`CREATE ROLE tenant_bypass WITH LOGIN PASSWORD 'pass' NOSUPERUSER BYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_bypass;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_bypass;`);

      const tenantBypassUrl = new URL(fixture.connectionString);
      tenantBypassUrl.username = "tenant_bypass";
      tenantBypassUrl.password = "pass";

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantBypassUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "BYPASSRLS_REJECTED");
          return true;
        },
      );

      // 4. Inherited superuser via GRANT rejected
      await adminDb.execute(sql`CREATE ROLE admin_group WITH SUPERUSER;`);
      await adminDb.execute(sql`CREATE ROLE tenant_inherited WITH LOGIN PASSWORD 'pass' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT admin_group TO tenant_inherited;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_inherited;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_inherited;`);

      const tenantInheritedUrl = new URL(fixture.connectionString);
      tenantInheritedUrl.username = "tenant_inherited";
      tenantInheritedUrl.password = "pass";

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantInheritedUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "SUPERUSER_REJECTED");
          assert.ok(err.message.includes("admin_group"));
          return true;
        },
      );

      // 5. NOINHERIT BYPASSRLS membership variant rejected
      await adminDb.execute(sql`CREATE ROLE sec_group WITH BYPASSRLS;`);
      await adminDb.execute(sql`CREATE ROLE tenant_noinherit WITH LOGIN PASSWORD 'pass' NOSUPERUSER NOBYPASSRLS NOINHERIT;`);
      await adminDb.execute(sql`GRANT sec_group TO tenant_noinherit;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_noinherit;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_noinherit;`);

      const tenantNoinheritUrl = new URL(fixture.connectionString);
      tenantNoinheritUrl.username = "tenant_noinherit";
      tenantNoinheritUrl.password = "pass";

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantNoinheritUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "BYPASSRLS_REJECTED");
          assert.ok(err.message.includes("sec_group"));
          return true;
        },
      );

      // 6. Plain group passes preflight check without false positive (negative control)
      await adminDb.execute(sql`CREATE ROLE plain_group;`);
      await adminDb.execute(sql`CREATE ROLE tenant_plain WITH LOGIN PASSWORD 'pass' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT plain_group TO tenant_plain;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_plain;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_plain;`);

      const tenantPlainUrl = new URL(fixture.connectionString);
      tenantPlainUrl.username = "tenant_plain";
      tenantPlainUrl.password = "pass";

      const plainReport = await runCensus({
        databaseUrl: tenantPlainUrl.toString(),
        companyId: "00000000-0000-4000-8000-000000000001",
        _internalSkipVectorIdentityCheck: true,
      });
      assert.ok(plainReport.readOnly);
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("inverts fake fixture: CREATE DOMAIN vector(1536) AS text is rejected with NOT_PGVECTOR", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_fake_vector_rejected");
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

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      // Running census without _internalSkipVectorIdentityCheck must reject fake domain!
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "NOT_PGVECTOR");
          assert.ok(err.message.includes("not a valid pgvector column"));
          return true;
        },
      );
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("rejects table with invalid id column type, missing payload, or invalid dimensions", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_schema_check");
    const adminDb = createDb(fixture.connectionString);

    try {
      await adminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await adminDb.execute(sql`CREATE DOMAIN "vector(768)" AS text;`);

      // Create non-superuser tenant role
      await adminDb.execute(sql`CREATE ROLE tenant_checker WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_checker;`);

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      // 1. Missing payload column -> SCHEMA_MISMATCH
      await adminDb.execute(sql`
        CREATE TABLE bad_table_1 (
          id TEXT PRIMARY KEY,
          vector "vector(1536)"
        );
      `);
      await adminDb.execute(sql`GRANT SELECT ON bad_table_1 TO tenant_checker;`);

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            tableName: "bad_table_1",
            companyId: "00000000-0000-4000-8000-000000000001",
            _internalSkipVectorIdentityCheck: true,
          }),
        (err: any) => {
          assert.equal(err.code, "SCHEMA_MISMATCH");
          assert.ok(err.message.includes('missing required "payload" column'));
          return true;
        },
      );

      // 2. Declared id column is integer (not uuid or text) -> SCHEMA_MISMATCH naming integer
      await adminDb.execute(sql`
        CREATE TABLE bad_table_id_int (
          id INTEGER PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`GRANT SELECT ON bad_table_id_int TO tenant_checker;`);

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            tableName: "bad_table_id_int",
            companyId: "00000000-0000-4000-8000-000000000001",
            _internalSkipVectorIdentityCheck: true,
          }),
        (err: any) => {
          assert.equal(err.code, "SCHEMA_MISMATCH");
          assert.ok(err.message.includes('primary key column "id" must be type uuid or text'));
          assert.ok(err.message.includes("integer"));
          return true;
        },
      );

      // 3. Invalid embedding dimensions (768 instead of 1536) -> EMBEDDING_DIMENSIONS_MISMATCH
      await adminDb.execute(sql`
        CREATE TABLE bad_table_dims (
          id TEXT PRIMARY KEY,
          vector "vector(768)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`GRANT SELECT ON bad_table_dims TO tenant_checker;`);

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            tableName: "bad_table_dims",
            companyId: "00000000-0000-4000-8000-000000000001",
            _internalSkipVectorIdentityCheck: true,
          }),
        (err: any) => {
          assert.equal(err.code, "EMBEDDING_DIMENSIONS_MISMATCH");
          assert.ok(err.message.includes("expected 1536, found 768"));
          return true;
        },
      );
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("introspects mixed-case and schema-qualified mixed-case table names via properly quoted to_regclass", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_mixed_case");
    const adminDb = createDb(fixture.connectionString);

    try {
      await adminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await adminDb.execute(sql`CREATE ROLE tenant_checker WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_checker;`);

      // 1. Bare mixed-case table: "Mem0_MixedCase"
      await adminDb.execute(sql`
        CREATE TABLE "Mem0_MixedCase" (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`GRANT SELECT ON "Mem0_MixedCase" TO tenant_checker;`);

      // 2. Schema-qualified mixed-case table: "Custom_Schema"."Mem0_Custom_Case"
      await adminDb.execute(sql`CREATE SCHEMA "Custom_Schema";`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA "Custom_Schema" TO tenant_checker;`);
      await adminDb.execute(sql`
        CREATE TABLE "Custom_Schema"."Mem0_Custom_Case" (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`GRANT SELECT ON "Custom_Schema"."Mem0_Custom_Case" TO tenant_checker;`);

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      const report1 = await runCensus({
        databaseUrl: tenantUrl.toString(),
        tableName: "Mem0_MixedCase",
        companyId: "00000000-0000-4000-8000-000000000001",
        _internalSkipVectorIdentityCheck: true,
      });
      assert.equal(report1.shapeIntrospection.table, "Mem0_MixedCase");

      const report2 = await runCensus({
        databaseUrl: tenantUrl.toString(),
        tableName: "Custom_Schema.Mem0_Custom_Case",
        companyId: "00000000-0000-4000-8000-000000000001",
        _internalSkipVectorIdentityCheck: true,
      });
      assert.equal(report2.shapeIntrospection.table, "Custom_Schema.Mem0_Custom_Case");
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("completes full census pipeline without modifying database or executing writes", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_no_writes");
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
      await adminDb.execute(sql`
        INSERT INTO mem0_memories (id, vector, payload) VALUES
        ('mem-1', '[]', '{"agent_id": "00000000-0000-4000-8000-000000000001", "data": "Sample preference"}'::jsonb);
      `);
      await adminDb.execute(sql`CREATE ROLE tenant_checker WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_checker;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_checker;`);

      // Snapshot database state before running census
      const rowsBefore = (await adminDb.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM mem0_memories;
      `)) as unknown as Array<{ count: number }>;
      const tablesBefore = (await adminDb.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
      `)) as unknown as Array<{ table_name: string }>;

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      const report = await runCensus({
        databaseUrl: tenantUrl.toString(),
        companyId: "00000000-0000-4000-8000-000000000001",
        _internalSkipVectorIdentityCheck: true,
      });

      assert.equal(report.readOnly, true);
      assert.equal(report.census.totalRows, 1);

      // Verify database state after running census: zero writes, zero DDL, zero modifications!
      const rowsAfter = (await adminDb.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM mem0_memories;
      `)) as unknown as Array<{ count: number }>;
      const tablesAfter = (await adminDb.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
      `)) as unknown as Array<{ table_name: string }>;

      assert.equal(rowsAfter[0].count, rowsBefore[0].count);
      assert.deepEqual(tablesAfter, tablesBefore);
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("enforces read-only transaction mode and rejects write attempts inside census transaction", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_read_only");
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
      await adminDb.execute(sql`CREATE ROLE tenant_ro WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_ro;`);
      await adminDb.execute(sql`GRANT ALL PRIVILEGES ON mem0_memories TO tenant_ro;`);

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_ro";
      tenantUrl.password = "pass123";

      // Attempt write inside census transaction hook
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            tableName: "mem0_memories",
            companyId: "00000000-0000-4000-8000-000000000001",
            onTransaction: async (tx) => {
              // Verify transaction isolation settings are applied by drizzle transaction config
              const settings = (await tx.execute<{ iso: string; ro: string }>(sql`
                SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro;
              `)) as unknown as Array<{ iso: string; ro: string }>;
              assert.equal(settings[0].iso, "repeatable read");
              assert.equal(settings[0].ro, "on");

              // Attempt mutation inside read-only transaction
              await tx.execute(sql`
                INSERT INTO mem0_memories (id, vector, payload)
                VALUES ('fail-row', '[]', '{}'::jsonb);
              `);
            },
          }),
        (err: any) => {
          // PostgreSQL error 25006: read_only_sql_transaction
          assert.ok(
            err.message?.includes("read-only transaction") ||
            err.cause?.message?.includes("read-only transaction") ||
            err.cause?.code === "25006" ||
            err.code === "25006",
          );
          return true;
        },
      );
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });
});

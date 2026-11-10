/**
 * Safe catalog type cast and staging embedding introspection tests (TECH-8191 PR 4a).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureUpgradeTables,
  openTenantClient,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import {
  assertSafeCatalogTypeCast,
  introspectStagingEmbeddingType,
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

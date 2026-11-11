/**
 * Tenant preflight insertability tests (TECH-8191 PR 4b).
 * Test 14 from plan §7.2: assertLiveCollectionInsertable.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureUpgradeTables,
  introspectCollection,
  openTenantClient,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { assertLiveCollectionInsertable } from "../../server/src/services/company-memory-upgrade/publish-tenant.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("publish-tenant: assertLiveCollectionInsertable preflight", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("pub-preflight-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  const liveTable = "mem0_memories";
  await setupTenantMem0Table(sql, liveTable);
  await ensureUpgradeTables(sql, "text");

  const shape = await introspectCollection(sql, liveTable, { skipVectorIdentityCheck: true });

  // (c) Standard fixture passes
  await assert.doesNotReject(() => assertLiveCollectionInsertable(sql, liveTable, shape));

  // (a) Table with extra NOT NULL column and no default -> LIVE_TABLE_NOT_INSERTABLE
  const extraColTable = "mem0_extra_col";
  await sql.unsafe(`
    CREATE TABLE ${extraColTable} (
      id uuid PRIMARY KEY,
      payload jsonb NOT NULL,
      vector "vector(1536)" NOT NULL,
      required_col text NOT NULL
    );
  `);
  const extraShape = await introspectCollection(sql, extraColTable, { skipVectorIdentityCheck: true });
  await assert.rejects(
    () => assertLiveCollectionInsertable(sql, extraColTable, extraShape),
    (err: any) =>
      err instanceof CompanyMemoryUpgradeError &&
      err.code === "LIVE_TABLE_NOT_INSERTABLE" &&
      err.message.includes("required_col"),
  );

  // (b) Table whose id has no unique index -> LIVE_TABLE_ID_NOT_UNIQUE
  const noUniqueTable = "mem0_no_unique";
  await sql.unsafe(`
    CREATE TABLE ${noUniqueTable} (
      id uuid,
      payload jsonb NOT NULL,
      vector "vector(1536)" NOT NULL
    );
  `);
  const noUniqueShape = await introspectCollection(sql, noUniqueTable, { skipVectorIdentityCheck: true });
  await assert.rejects(
    () => assertLiveCollectionInsertable(sql, noUniqueTable, noUniqueShape),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LIVE_TABLE_ID_NOT_UNIQUE",
  );
});

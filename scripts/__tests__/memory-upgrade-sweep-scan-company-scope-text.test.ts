/**
 * Multi-page text ID scan tests for company-scope filter (TECH-8191 §5.2).
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

test("iterateSourcePages with onlyCompanyScope: text ID path multi-page keyset pagination", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("scan-scope-text-");
  const tenantSql = openTenantClient(fixture.connectionString);
  await ensureUpgradeTables(tenantSql, "text");

  await tenantSql.unsafe(`
    CREATE TABLE mem0_text_scope (
      id text PRIMARY KEY,
      payload jsonb NOT NULL,
      vector text NOT NULL
    );
  `);

  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  const upgradeId = randomUUID();
  const agentId = randomUUID();

  // 4 company-scoped text rows
  const companyIds = ["legacy-01", "legacy-02", "legacy-03", "legacy-04"];
  for (const id of companyIds) {
    await tenantSql.unsafe(
      "INSERT INTO mem0_text_scope (id, payload, vector) VALUES ($1, $2, $3);",
      [id, { data: `data-${id}`, user_id: "company", agent_id: agentId }, "vec"],
    );
  }

  // Agent-scoped rows
  await tenantSql.unsafe(
    "INSERT INTO mem0_text_scope (id, payload, vector) VALUES ($1, $2, $3), ($4, $5, $6);",
    [
      "agent-01", { data: "agent", user_id: agentId, agent_id: agentId }, "vec",
      "legacy-02-agent", { data: "agent", user_id: agentId, agent_id: agentId }, "vec",
    ],
  );

  // Published row
  const pubOutputId = randomUUID();
  await tenantSql.unsafe(
    "INSERT INTO mem0_text_scope (id, payload, vector) VALUES ($1, $2, $3);",
    [pubOutputId, { data: "published", user_id: "company" }, "vec"],
  );
  await tenantSql.unsafe(
    `INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, now());`,
    [upgradeId, randomUUID(), pubOutputId, agentId, { data: "pub" }, "vec", "sha"],
  );

  const yielded: string[] = [];
  let pageCount = 0;
  for await (const page of iterateSourcePages(tenantSql, "mem0_text_scope", {
    pageSize: 2,
    isUuidId: false,
    onlyCompanyScope: true,
    excludeUpgradeOutputs: true,
  })) {
    pageCount++;
    for (const row of page) {
      yielded.push(row.id);
    }
  }

  assert.ok(pageCount >= 2, `Expected at least 2 pages, got ${pageCount}`);
  assert.deepEqual(yielded, companyIds, "Only company-scoped legacy text rows yielded in order");
});

/**
 * Drain probe SHA-256 TS/SQL byte-equivalence fixture (TECH-8191 §Q3, PR5.5).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("sha256 TS/SQL byte-identical equivalence fixture (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-probe-hsh-");
  const tenantSql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  const jsonTestCases = [
    { name: "ascii", payload: '{"data": "standard memory text content"}' },
    { name: "multibyte", payload: '{"data": "Complex UTF-8: 🚀 🌍 世界 café naïve résumé"}' },
    { name: "empty", payload: '{"data": ""}' },
    { name: "json_null", payload: '{"data": null}' },
    { name: "missing_field", payload: '{"other": "field"}' },
    { name: "number", payload: '{"data": 98765}' },
    { name: "boolean", payload: '{"data": true}' },
  ];

  for (const tc of jsonTestCases) {
    const [row] = await tenantSql`
      SELECT
        ${tc.payload}::jsonb->>'data' AS ts_input,
        encode(sha256(convert_to(coalesce(${tc.payload}::jsonb->>'data', ''), 'UTF8')), 'hex') AS sql_sha;
    `;
    const tsSha = computeSourceContentSha256(row.ts_input);
    assert.equal(tsSha, row.sql_sha, `SHA-256 mismatch for case "${tc.name}"`);
  }

  // Direct null vs empty check
  assert.equal(
    computeSourceContentSha256(null),
    (await tenantSql`SELECT encode(sha256(convert_to(coalesce(NULL, ''), 'UTF8')), 'hex') AS s;`)[0].s,
  );
  assert.equal(
    computeSourceContentSha256(""),
    (await tenantSql`SELECT encode(sha256(convert_to(coalesce(''::text, ''), 'UTF8')), 'hex') AS s;`)[0].s,
  );
});

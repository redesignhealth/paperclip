/**
 * Generated-SQL shape assertions for sweep source scan exclusion (TECH-8191 §5.1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  iterateSourcePages,
  scanTenantSources,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";

const EXCLUDE_PREDICATE_UUID =
  "NOT EXISTS (SELECT 1 FROM paperclip_memory_upgrade_staging s WHERE s.output_id = t.id)";

const EXCLUDE_PREDICATE_TEXT =
  "NOT EXISTS (SELECT 1 FROM paperclip_memory_upgrade_staging s WHERE lower(s.output_id::text) = lower(t.id::text))";

test("scanTenantSources alias is strictly equal to iterateSourcePages", () => {
  assert.equal(scanTenantSources, iterateSourcePages);
});

test("generated-SQL shape: all three keyset branches include exclusion by default", async () => {
  const executed: Array<{ query: string; params?: any[] }> = [];
  const fakeSql = {
    unsafe: async (query: string, params?: any[]) => {
      executed.push({ query, params });
      return [];
    },
  };

  // Branch 1: initial page (lastId === null), UUID id
  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", { pageSize: 50, isUuidId: true }).next();
  assert.equal(executed.length, 1);
  assert.ok(executed[0].query.includes(`WHERE ${EXCLUDE_PREDICATE_UUID}`));
  assert.match(executed[0].query, /ORDER BY t\.id ASC/);
  assert.equal(executed[0].params, undefined);

  // Branch 1b: initial page (lastId === null), text id with COLLATE "C"
  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", { pageSize: 50, isUuidId: false }).next();
  assert.equal(executed.length, 1);
  assert.ok(executed[0].query.includes(`WHERE ${EXCLUDE_PREDICATE_TEXT}`));
  assert.match(executed[0].query, /ORDER BY lower\(t\.id::text\) COLLATE "C" ASC/);

  // Branch 2: continuation page (lastId !== null), UUID id
  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", {
    pageSize: 25,
    isUuidId: true,
    startAfterId: "11111111-1111-4111-8111-111111111111",
  }).next();
  assert.equal(executed.length, 1);
  assert.match(executed[0].query, /WHERE t\.id > \$1::uuid/);
  assert.ok(executed[0].query.includes(`AND ${EXCLUDE_PREDICATE_UUID}`));
  assert.match(executed[0].query, /ORDER BY t\.id ASC/);
  assert.deepEqual(executed[0].params, ["11111111-1111-4111-8111-111111111111"]);

  // Branch 3: continuation page (lastId !== null), text id with COLLATE "C"
  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", {
    pageSize: 10,
    isUuidId: false,
    startAfterId: "legacy-source-042",
  }).next();
  assert.equal(executed.length, 1);
  assert.match(executed[0].query, /WHERE lower\(t\.id::text\) COLLATE "C" > \$1::text COLLATE "C"/);
  assert.ok(executed[0].query.includes(`AND ${EXCLUDE_PREDICATE_TEXT}`));
  assert.match(executed[0].query, /ORDER BY lower\(t\.id::text\) COLLATE "C" ASC/);
  assert.deepEqual(executed[0].params, ["legacy-source-042"]);
});

test("generated-SQL shape: excludeUpgradeOutputs: false omits exclusion across branches", async () => {
  const executed: string[] = [];
  const fakeSql = {
    unsafe: async (query: string) => {
      executed.push(query);
      return [];
    },
  };

  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", { excludeUpgradeOutputs: false }).next();
  assert.doesNotMatch(executed[0], /WHERE/);

  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", {
    startAfterId: "11111111-1111-4111-8111-111111111111",
    isUuidId: true,
    excludeUpgradeOutputs: false,
  }).next();
  assert.match(executed[0], /WHERE t\.id > \$1::uuid/);
  assert.doesNotMatch(executed[0], /paperclip_memory_upgrade_staging/);

  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", {
    startAfterId: "some-text-id",
    isUuidId: false,
    excludeUpgradeOutputs: false,
  }).next();
  assert.match(executed[0], /WHERE lower\(t\.id::text\) COLLATE "C" > \$1::text COLLATE "C"/);
  assert.doesNotMatch(executed[0], /paperclip_memory_upgrade_staging/);
});

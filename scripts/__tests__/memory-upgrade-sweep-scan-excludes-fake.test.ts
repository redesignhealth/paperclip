/**
 * Fake-SQL and interleaved pagination unit tests for sweep source scan exclusion (TECH-8191 §5.1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { iterateSourcePages } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";

test("fake-sql test proving a published output id is never yielded across interleaved pages", async () => {
  const stagingOutputIds = new Set([
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000006",
  ]);

  const liveTableRows = [
    { id: "00000000-0000-4000-8000-000000000001", data: "legacy 1" },
    { id: "00000000-0000-4000-8000-000000000002", data: "published 1" },
    { id: "00000000-0000-4000-8000-000000000003", data: "legacy 2" },
    { id: "00000000-0000-4000-8000-000000000004", data: "published 2" },
    { id: "00000000-0000-4000-8000-000000000005", data: "legacy 3" },
    { id: "00000000-0000-4000-8000-000000000006", data: "published 3" },
    { id: "00000000-0000-4000-8000-000000000007", data: "legacy 4" },
  ];

  const fakeSql = {
    unsafe: async (_query: string, params?: any[]) => {
      const startAfter = params ? params[0] : null;
      const filtered = liveTableRows.filter((r) => {
        if (stagingOutputIds.has(r.id)) return false;
        if (startAfter !== null && r.id <= startAfter) return false;
        return true;
      });
      const page = filtered.slice(0, 2);
      return page.map((r) => ({
        id: r.id,
        agent_id: null,
        user_id: "company",
        data: r.data,
        created_at: new Date().toISOString(),
        raw_payload: { data: r.data, user_id: "company" },
      }));
    },
  };

  const yieldedRows: string[] = [];
  for await (const page of iterateSourcePages(fakeSql as any, "mem0_memories", { pageSize: 2 })) {
    for (const row of page) {
      yieldedRows.push(row.id);
    }
  }

  assert.deepEqual(yieldedRows, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000005",
    "00000000-0000-4000-8000-000000000007",
  ]);
  for (const publishedId of stagingOutputIds) {
    assert.ok(!yieldedRows.includes(publishedId), `published id ${publishedId} must not be yielded`);
  }
});

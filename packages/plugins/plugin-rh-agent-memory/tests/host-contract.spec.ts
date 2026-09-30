/**
 * Runs this plugin's manifest and SQL through the HOST's own validators, rather
 * than re-implementing our belief about what the host accepts.
 *
 * This is deliberately coupled to `server/` and `packages/shared/` source via
 * relative imports. It is worth the coupling: this file caught a real defect on
 * its first run — the migration's `REFERENCES public.companies(id)` foreign key
 * was rejected because `database.coreReadTables` was empty, which the in-memory
 * SDK harness cannot detect. Without it, the plugin would have installed
 * cleanly in tests and then failed its migration on a real host, leaving the
 * namespace in `migration_failed`.
 *
 * If a host upgrade tightens these validators, this test is where we find out.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "../../../shared/src/validators/plugin.js";
import {
  derivePluginDatabaseNamespace,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../../../../server/src/services/plugin-database.js";
import manifest, { EXPECTED_DB_NAMESPACE, NAMESPACE_SLUG } from "../src/manifest.js";
import { MEMORY_TABLE, memoryTable } from "../src/store.js";

const CORE_READ_TABLES = manifest.database?.coreReadTables ?? [];

function migrationStatements(): string[] {
  const sql = readFileSync(new URL("../migrations/001_agent_memory.sql", import.meta.url), "utf8");
  // Strip line comments so a comment block is not mistaken for a statement.
  const stripped = sql.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
  return stripped.split(";").map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

describe("host contract", () => {
  it("passes the host's plugin manifest schema", () => {
    const parsed = pluginManifestV1Schema.safeParse(manifest);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it("derives the namespace hardcoded in the migration and used by the store", () => {
    const derived = derivePluginDatabaseNamespace(manifest.id, manifest.database?.namespaceSlug);
    expect(derived).toBe(EXPECTED_DB_NAMESPACE);
    expect(derived).toBe(`plugin_${NAMESPACE_SLUG}_${derived.split("_").at(-1)}`);
    expect(memoryTable(derived)).toBe(`"${EXPECTED_DB_NAMESPACE}"."${MEMORY_TABLE}"`);
  });

  it("accepts every migration statement", () => {
    const statements = migrationStatements();
    // CREATE TABLE + a standalone agent_id index for FK-cascade delete
    // performance. The redundant tenant index and the unused updated_at
    // index were dropped; see migrations/001_agent_memory.sql.
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(
        () => validatePluginMigrationStatement(statement, EXPECTED_DB_NAMESPACE, CORE_READ_TABLES),
        statement.replace(/\s+/g, " ").slice(0, 120),
      ).not.toThrow();
    }
  });

  it("accepts every runtime SELECT under the query validator", () => {
    const table = memoryTable(EXPECTED_DB_NAMESPACE);
    const queries = [
      `SELECT memory_key, value_json, created_at, updated_at
         FROM ${table}
        WHERE company_id = $1 AND agent_id = $2 AND memory_key = $3
        LIMIT 1`,
      `SELECT memory_key, value_json, created_at, updated_at
         FROM ${table}
        WHERE company_id = $1 AND agent_id = $2
        ORDER BY memory_key ASC
        LIMIT $3`,
    ];
    for (const query of queries) {
      expect(() => validatePluginRuntimeQuery(query, EXPECTED_DB_NAMESPACE, CORE_READ_TABLES)).not.toThrow();
    }
  });

  it("accepts every runtime mutation under the execute validator", () => {
    const table = memoryTable(EXPECTED_DB_NAMESPACE);
    const mutations = [
      `INSERT INTO ${table} (company_id, agent_id, memory_key, value_json)
            VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (company_id, agent_id, memory_key)
         DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()
               WHERE ${table}.company_id = $1 AND ${table}.agent_id = $2`,
      `DELETE FROM ${table} WHERE company_id = $1 AND agent_id = $2 AND memory_key = $3`,
    ];
    for (const mutation of mutations) {
      expect(() => validatePluginRuntimeExecute(mutation, EXPECTED_DB_NAMESPACE)).not.toThrow();
    }
  });

  it("only whitelists a core table the migration actually references", () => {
    const sql = readFileSync(new URL("../migrations/001_agent_memory.sql", import.meta.url), "utf8");
    for (const table of CORE_READ_TABLES) {
      expect(sql).toContain(`public.${table}`);
    }
  });
});

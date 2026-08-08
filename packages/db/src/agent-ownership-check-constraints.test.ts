import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import {
  AGENT_OWNERSHIP_PRINCIPAL_TYPES,
  AGENT_OWNERSHIP_ROLES,
  AGENT_OWNERSHIP_SOURCES,
} from "./schema/agent_ownership_grants.js";

/**
 * TECH-4929: `AGENT_OWNERSHIP_PRINCIPAL_TYPES`, `AGENT_OWNERSHIP_ROLES`, and
 * `AGENT_OWNERSHIP_SOURCES` (packages/db/src/schema/agent_ownership_grants.ts)
 * exist to give bad values a compile-time error instead of an opaque CHECK
 * failure at write time. That guarantee only holds if those TS unions stay
 * byte-for-byte in sync with the CHECK constraints actually enforced in
 * Postgres (0211_agent_ownership_roles.sql). Nothing else keeps them in
 * sync -- a comment would only catch drift someone remembers to read. This
 * test introspects `pg_constraint` on a real embedded Postgres instance
 * after running the migrations, and fails loudly the moment the two sides
 * disagree.
 */

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent ownership CHECK-constraint drift test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Extracts the quoted string literals out of a `pg_get_constraintdef`
 * rendering of a `column = ANY (ARRAY['a'::text, 'b'::text, ...])` CHECK
 * constraint, in the order Postgres prints them.
 */
function extractAllowedValues(constraintDef: string): string[] {
  const matches = constraintDef.matchAll(/'([^']*)'::text/g);
  return Array.from(matches, (m) => m[1]);
}

describeEmbeddedPostgres("agent ownership CHECK constraints vs TS constants", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("agrees with AGENT_OWNERSHIP_PRINCIPAL_TYPES, AGENT_OWNERSHIP_ROLES, and AGENT_OWNERSHIP_SOURCES", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-agent-ownership-check-constraints-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await applyPendingMigrations(database.connectionString);

    const rows = await sql<{ conname: string; definition: string }[]>`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname IN (
          'agent_ownership_grants_principal_type_check',
          'agent_ownership_grants_role_check',
          'agent_ownership_grants_source_check'
        )
    `;

    const byName = new Map(rows.map((row) => [row.conname, row.definition]));
    expect(byName.size).toBe(3);

    const principalTypeDef = byName.get("agent_ownership_grants_principal_type_check");
    const roleDef = byName.get("agent_ownership_grants_role_check");
    const sourceDef = byName.get("agent_ownership_grants_source_check");
    expect(principalTypeDef).toBeDefined();
    expect(roleDef).toBeDefined();
    expect(sourceDef).toBeDefined();

    expect(extractAllowedValues(principalTypeDef as string).sort()).toEqual(
      [...AGENT_OWNERSHIP_PRINCIPAL_TYPES].sort(),
    );
    expect(extractAllowedValues(roleDef as string).sort()).toEqual([...AGENT_OWNERSHIP_ROLES].sort());
    expect(extractAllowedValues(sourceDef as string).sort()).toEqual([...AGENT_OWNERSHIP_SOURCES].sort());
  });
});

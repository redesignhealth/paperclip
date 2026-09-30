import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  TENANT_COMPANY_SETTING,
  TENANT_ISOLATION_POLICY,
  listRlsTargets,
  verifyTenantIsolationPolicies,
} from "./rls.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

/**
 * TECH-6956: proves the RLS backstop actually blocks a cross-tenant read and
 * write at the DATABASE level, with the application layer bypassed entirely.
 *
 * Every assertion here runs raw SQL on a raw connection. That is the point:
 * the value of RLS is precisely what survives when nothing above Postgres is
 * doing its job, so a test that went through drizzle's query builders or any
 * service would be testing the wrong layer.
 *
 * ## Why a dedicated non-superuser role
 *
 * `startEmbeddedPostgresTestDatabase` connects as `paperclip`, which initdb
 * creates as the bootstrap SUPERUSER. Superusers bypass row-level security
 * unconditionally -- `FORCE ROW LEVEL SECURITY` does not change that, and
 * there is no table-level setting that does. So a test that used the default
 * connection would see every policy silently ignored and would pass or fail
 * for reasons unrelated to the policies.
 *
 * The suite therefore creates `rls_app_role` (NOSUPERUSER, no BYPASSRLS),
 * grants it DML on the covered tables, and does the cross-tenant probing as
 * that role. That also mirrors the production posture the boot check warns
 * about: if the deployed app connects as a superuser, none of this applies,
 * which is why `describeRlsRole` reports it.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres tenant-isolation RLS tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * Tables probed with real rows, and the `(columns) VALUES (...)` fragment
 * needed to seed one.
 *
 * Every probed table is seeded for BOTH companies before any cross-tenant
 * assertion runs. Without that, "SELECT ... WHERE company_id = <other
 * company>" returns zero rows on an empty table and the test passes for
 * entirely the wrong reason -- it would keep passing with RLS removed. The
 * companion assertion ("still returns the session's own rows") closes the
 * same gap from the other side.
 */
const PROBED_TABLES = [
  { table: "agents", columns: "company_id, name", values: "$1, 'Probe agent'" },
  { table: "issues", columns: "company_id, title", values: "$1, 'Probe issue'" },
  { table: "projects", columns: "company_id, name", values: "$1, 'Probe project'" },
] as const;

const APP_ROLE = "rls_app_role";
const APP_ROLE_PASSWORD = "rls_app_role_password";

describeEmbeddedPostgres("tenant-isolation row-level security", () => {
  let database: EmbeddedPostgresTestDatabase;
  /** Owner/superuser connection: schema setup and unfiltered verification. */
  let owner: postgres.Sql;
  /** Non-superuser connection: everything that must be subject to RLS. */
  let app: postgres.Sql;

  const companyA = randomUUID();
  const companyB = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-tenant-rls-");
    owner = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    await owner.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await owner.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await owner.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );

    const appUrl = new URL(database.connectionString);
    appUrl.username = APP_ROLE;
    appUrl.password = APP_ROLE_PASSWORD;
    app = postgres(appUrl.toString(), { max: 1, onnotice: () => {} });

    // Seed as the owner. The owner is a superuser here, so these inserts are
    // not themselves subject to the policies -- which is what we want: the
    // fixture has to exist unconditionally so that "zero rows" later can only
    // mean "RLS filtered them", never "nothing was ever written".
    // `issue_prefix` is uniquely indexed and defaults to 'PAP', so the two
    // companies need distinct prefixes rather than relying on the default.
    await owner.unsafe(
      `INSERT INTO companies (id, name, issue_prefix) VALUES ($1, 'Company A', 'AAA'), ($2, 'Company B', 'BBB')`,
      [companyA, companyB],
    );
    await owner.unsafe(
      `INSERT INTO agents (id, company_id, name) VALUES ($1, $2, 'Agent A'), ($3, $4, 'Agent B')`,
      [agentA, companyA, agentB, companyB],
    );
    for (const probe of PROBED_TABLES) {
      for (const companyId of [companyA, companyB]) {
        await owner.unsafe(
          `INSERT INTO ${probe.table} (${probe.columns}) VALUES (${probe.values})`,
          [companyId],
        );
      }
    }
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await database?.cleanup();
  });

  it("creates a non-superuser probing role that RLS actually applies to", async () => {
    const [row] = await app.unsafe<{ superuser: boolean; bypass_rls: boolean }[]>(
      `SELECT rolsuper AS superuser, rolbypassrls AS bypass_rls FROM pg_roles WHERE rolname = current_user`,
    );
    // Guards the rest of the suite: if this role could bypass RLS, every
    // "blocked" assertion below would be vacuous.
    expect(row).toMatchObject({ superuser: false, bypass_rls: false });
  });

  it("enables and FORCEs row-level security on every covered table", async () => {
    const targets = listRlsTargets();
    expect(targets.length).toBeGreaterThan(100);

    const rows = await owner.unsafe<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }[]>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const byName = new Map(rows.map((row) => [row.relname, row]));

    const notEnabled = targets.filter((target) => !byName.get(target.table)?.relrowsecurity);
    const notForced = targets.filter((target) => !byName.get(target.table)?.relforcerowsecurity);

    expect(notEnabled.map((target) => target.table)).toEqual([]);
    // FORCE is the difference between a real backstop and a decorative one:
    // Paperclip connects as the table owner, whom Postgres exempts from a
    // table's own policies without it.
    expect(notForced.map((target) => target.table)).toEqual([]);
  });

  it("reports no problems from the boot-time verification helper", async () => {
    const result = await verifyTenantIsolationPolicies(owner);
    expect(result.problems).toEqual([]);
    expect(result.checkedTables).toBe(listRlsTargets().length);
  });

  it("filters cross-tenant reads to zero rows instead of raising", async () => {
    for (const { table } of PROBED_TABLES) {
      // Sanity-check the fixture from the owner connection first, so a
      // zero-row result below can only be attributed to RLS. Without this the
      // assertion would pass just as happily against an empty table.
      const [seeded] = await owner.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM ${table} WHERE company_id = $1`,
        [companyB],
      );
      expect(seeded?.count, `${table} fixture for company B is missing`).toBeGreaterThan(0);

      // One transaction per probe: set_config(..., is_local => true) is
      // transaction-scoped, which is the only way to pin the setting to the
      // connection the subsequent query runs on.
      const rows = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM ${table} WHERE company_id = $1`,
          [companyB],
        );
      });
      // A USING clause removes rows silently -- it does not error. Asserting
      // exactly 0 (rather than catching an exception) is the correct shape for
      // a read: the row is filtered out of the result set, not rejected.
      expect(rows[0]?.count, `${table} leaked company B rows to a company A session`).toBe(0);
    }
  });

  it("still returns the session's own rows, so zero above is filtering and not an empty table", async () => {
    const visible = await app.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyB]);
      return await tx.unsafe<{ id: string; company_id: string }[]>(
        `SELECT id, company_id FROM agents`,
      );
    });
    // The very rows a company A session could not see. This is what makes the
    // zero-row results above meaningful: company B's agents are in `agents`
    // the whole time, and only the session's bound company decides
    // visibility.
    expect(visible.map((row) => row.id)).toContain(agentB);
    expect(new Set(visible.map((row) => row.company_id))).toEqual(new Set([companyB]));
    expect(visible.map((row) => row.id)).not.toContain(agentA);

    // Unscoped (no setting bound), the same role sees every company's rows --
    // confirming the GRANTs and the fixture are fine, and that the policy's
    // "setting is unset" disjunct passes rows through as designed. This is
    // the property that makes the migration additive rather than a flag day.
    const unscoped = await app.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM agents`,
    );
    expect(unscoped[0]?.count).toBe(visible.length * 2);
  });

  it("filters a cross-tenant UPDATE and DELETE to zero affected rows", async () => {
    const updated = await app.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
      return await tx.unsafe(`UPDATE agents SET name = 'hijacked' WHERE id = $1`, [agentB]);
    });
    expect(updated.count).toBe(0);

    const deleted = await app.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
      return await tx.unsafe(`DELETE FROM agents WHERE id = $1`, [agentB]);
    });
    expect(deleted.count).toBe(0);

    // Verified from the owner connection, which is not subject to the
    // policies -- so this confirms the row genuinely survived untouched,
    // rather than merely being invisible to the app role.
    const [row] = await owner.unsafe<{ name: string }[]>(
      `SELECT name FROM agents WHERE id = $1`,
      [agentB],
    );
    expect(row?.name).toBe("Agent B");
  });

  it("raises on a cross-tenant INSERT rather than silently dropping it", async () => {
    // WITH CHECK is the write-side counterpart to USING, and unlike USING it
    // errors. That asymmetry is intentional: a silently discarded write would
    // leave the caller believing it succeeded.
    await expect(
      app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        await tx.unsafe(`INSERT INTO agents (id, company_id, name) VALUES ($1, $2, 'Smuggled')`, [
          randomUUID(),
          companyB,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);

    const [row] = await owner.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM agents WHERE name = 'Smuggled'`,
    );
    expect(row?.count).toBe(0);
  });

  it("raises when an UPDATE would move a row into another company", async () => {
    await expect(
      app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        await tx.unsafe(`UPDATE agents SET company_id = $1 WHERE id = $2`, [companyB, agentA]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not leak the setting across transactions on a pooled connection", async () => {
    // `max: 1` guarantees both statements below reuse the same backend
    // connection, which is exactly the condition under which a session-scoped
    // (non-LOCAL) setting would leak. is_local => true is what prevents it;
    // without this property, a scoped request could silently filter a later,
    // unrelated request's queries to the wrong company.
    await app.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
      await tx.unsafe(`SELECT 1`);
    });

    const [row] = await app.unsafe<{ setting: string | null }[]>(
      `SELECT nullif(current_setting('${TENANT_COMPANY_SETTING}', true), '') AS setting`,
    );
    expect(row?.setting).toBeNull();
  });

  it("names the policy consistently so the boot check can find it", async () => {
    const rows = await owner.unsafe<{ polname: string }[]>(
      `SELECT DISTINCT p.polname
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'`,
    );
    expect(rows.map((row) => row.polname)).toEqual([TENANT_ISOLATION_POLICY]);
  });
});

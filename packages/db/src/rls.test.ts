import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  NULLABLE_SCOPE_POLICY_NAMES,
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
  {
    table: "agent_knowledge_bindings",
    columns: "company_id, agent_id_snapshot, idempotency_key",
    values: "$1, gen_random_uuid(), gen_random_uuid()::text",
  },
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

  describe("nullableScope tables: WITH CHECK must not admit company_id IS NULL", () => {
    // TECH-6956 round 1 (Argus, real privilege escalation): `invites` is a
    // nullableScope table (its instance-level rows are bootstrap CEO invite
    // tokens with no company yet). The policy's WITH CHECK clause used to be
    // identical to its USING clause, so a session scoped to a real company
    // could INSERT/UPDATE a `company_id IS NULL` row -- detaching a row from
    // its company into the unscoped pool, or planting/tampering with a
    // bootstrap invite. These tests prove that path is now rejected while
    // ordinary same-company writes still work.
    const nullRowId = randomUUID();
    const companyARowId = randomUUID();

    beforeAll(async () => {
      await owner.unsafe(
        `INSERT INTO invites (id, company_id, token_hash, expires_at)
         VALUES ($1, NULL, 'bootstrap-null-token', now() + interval '1 day'),
                ($2, $3, 'company-a-token', now() + interval '1 day')`,
        [nullRowId, companyARowId, companyA],
      );
    });

    it("still admits the NULL-company row through USING (read visibility unchanged)", async () => {
      const rows = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe<{ id: string }[]>(`SELECT id FROM invites WHERE id = $1`, [
          nullRowId,
        ]);
      });
      expect(rows.map((row) => row.id)).toContain(nullRowId);
    });

    it("rejects an INSERT that would plant a company_id IS NULL row while scoped", async () => {
      await expect(
        app.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
          await tx.unsafe(
            `INSERT INTO invites (id, company_id, token_hash, expires_at)
             VALUES ($1, NULL, 'smuggled-null-token', now() + interval '1 day')`,
            [randomUUID()],
          );
        }),
      ).rejects.toThrow(/row-level security/i);

      const [row] = await owner.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM invites WHERE token_hash = 'smuggled-null-token'`,
      );
      expect(row?.count).toBe(0);
    });

    it("rejects an UPDATE that would detach a company's own row into the NULL pool", async () => {
      await expect(
        app.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
          await tx.unsafe(`UPDATE invites SET company_id = NULL WHERE id = $1`, [companyARowId]);
        }),
      ).rejects.toThrow(/row-level security/i);

      const [row] = await owner.unsafe<{ company_id: string }[]>(
        `SELECT company_id FROM invites WHERE id = $1`,
        [companyARowId],
      );
      // Untouched -- still belongs to company A, not detached into the
      // unscoped pool.
      expect(row?.company_id).toBe(companyA);
    });

    it("cannot overwrite the existing NULL-company row while scoped", async () => {
      // TECH-6956 round 2: the read-visible NULL row is still admitted by
      // USING for SELECT, but UPDATE's OWN USING predicate (the row-
      // targeting half) is now as strict as WITH CHECK for nullableScope
      // tables -- so the row is excluded from UPDATE's target set entirely.
      // That means this is zero affected rows, not a WITH CHECK error: the
      // row is never reached in the first place. (Round 1 only fixed WITH
      // CHECK, which meant this exact statement used to raise instead --
      // still blocked, but for the wrong reason and via the wrong clause;
      // see the "UPDATE/DELETE must not be able to target" describe block
      // below for the fix and its dedicated coverage.)
      const updated = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(`UPDATE invites SET token_hash = 'hijacked-null-token' WHERE id = $1`, [
          nullRowId,
        ]);
      });
      expect(updated.count).toBe(0);

      const [row] = await owner.unsafe<{ token_hash: string }[]>(
        `SELECT token_hash FROM invites WHERE id = $1`,
        [nullRowId],
      );
      expect(row?.token_hash).toBe("bootstrap-null-token");
    });

    it("still allows an ordinary same-company write", async () => {
      const updated = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(`UPDATE invites SET allowed_join_types = 'sso' WHERE id = $1`, [
          companyARowId,
        ]);
      });
      expect(updated.count).toBe(1);
    });
  });

  describe("TECH-6956 round 1: claim-style UPDATE stays correct under a mismatched ambient scope", () => {
    // heartbeat.ts#claimQueuedRun is a read-then-write "claim" site: it reads
    // a queued run, then does `UPDATE heartbeat_runs SET status='running' ...
    // WHERE id = $1 AND status = 'queued'` and treats zero affected rows as
    // "someone else already claimed it". Argus's finding 5: if the ambient
    // company scope bound to the transaction is ever mismatched relative to
    // the run being claimed, RLS filters the UPDATE to zero rows too --
    // indistinguishable, from inside that function, from ordinary claim
    // contention. The fix added an explicit `company_id` predicate matching
    // the row's own company alongside the RLS predicate. This test proves
    // the combination behaves correctly: a same-company claim succeeds, and
    // a claim attempted under the WRONG company's ambient scope is safely a
    // no-op -- it does not claim the wrong row, corrupt state, or throw an
    // opaque error, it just returns nothing to claim, same as any other lost
    // race.
    const runA = randomUUID();
    const runB = randomUUID();

    beforeAll(async () => {
      await owner.unsafe(
        `INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
         VALUES ($1, $2, $3, 'queued'), ($4, $5, $6, 'queued')`,
        [runA, companyA, agentA, runB, companyB, agentB],
      );
    });

    it("claims a run when the ambient scope matches its company", async () => {
      const claimed = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(
          `UPDATE heartbeat_runs SET status = 'running'
            WHERE id = $1 AND company_id = $2 AND status = 'queued'`,
          [runA, companyA],
        );
      });
      expect(claimed.count).toBe(1);
    });

    it(
      "is a safe no-op -- not a wrong-row claim or an opaque error -- when scope is mismatched",
      async () => {
        // Ambient scope bound to company A, but the row being "claimed"
        // belongs to company B. Both the RLS policy (USING/WITH CHECK) and
        // the explicit company_id predicate added in the fix agree this
        // should affect zero rows.
        const claimed = await app.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
          return await tx.unsafe(
            `UPDATE heartbeat_runs SET status = 'running'
              WHERE id = $1 AND company_id = $2 AND status = 'queued'`,
            [runB, companyB],
          );
        });
        // Zero rows, not an error: exactly what claimQueuedRun already
        // treats as "nothing to claim right now" -- a mismatched scope fails
        // the same safe way ordinary contention does, rather than a new,
        // more dangerous failure mode.
        expect(claimed.count).toBe(0);

        const [row] = await owner.unsafe<{ status: string }[]>(
          `SELECT status FROM heartbeat_runs WHERE id = $1`,
          [runB],
        );
        // Untouched: still queued, verified from the unfiltered owner
        // connection so this is the row genuinely surviving, not merely
        // being invisible to the app role.
        expect(row?.status).toBe("queued");
      },
    );
  });

  it("names policies consistently so the boot check can find them", async () => {
    const rows = await owner.unsafe<{ polname: string }[]>(
      `SELECT DISTINCT p.polname
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'`,
    );
    // Non-nullableScope tables carry the single FOR ALL policy;
    // nullableScope tables (invites, plugin_entities, ...) carry the four
    // command-specific policies instead (TECH-6956 round 2).
    expect(new Set(rows.map((row) => row.polname))).toEqual(
      new Set([
        TENANT_ISOLATION_POLICY,
        NULLABLE_SCOPE_POLICY_NAMES.select,
        NULLABLE_SCOPE_POLICY_NAMES.insert,
        NULLABLE_SCOPE_POLICY_NAMES.update,
        NULLABLE_SCOPE_POLICY_NAMES.delete,
      ]),
    );
  });

  describe("nullableScope tables: UPDATE/DELETE must not be able to target a NULL-company row while scoped", () => {
    // TECH-6956 round 2 (Argus, real privilege escalation): round 1 correctly
    // narrowed WITH CHECK so a scoped session cannot WRITE a company_id IS
    // NULL row. But the single FOR ALL policy's USING clause still admitted
    // company_id IS NULL, which governs which rows UPDATE/DELETE can even
    // target -- so a company-A session could still DELETE, or blank-
    // overwrite, an existing instance-level row (a bootstrap CEO invite
    // token, say), despite being unable to plant a new one. These tests
    // prove that hole is closed: UPDATE/DELETE's own USING predicate is now
    // as strict as WITH CHECK for nullableScope tables.
    const nullRowId = randomUUID();
    const companyARowId = randomUUID();

    beforeAll(async () => {
      await owner.unsafe(
        `INSERT INTO invites (id, company_id, token_hash, expires_at)
         VALUES ($1, NULL, 'round2-bootstrap-null-token', now() + interval '1 day'),
                ($2, $3, 'round2-company-a-token', now() + interval '1 day')`,
        [nullRowId, companyARowId, companyA],
      );
    });

    it("cannot DELETE the existing NULL-company row while scoped", async () => {
      const deleted = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(`DELETE FROM invites WHERE id = $1`, [nullRowId]);
      });
      // USING now filters the row out of DELETE's target set entirely --
      // zero rows affected, not an error, mirroring the ordinary cross-tenant
      // DELETE semantics elsewhere in this suite.
      expect(deleted.count).toBe(0);

      const [row] = await owner.unsafe<{ id: string }[]>(`SELECT id FROM invites WHERE id = $1`, [
        nullRowId,
      ]);
      expect(row?.id).toBe(nullRowId);
    });

    it("cannot UPDATE the existing NULL-company row's own fields while scoped", async () => {
      const updated = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(`UPDATE invites SET token_hash = 'round2-hijacked' WHERE id = $1`, [
          nullRowId,
        ]);
      });
      // UPDATE's own USING predicate now excludes the NULL-company row from
      // its target set, so this is zero affected rows rather than a WITH
      // CHECK error -- the row is never reached in the first place.
      expect(updated.count).toBe(0);

      const [row] = await owner.unsafe<{ token_hash: string }[]>(
        `SELECT token_hash FROM invites WHERE id = $1`,
        [nullRowId],
      );
      expect(row?.token_hash).toBe("round2-bootstrap-null-token");
    });

    it("still cannot UPDATE the NULL-company row to claim it by setting company_id, per round 1's WITH CHECK", async () => {
      // Belt-and-suspenders: this path is blocked twice over now -- UPDATE's
      // USING (round 2) excludes the row from the target set before WITH
      // CHECK (round 1) would even be evaluated. Kept as its own assertion so
      // a future change to either clause cannot silently regress the other.
      const updated = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(`UPDATE invites SET company_id = $1 WHERE id = $2`, [
          companyA,
          nullRowId,
        ]);
      });
      expect(updated.count).toBe(0);

      const [row] = await owner.unsafe<{ company_id: string | null }[]>(
        `SELECT company_id FROM invites WHERE id = $1`,
        [nullRowId],
      );
      expect(row?.company_id).toBeNull();
    });

    it("still allows an ordinary same-company UPDATE and DELETE", async () => {
      const updated = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(`UPDATE invites SET allowed_join_types = 'sso' WHERE id = $1`, [
          companyARowId,
        ]);
      });
      expect(updated.count).toBe(1);

      const deleted = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(`DELETE FROM invites WHERE id = $1`, [companyARowId]);
      });
      expect(deleted.count).toBe(1);
    });

    it("an unscoped session (no app.current_company_id bound) can still UPDATE/DELETE the instance-level row", async () => {
      // Only an unscoped session -- migrations, admin backfills, no company
      // bound -- may touch an instance-level row. This is what keeps the
      // change additive rather than making instance-level rows permanently
      // unmanageable.
      const updated = await app.unsafe(`UPDATE invites SET token_hash = 'admin-touched' WHERE id = $1`, [
        nullRowId,
      ]);
      expect(updated.count).toBe(1);

      const deleted = await app.unsafe(`DELETE FROM invites WHERE id = $1`, [nullRowId]);
      expect(deleted.count).toBe(1);
    });
  });

  describe("TECH-7164: agent_knowledge_revocations tenant isolation (FK-chained rows)", () => {
    // The revocations table cannot join the PROBED_TABLES loop above: its
    // rows chain to a binding via the binding_id FK (RESTRICT), so seeding
    // one requires seeding a binding first. This block gives it the same
    // non-superuser treatment: cross-tenant reads filtered to zero, own rows
    // visible, cross-tenant writes rejected, and unscoped sweeps (the trusted
    // admin/migration mode, per the repo's additive-by-design convention)
    // still seeing every company.
    const bindingA = randomUUID();
    const bindingB = randomUUID();
    const bindingBWithoutRevocation = randomUUID();
    const revocationA = randomUUID();
    const revocationB = randomUUID();
    const agentIdA = randomUUID();
    const agentIdB = randomUUID();
    const agentIdB2 = randomUUID();

    beforeAll(async () => {
      await owner.unsafe(
        `INSERT INTO agent_knowledge_bindings (id, company_id, agent_id_snapshot, idempotency_key)
         VALUES ($1, $2, $3, 'rls-rev-binding-a'), ($4, $5, $6, 'rls-rev-binding-b'),
                ($7, $5, $8, 'rls-rev-binding-b2')`,
        [
          bindingA,
          companyA,
          agentIdA,
          bindingB,
          companyB,
          agentIdB,
          bindingBWithoutRevocation,
          agentIdB2,
        ],
      );
      await owner.unsafe(
        `INSERT INTO agent_knowledge_revocations (id, binding_id, company_id, agent_id_snapshot, idempotency_key, status, reason, fence_epoch)
         VALUES ($1, $2, $3, $4, 'rls-revocation-a', 'pending', 'agent_terminated', 2),
                ($5, $6, $7, $8, 'rls-revocation-b', 'pending', 'agent_terminated', 2)`,
        [revocationA, bindingA, companyA, agentIdA, revocationB, bindingB, companyB, agentIdB],
      );
    });

    it("filters a cross-tenant revocation read to zero rows while the row provably exists", async () => {
      // Sanity-check the fixture from the owner connection first, so a
      // zero-row result below can only be attributed to RLS.
      const [seeded] = await owner.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM agent_knowledge_revocations WHERE company_id = $1`,
        [companyB],
      );
      expect(seeded?.count).toBe(1);

      const rows = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM agent_knowledge_revocations WHERE company_id = $1`,
          [companyB],
        );
      });
      expect(rows[0]?.count).toBe(0);
    });

    it("still returns the session's own revocation rows, so zero above is filtering", async () => {
      const visible = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyB]);
        return await tx.unsafe<{ id: string; company_id: string }[]>(
          `SELECT id, company_id FROM agent_knowledge_revocations`,
        );
      });
      expect(visible.map((row) => row.id)).toContain(revocationB);
      expect(visible.map((row) => row.id)).not.toContain(revocationA);
    });

    it("raises on a cross-tenant revocation INSERT rather than silently dropping it", async () => {
      await expect(
        app.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
          await tx.unsafe(
            `INSERT INTO agent_knowledge_revocations (binding_id, company_id, agent_id_snapshot, idempotency_key, status, reason, fence_epoch)
             VALUES ($1, $2, $3, 'rls-revocation-smuggled', 'pending', 'agent_terminated', 2)`,
            [bindingB, companyB, randomUUID()],
          );
        }),
      ).rejects.toThrow(/row-level security/i);

      const [row] = await owner.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM agent_knowledge_revocations WHERE idempotency_key = 'rls-revocation-smuggled'`,
      );
      expect(row?.count).toBe(0);
    });

    it("raises on a cross-tenant revocation UPDATE or DELETE", async () => {
      const updated = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(
          `UPDATE agent_knowledge_revocations SET status = 'confirmed' WHERE id = $1`,
          [revocationB],
        );
      });
      expect(updated.count).toBe(0);

      const deleted = await app.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
        return await tx.unsafe(`DELETE FROM agent_knowledge_revocations WHERE id = $1`, [
          revocationB,
        ]);
      });
      expect(deleted.count).toBe(0);

      // Verified from the owner connection: the row genuinely survived.
      const [row] = await owner.unsafe<{ status: string }[]>(
        `SELECT status FROM agent_knowledge_revocations WHERE id = $1`,
        [revocationB],
      );
      expect(row?.status).toBe("pending");
    });

    it("an unscoped session (the trusted admin/migration sweep mode) still sees every company's revocations", async () => {
      const rows = await app.unsafe<{ id: string }[]>(
        `SELECT id FROM agent_knowledge_revocations`,
      );
      expect(rows.map((row) => row.id).sort()).toEqual([revocationA, revocationB].sort());
    });

    it("composite FK blocks cross-company binding_id reference (forged binding cross-company fails)", async () => {
      await expect(
        app.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('${TENANT_COMPANY_SETTING}', $1, true)`, [companyA]);
          await tx.unsafe(
            `INSERT INTO agent_knowledge_revocations (binding_id, company_id, agent_id_snapshot, idempotency_key, status, reason, fence_epoch)
             VALUES ($1, $2, $3, 'rls-revocation-cross-ref', 'pending', 'agent_terminated', 2)
             RETURNING id`,
            [bindingBWithoutRevocation, companyA, agentIdB2],
          );
        }),
      ).rejects.toThrow(/agent_knowledge_revocations_company_id_binding_id_fk|foreign key constraint/i);
    });
  });
});

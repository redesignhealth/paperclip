import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { withCompanyScope } from "./company-scope.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

/**
 * TECH-6956 round 4 (Argus): proves `withCompanyScope`'s nested-reuse path
 * actually protects the outer transaction from a Postgres error thrown (and
 * caught) inside a nested call, using a real Postgres connection rather than
 * a mock -- this is exactly the failure mode a mock can't demonstrate,
 * because Postgres (not drizzle, not our code) is what aborts a transaction
 * after certain errors until a `ROLLBACK`.
 *
 * Without a `SAVEPOINT` around the nested-reuse call, a caught unique-
 * constraint violation inside the nested `withCompanyScope` leaves the
 * outer transaction's connection in Postgres's "current transaction is
 * aborted" state (error 25P02) -- any further statement on it, including
 * the outer call's own subsequent work, fails.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-scope savepoint tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("withCompanyScope nested reuse (real Postgres)", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-company-scope-savepoint-");
    db = createDb(database.connectionString);
    await db.execute(
      sql`create table if not exists company_scope_savepoint_probe (id int primary key)`,
    );
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("recovers the outer transaction after a caught error in a nested-reuse call, via a SAVEPOINT", async () => {
    await db.execute(sql`truncate table company_scope_savepoint_probe`);

    let nestedErrorCaught = false;
    let outerContinuedSuccessfully = false;

    await withCompanyScope(db, companyId, async (outerTx) => {
      await outerTx.execute(sql`insert into company_scope_savepoint_probe (id) values (1)`);

      try {
        // Passing `db` (not `outerTx`) back in, same as a real caller that
        // forwards the original handle -- this must still reuse the outer
        // scope's connection under a SAVEPOINT rather than opening a fresh,
        // unscoped transaction.
        await withCompanyScope(db, companyId, async (innerTx) => {
          // Duplicate primary key -> a real Postgres unique-violation error,
          // the exact class of error that leaves a connection aborted
          // without a savepoint to roll back to.
          await innerTx.execute(sql`insert into company_scope_savepoint_probe (id) values (1)`);
        });
      } catch {
        nestedErrorCaught = true;
      }

      // If the nested call's error aborted the whole outer transaction
      // (the pre-fix behavior), this statement throws "current transaction
      // is aborted, commands ignored until end of transaction block".
      await outerTx.execute(sql`insert into company_scope_savepoint_probe (id) values (2)`);
      outerContinuedSuccessfully = true;
    });

    expect(nestedErrorCaught).toBe(true);
    expect(outerContinuedSuccessfully).toBe(true);

    const rows = (await db.execute(
      sql`select id from company_scope_savepoint_probe order by id`,
    )) as unknown as Array<{ id: number }>;
    // id=1 survives from the outer call; the nested call's own (failed,
    // rolled-back-to-savepoint) insert of id=1 never landed a duplicate;
    // id=2 proves the outer transaction committed the work that ran after
    // the nested failure.
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });

  it("isolates each level's error to that level's own savepoint across three levels of nesting", async () => {
    // TECH-6956 round 5 (Argus): the round-4 fix opened a real SAVEPOINT for
    // the nested-reuse path, but didn't update `activeCompanyScope` (the
    // AsyncLocalStorage context) to point at that savepoint's own tx handle
    // -- so a THIRD level of nesting, inside the second level's callback,
    // would still see the ORIGINAL outer tx in the ambient context instead
    // of the second level's savepoint-scoped one. This proves a failure at
    // the innermost (third) level rolls back only its own work, leaving
    // BOTH the first and second levels' own inserts intact.
    await db.execute(sql`truncate table company_scope_savepoint_probe`);

    let level3ErrorCaught = false;

    await withCompanyScope(db, companyId, async (level1Tx) => {
      await level1Tx.execute(sql`insert into company_scope_savepoint_probe (id) values (1)`);

      await withCompanyScope(db, companyId, async (level2Tx) => {
        await level2Tx.execute(sql`insert into company_scope_savepoint_probe (id) values (2)`);

        try {
          await withCompanyScope(db, companyId, async (level3Tx) => {
            // Duplicates level2's own row -- a unique violation scoped to
            // the THIRD level. If the third level's savepoint were
            // mistakenly opened against the wrong (stale) ambient tx, this
            // would still fail the same way, but the risk this test
            // guards is a connection left aborted at whichever level the
            // stale reference actually pointed at.
            await level3Tx.execute(sql`insert into company_scope_savepoint_probe (id) values (2)`);
          });
        } catch {
          level3ErrorCaught = true;
        }

        // The second level must still be usable after catching the third
        // level's error -- proving the third level rolled back to its OWN
        // savepoint, not the second level's.
        await level2Tx.execute(sql`insert into company_scope_savepoint_probe (id) values (3)`);
      });

      // The first level must still be usable after the whole second-level
      // call (which itself absorbed a third-level failure) returns.
      await level1Tx.execute(sql`insert into company_scope_savepoint_probe (id) values (4)`);
    });

    expect(level3ErrorCaught).toBe(true);

    const rows = (await db.execute(
      sql`select id from company_scope_savepoint_probe order by id`,
    )) as unknown as Array<{ id: number }>;
    // 1 (level1), 2 (level2), 3 (level2, after the caught level3 error), 4
    // (level1, after the whole level2 call returns) all survive. The
    // duplicate id=2 insert from level3 never lands.
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4]);
  });
});

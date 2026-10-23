import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  clearAmbientCompanyId,
  getAmbientCompanyId,
  runWithTenantContext,
  setAmbientCompanyId,
} from "./tenant-context.js";
import {
  bindAmbientCompanyScope,
  isBindableCompanyId,
  runWithCompanyScopeTracked,
  withCompanyScope,
} from "./company-scope.js";

const companyA = randomUUID();
const companyB = randomUUID();

/**
 * Records the SQL a scoped transaction issues, without needing Postgres.
 *
 * Also exposes `transaction`, delegating straight to itself, so the same
 * object can stand in for a `tx` handle that a caller passes back into a
 * nested `withCompanyScope` call -- real drizzle transaction handles expose
 * `.transaction()` for savepoints the same way.
 */
type RecordingExecutor = {
  execute: (query: { queryChunks?: unknown[] }) => Promise<undefined>;
  transaction: <T>(fn: (tx: RecordingExecutor) => Promise<T>) => Promise<T>;
};

function createRecordingExecutor() {
  const bound: Array<unknown> = [];
  let savepointCalls = 0;
  const executor: RecordingExecutor = {
    execute: async (query) => {
      bound.push(query);
      return undefined;
    },
    transaction: async (fn) => {
      savepointCalls++;
      return await fn(executor);
    },
  };
  return { executor, bound, savepointCalls: () => savepointCalls };
}

describe("ambient tenant context", () => {
  it("is a no-op outside any context, so non-request code paths are unaffected", () => {
    // CLI commands, migrations and schedulers run with no context. They must
    // keep working exactly as before rather than throwing or picking up a
    // stale company from somewhere.
    expect(() => setAmbientCompanyId(companyA)).not.toThrow();
    expect(getAmbientCompanyId()).toBeUndefined();
  });

  it("carries a company id through async continuations", async () => {
    await runWithTenantContext(async () => {
      setAmbientCompanyId(companyA);
      await Promise.resolve();
      // The value has to survive an await, because `assertCompanyAccess` runs
      // early in a handler and the queries it is meant to scope run later.
      expect(getAmbientCompanyId()).toBe(companyA);
    });
  });

  it("isolates concurrent contexts from each other", async () => {
    const observed: Array<string | undefined> = [];
    await Promise.all([
      runWithTenantContext(async () => {
        setAmbientCompanyId(companyA);
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed.push(getAmbientCompanyId());
      }),
      runWithTenantContext(async () => {
        setAmbientCompanyId(companyB);
        observed.push(getAmbientCompanyId());
      }),
    ]);
    // This is the entire reason the holder lives in AsyncLocalStorage instead
    // of a module variable: two in-flight requests must not see each other's
    // tenant, or the backstop becomes a cross-tenant leak of its own.
    expect(new Set(observed)).toEqual(new Set([companyA, companyB]));
  });

  it("tolerates the same company being established repeatedly", () => {
    runWithTenantContext(() => {
      setAmbientCompanyId(companyA);
      setAmbientCompanyId(companyA);
      // Handlers commonly call assertCompanyAccess more than once for the
      // same company; that must not look like a conflict.
      expect(getAmbientCompanyId()).toBe(companyA);
    });
  });

  it("drops scope when a request touches two companies, and never re-narrows", () => {
    runWithTenantContext(() => {
      setAmbientCompanyId(companyA);
      setAmbientCompanyId(companyB);
      // Fails OPEN on purpose. Picking either company would silently return
      // wrong results from a legitimate cross-company read -- turning a
      // security backstop into a correctness bug. Unscoped is no worse than
      // today's behavior.
      expect(getAmbientCompanyId()).toBeUndefined();

      setAmbientCompanyId(companyA);
      // The latch matters: a request already observed spanning tenants must
      // not be retroactively narrowed to whichever company happened to be
      // authorized last.
      expect(getAmbientCompanyId()).toBeUndefined();
    });
  });

  it("lets deliberately cross-tenant code opt out", () => {
    runWithTenantContext(() => {
      setAmbientCompanyId(companyA);
      clearAmbientCompanyId();
      expect(getAmbientCompanyId()).toBeUndefined();
    });
  });
});

describe("company scope binding", () => {
  it("only accepts uuid company ids", () => {
    expect(isBindableCompanyId(companyA)).toBe(true);
    expect(isBindableCompanyId("not-a-uuid")).toBe(false);
    expect(isBindableCompanyId(undefined)).toBe(false);
  });

  it("fails closed on a malformed ambient id rather than degrading to unscoped", async () => {
    const { executor, bound } = createRecordingExecutor();
    await runWithTenantContext(async () => {
      setAmbientCompanyId("not-a-uuid");
      // Unlike "no ambient context at all" (a safe, intentional default for
      // non-request code paths), a malformed-but-present id means a context
      // WAS established and something upstream produced a bad value -- there
      // is no safe default here, so this must throw rather than silently run
      // the transaction unscoped (which would grant full cross-tenant access).
      await expect(bindAmbientCompanyScope(executor)).rejects.toThrow(/malformed ambient company id/);
    });
    expect(bound).toHaveLength(0);
  });

  it("skips the bind when there is no ambient company", async () => {
    const { executor, bound } = createRecordingExecutor();
    await expect(bindAmbientCompanyScope(executor)).resolves.toBeUndefined();
    expect(bound).toHaveLength(0);
  });

  it("binds the ambient company when one is established", async () => {
    const { executor, bound } = createRecordingExecutor();
    await runWithTenantContext(async () => {
      setAmbientCompanyId(companyA);
      await expect(bindAmbientCompanyScope(executor)).resolves.toBe(companyA);
    });
    expect(bound).toHaveLength(1);
  });

  it("binds explicitly inside withCompanyScope, without needing a context", async () => {
    const { executor, bound } = createRecordingExecutor();
    const db = {
      transaction: async <T>(fn: (tx: typeof executor) => Promise<T>) => await fn(executor),
    };
    // The explicit primitive exists for worker and plugin entry points that
    // have no HTTP request to inherit an ambient company from, so it must not
    // depend on one.
    await expect(withCompanyScope(db, companyA, async () => "ran")).resolves.toBe("ran");
    expect(bound).toHaveLength(1);
  });

  it("rejects a non-uuid passed explicitly rather than binding it", async () => {
    const { executor } = createRecordingExecutor();
    const db = {
      transaction: async <T>(fn: (tx: typeof executor) => Promise<T>) => await fn(executor),
    };
    await expect(withCompanyScope(db, "not-a-uuid", async () => "ran")).rejects.toThrow(
      /non-uuid company id/,
    );
  });

  it("reuses the outer scope's real tx instead of opening a nested transaction for the same company", async () => {
    const { executor, bound, savepointCalls } = createRecordingExecutor();
    let transactionCalls = 0;
    const rootDb = {
      transaction: async <T>(fn: (tx: typeof executor) => Promise<T>) => {
        transactionCalls++;
        return await fn(executor);
      },
    };
    let outerTx: typeof executor | undefined;
    let innerTx: typeof executor | undefined;
    await withCompanyScope(rootDb, companyA, async (tx) => {
      outerTx = tx;
      // Passing the *root* db back in, not the scoped `tx` -- this is the
      // case that matters: a caller forwarding the original handle instead
      // of threading the inner one through must still end up running on the
      // already-scoped connection, not a fresh, unscoped one from rootDb.
      await withCompanyScope(rootDb, companyA, async (nestedTx) => {
        innerTx = nestedTx;
        return "nested";
      });
    });
    // rootDb.transaction was only ever invoked by the outer call; the nested
    // call did not open (and did not need) a second top-level transaction on
    // it.
    expect(transactionCalls).toBe(1);
    // The nested call went through a SAVEPOINT on the outer scope's own
    // connection (`outer.tx.transaction(...)`), not a bare direct call --
    // this is what keeps a caught Postgres error inside the nested call from
    // aborting the whole outer transaction. See the real-Postgres
    // regression test in company-scope.integration.test.ts for the actual
    // ROLLBACK TO SAVEPOINT behavior this proves is being invoked.
    expect(savepointCalls()).toBe(1);
    // The recording mock's `transaction()` re-invokes `fn` with the same
    // executor object (it has no distinct savepoint-scoped connection to
    // hand back), so identity is preserved here even though real drizzle
    // transactions return a distinct (but same-connection) handle.
    expect(innerTx).toBe(outerTx);
    // Only one bind ever happened.
    expect(bound).toHaveLength(1);
  });

  it("isolates a nested reuse's error from the outer scope instead of letting it propagate unrecovered", async () => {
    // A caught error inside the nested call must not prevent the outer
    // scope from continuing to run further work on the same connection --
    // that is the entire reason for going through `outer.tx.transaction(...)`
    // (a SAVEPOINT) instead of calling `fn` directly.
    const { executor, savepointCalls } = createRecordingExecutor();
    const rootDb = {
      transaction: async <T>(fn: (tx: typeof executor) => Promise<T>) => await fn(executor),
    };
    let recoveredAndContinued = false;
    await withCompanyScope(rootDb, companyA, async () => {
      await expect(
        withCompanyScope(rootDb, companyA, async () => {
          throw new Error("simulated constraint violation");
        }),
      ).rejects.toThrow(/simulated constraint violation/);
      // Still inside the outer scope's callback after the nested call threw
      // and was caught -- proving the outer scope is still usable.
      recoveredAndContinued = true;
    });
    expect(savepointCalls()).toBe(1);
    expect(recoveredAndContinued).toBe(true);
  });

  it("rejects nesting withCompanyScope for a different company than the outer scope", async () => {
    const { executor } = createRecordingExecutor();
    const db = {
      transaction: async <T>(fn: (tx: typeof executor) => Promise<T>) => await fn(executor),
    };
    await withCompanyScope(db, companyA, async (tx) => {
      await expect(withCompanyScope(tx, companyB, async () => "nested")).rejects.toThrow(
        /already scoped to/,
      );
    });
  });

  it("interops with ambient auto-binding: a withCompanyScope nested under an ambiently-tracked transaction reuses it", async () => {
    // Simulates what attachAmbientCompanyScope (client.ts) does: bind, then
    // track the scope via runWithCompanyScopeTracked before running the rest
    // of the transaction body. A withCompanyScope call nested inside that
    // body must recognize the ambient binding and reuse it rather than
    // opening its own transaction underneath -- this is the interop seam
    // that made the ambient path and withCompanyScope's nesting guard blind
    // to each other before runWithCompanyScopeTracked existed.
    const { executor: ambientTx, bound: ambientBound } = createRecordingExecutor();
    let transactionCalls = 0;
    const rootDb = {
      transaction: async <T>(fn: (tx: typeof ambientTx) => Promise<T>) => {
        transactionCalls++;
        return await fn(ambientTx);
      },
    };
    let nestedTx: typeof ambientTx | undefined;
    await runWithCompanyScopeTracked(companyA, ambientTx, async () => {
      await withCompanyScope(rootDb, companyA, async (tx) => {
        nestedTx = tx;
        return "nested";
      });
    });
    expect(transactionCalls).toBe(0);
    expect(nestedTx).toBe(ambientTx);
    expect(ambientBound).toHaveLength(0);
  });
});

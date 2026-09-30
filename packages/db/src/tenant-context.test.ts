import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  clearAmbientCompanyId,
  getAmbientCompanyId,
  runWithTenantContext,
  setAmbientCompanyId,
} from "./tenant-context.js";
import { bindAmbientCompanyScope, isBindableCompanyId, withCompanyScope } from "./company-scope.js";

const companyA = randomUUID();
const companyB = randomUUID();

/** Records the SQL a scoped transaction issues, without needing Postgres. */
function createRecordingExecutor() {
  const bound: Array<unknown> = [];
  const executor = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      bound.push(query);
      return undefined;
    },
  };
  return { executor, bound };
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

  it("refuses to bind a non-uuid, which would break every covered query", async () => {
    const { executor } = createRecordingExecutor();
    await runWithTenantContext(async () => {
      setAmbientCompanyId("not-a-uuid");
      // The RLS predicate casts the setting to uuid, so a malformed value
      // would make every query against every covered table raise `invalid
      // input syntax for type uuid` -- a total outage, not a scoped failure.
      // Skipping the bind degrades to unscoped instead.
      await expect(bindAmbientCompanyScope(executor)).resolves.toBeUndefined();
    });
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
});

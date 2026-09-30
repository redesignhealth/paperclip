import { describe, expect, it, vi } from "vitest";
import { resolveRlsBootCheckMode } from "./rls-boot-check.js";
import { formatRlsProblems, verifyTenantIsolationPolicies } from "./rls.js";

/**
 * TECH-6956: unit coverage for the boot-check decision logic and its
 * introspection query shape. The end-to-end behavior against a real Postgres
 * (every covered table enabled and FORCEd) is asserted in `rls.test.ts`.
 */

describe("RLS boot check mode", () => {
  it("fails closed on authenticated public deployments", () => {
    // The multi-tenant, internet-exposed configuration -- the one where
    // losing tenant isolation is a security incident rather than an
    // inconvenience.
    expect(resolveRlsBootCheckMode({}, true)).toBe("error");
  });

  it("only warns elsewhere, so a local instance is not bricked", () => {
    // Developers run single-tenant instances against databases that are
    // routinely mid-migration. Hard-failing there would get this check
    // deleted rather than fixed.
    expect(resolveRlsBootCheckMode({}, false)).toBe("warn");
  });

  it("honours an explicit override in either direction", () => {
    expect(resolveRlsBootCheckMode({ PAPERCLIP_RLS_BOOT_CHECK: "warn" }, true)).toBe("warn");
    expect(resolveRlsBootCheckMode({ PAPERCLIP_RLS_BOOT_CHECK: "off" }, true)).toBe("off");
    expect(resolveRlsBootCheckMode({ PAPERCLIP_RLS_BOOT_CHECK: "ERROR" }, false)).toBe("error");
    // Blank is treated as unset rather than as an override, so an empty
    // env var in a task definition cannot silently disable the check.
    expect(resolveRlsBootCheckMode({ PAPERCLIP_RLS_BOOT_CHECK: "  " }, true)).toBe("error");
  });

  it("rejects an unrecognised value instead of guessing", () => {
    // A typo like `PAPERCLIP_RLS_BOOT_CHECK=false` must not quietly fall back
    // to the default -- the operator clearly intended something.
    expect(() => resolveRlsBootCheckMode({ PAPERCLIP_RLS_BOOT_CHECK: "false" }, true)).toThrow(
      /must be one of/,
    );
  });
});

describe("RLS verification", () => {
  function fakeSql(rows: Array<Record<string, unknown>>, role: Record<string, unknown>) {
    return {
      unsafe: vi.fn(async (query: string) => {
        if (query.includes("rolbypassrls")) return [role] as never;
        return rows as never;
      }),
    };
  }

  const okRole = { role: "paperclip_app", superuser: false, bypass_rls: false };

  it("reports a policy that exists but is not FORCEd", async () => {
    const result = await verifyTenantIsolationPolicies(
      fakeSql(
        [
          {
            table_name: "agents",
            relrowsecurity: true,
            relforcerowsecurity: false,
            policy_name: "tenant_isolation",
            qual: "app.current_company_id",
            with_check: "app.current_company_id",
          },
        ],
        okRole,
      ),
      [{ table: "agents", column: "company_id", nullableScope: false }],
    );
    // This is the failure mode that looks fine in pg_policies: the policy is
    // present and correct, and simply never applies to the table owner --
    // which is the role Paperclip connects as.
    expect(result.problems).toEqual([{ kind: "rls-not-forced", table: "agents" }]);
  });

  it("reports a missing policy", async () => {
    const result = await verifyTenantIsolationPolicies(
      fakeSql(
        [
          {
            table_name: "agents",
            relrowsecurity: true,
            relforcerowsecurity: true,
            policy_name: null,
            qual: null,
            with_check: null,
          },
        ],
        okRole,
      ),
      [{ table: "agents", column: "company_id", nullableScope: false }],
    );
    expect(result.problems).toEqual([{ kind: "missing-policy", table: "agents" }]);
  });

  it("reports a policy that no longer consults the session variable", async () => {
    const result = await verifyTenantIsolationPolicies(
      fakeSql(
        [
          {
            table_name: "agents",
            relrowsecurity: true,
            relforcerowsecurity: true,
            policy_name: "tenant_isolation",
            qual: "true",
            with_check: "true",
          },
        ],
        okRole,
      ),
      [{ table: "agents", column: "company_id", nullableScope: false }],
    );
    // A `USING (true)` policy named `tenant_isolation` would pass a
    // name-only check while isolating nothing.
    expect(result.problems).toEqual([
      {
        kind: "policy-predicate-mismatch",
        table: "agents",
        expectedSetting: "app.current_company_id",
      },
    ]);
  });

  it("reports a covered table that is absent from the database", async () => {
    const result = await verifyTenantIsolationPolicies(fakeSql([], okRole), [
      { table: "agents", column: "company_id", nullableScope: false },
    ]);
    // Schema and database have diverged; treating this as "nothing to check"
    // would let a renamed table silently drop out of coverage.
    expect(result.problems).toEqual([{ kind: "missing-table", table: "agents" }]);
  });

  it("surfaces a role that bypasses RLS entirely", async () => {
    const result = await verifyTenantIsolationPolicies(
      fakeSql(
        [
          {
            table_name: "agents",
            relrowsecurity: true,
            relforcerowsecurity: true,
            policy_name: "tenant_isolation",
            qual: "app.current_company_id",
            with_check: "app.current_company_id",
          },
        ],
        { role: "postgres", superuser: true, bypass_rls: false },
      ),
      [{ table: "agents", column: "company_id", nullableScope: false }],
    );
    // No table-level setting overrides a superuser, so every policy above is
    // decorative. Reported via `role` rather than `problems` because it is
    // not a schema defect -- it is a deployment one.
    expect(result.problems).toEqual([]);
    expect(result.role.superuser).toBe(true);
  });

  it("formats problems into an actionable message", () => {
    expect(
      formatRlsProblems([
        { kind: "rls-disabled", table: "issues" },
        { kind: "missing-policy", table: "agents" },
      ]),
    ).toBe(
      'issues: ROW LEVEL SECURITY is not enabled; agents: policy "tenant_isolation" does not exist',
    );
  });
});

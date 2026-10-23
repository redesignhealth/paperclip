import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, companies, createDb, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  COMPANY_VISIBILITY_CONFIRMATION,
  CompanyVisibilityConfirmationError,
  backfillCompanyVisibility,
  type CompanyVisibilityValue,
} from "../services/company-visibility-backfill.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company visibility backfill", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("company-visibility-backfill");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(visibility: CompanyVisibilityValue | null, status = "active") {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Company-${id.slice(0, 8)}`,
      issuePrefix: `V${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status,
      visibility,
    });
    return id;
  }
  const visibilityOf = async (id: string) => (await db.select().from(companies).where(eq(companies.id, id)))[0]!.visibility;
  const real = (companyId: string, visibility: CompanyVisibilityValue, extra: Record<string, unknown> = {}) =>
    backfillCompanyVisibility(db, { companyId, visibility, dryRun: false, confirm: COMPANY_VISIBILITY_CONFIRMATION, ...extra });
  const events = async (companyId: string) =>
    (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).filter((row) => row.action === "company.visibility_backfilled");

  it("defaults to a read-only census", async () => {
    const id = await seedCompany(null);
    const report = await backfillCompanyVisibility(db, { companyId: id, visibility: "shared" });
    expect(report).toMatchObject({ dryRun: true, result: "would_set", before: null, after: "shared" });
    expect(await visibilityOf(id)).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it("sets NULL to shared and to private (write-once), recording the change", async () => {
    const a = await seedCompany(null);
    const b = await seedCompany(null);
    expect(await real(a, "shared")).toMatchObject({ result: "set", before: null, after: "shared" });
    expect(await real(b, "private")).toMatchObject({ result: "set", before: null, after: "private" });
    expect(await visibilityOf(a)).toBe("shared");
    expect(await visibilityOf(b)).toBe("private");
    const [event] = await events(a);
    expect(event!.details).toEqual({ from: null, to: "shared" });
  });

  it("requires the exact confirmation for a real run", async () => {
    const id = await seedCompany(null);
    await expect(backfillCompanyVisibility(db, { companyId: id, visibility: "shared", dryRun: false })).rejects.toBeInstanceOf(CompanyVisibilityConfirmationError);
    await expect(backfillCompanyVisibility(db, { companyId: id, visibility: "shared", dryRun: false, confirm: "yes" })).rejects.toBeInstanceOf(CompanyVisibilityConfirmationError);
    expect(await visibilityOf(id)).toBeNull();
  });

  it("is idempotent: the same value again is already_current and writes nothing", async () => {
    const id = await seedCompany(null);
    await real(id, "shared");
    expect(await real(id, "shared")).toMatchObject({ result: "already_current", before: "shared", after: "shared" });
    expect(await events(id)).toHaveLength(1);
  });

  it("never moves private to shared", async () => {
    const id = await seedCompany("private");
    expect(await real(id, "shared", { allowNarrowing: true })).toMatchObject({ result: "refused_private_to_shared", before: "private", after: "private" });
    expect(await visibilityOf(id)).toBe("private");
  });

  it("moves shared to private only with allowNarrowing", async () => {
    const id = await seedCompany("shared");
    expect(await real(id, "private")).toMatchObject({ result: "refused_narrowing_requires_flag", before: "shared", after: "shared" });
    expect(await visibilityOf(id)).toBe("shared");
    expect(await backfillCompanyVisibility(db, { companyId: id, visibility: "private", allowNarrowing: true })).toMatchObject({ dryRun: true, result: "would_narrow" });
    expect(await visibilityOf(id)).toBe("shared");
    expect(await real(id, "private", { allowNarrowing: true })).toMatchObject({ result: "narrowed", before: "shared", after: "private" });
    expect(await visibilityOf(id)).toBe("private");
    expect((await events(id))[0]!.details).toEqual({ from: "shared", to: "private" });
  });

  it("refuses an archived company and reports a missing one", async () => {
    const archived = await seedCompany(null, "archived");
    expect(await real(archived, "shared")).toMatchObject({ result: "refused_company_archived" });
    expect(await visibilityOf(archived)).toBeNull();
    expect(await real(randomUUID(), "shared")).toMatchObject({ result: "company_not_found", before: null, after: null });
  });

  it("changes only the named company", async () => {
    const target = await seedCompany(null);
    const other = await seedCompany(null);
    await real(target, "shared");
    expect(await visibilityOf(other)).toBeNull();
  });
});

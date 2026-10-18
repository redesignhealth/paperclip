/**
 * Operator-triggered classification of a company whose `visibility` was never set (or, explicitly, narrowed).
 *
 * `companies.visibility` is chosen at creation and is immutable afterwards (TECH-7390): the update route rejects it.
 * Companies created before the column existed carry NULL, which comms-board registration treats as private. This is
 * the single supported way to classify such a company after the fact, without weakening the immutability rule:
 *  - NULL -> the requested value (write-once);
 *  - already the requested value -> `already_current`, nothing written;
 *  - `shared` -> `private` only when the caller passes `allowNarrowing: true`;
 *  - `private` -> `shared` is never done (a private company's registrations and invite gating were made on that basis).
 * Visibility also gates human invitations and member additions (a private company accepts none), so narrowing is an
 * explicit act, never a default.
 *
 * The write is a single guarded UPDATE (the guard repeats the precondition that was checked), so two concurrent runs
 * cannot both succeed against the same starting value, and it commits in one transaction with its audit event. The report carries the company id and the before/after value only.
 */
import { and, eq, isNull } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

export const COMPANY_VISIBILITY_CONFIRMATION = "set-company-visibility";

export type CompanyVisibilityValue = "private" | "shared";

export type CompanyVisibilityResult =
  | "would_set"
  | "set"
  | "would_narrow"
  | "narrowed"
  | "already_current"
  | "refused_narrowing_requires_flag"
  | "refused_private_to_shared"
  | "refused_company_archived"
  | "company_not_found"
  | "changed_concurrently";

export interface CompanyVisibilityReport {
  dryRun: boolean;
  companyId: string;
  requested: CompanyVisibilityValue;
  before: CompanyVisibilityValue | null;
  after: CompanyVisibilityValue | null;
  result: CompanyVisibilityResult;
}

export class CompanyVisibilityConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export interface CompanyVisibilityOptions {
  companyId: string;
  visibility: CompanyVisibilityValue;
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `COMPANY_VISIBILITY_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  /** Required to move `shared` -> `private`. Never allows `private` -> `shared`. */
  allowNarrowing?: boolean;
  actor?: { actorType: "user" | "system"; actorId: string };
}

export async function backfillCompanyVisibility(db: Db, options: CompanyVisibilityOptions): Promise<CompanyVisibilityReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMPANY_VISIBILITY_CONFIRMATION) throw new CompanyVisibilityConfirmationError();
  const requested = options.visibility;

  const [row] = await db
    .select({ id: companies.id, status: companies.status, visibility: companies.visibility })
    .from(companies)
    .where(eq(companies.id, options.companyId))
    .limit(1);
  const report = (result: CompanyVisibilityResult, before: CompanyVisibilityValue | null, after: CompanyVisibilityValue | null): CompanyVisibilityReport => ({
    dryRun,
    companyId: options.companyId,
    requested,
    before,
    after,
    result,
  });
  if (!row) return report("company_not_found", null, null);
  const before = (row.visibility ?? null) as CompanyVisibilityValue | null;
  if (row.status === "archived") return report("refused_company_archived", before, before);
  if (before === requested) return report("already_current", before, before);

  if (before === null) {
    if (dryRun) return report("would_set", before, requested);
    // The write and its audit event commit together: a failed event rolls the change back, so a retry can still record it.
    const changed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(companies)
        .set({ visibility: requested, updatedAt: new Date() })
        .where(and(eq(companies.id, row.id), isNull(companies.visibility)))
        .returning({ id: companies.id });
      if (updated.length !== 1) return false;
      await record(tx as unknown as Db, options, null, requested);
      return true;
    });
    return changed ? report("set", before, requested) : report("changed_concurrently", before, before);
  }

  // The stored value is the opposite of the requested one.
  if (before === "private") return report("refused_private_to_shared", before, before);
  if (options.allowNarrowing !== true) return report("refused_narrowing_requires_flag", before, before);
  if (dryRun) return report("would_narrow", before, requested);
  const changed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(companies)
      .set({ visibility: requested, updatedAt: new Date() })
      .where(and(eq(companies.id, row.id), eq(companies.visibility, "shared")))
      .returning({ id: companies.id });
    if (updated.length !== 1) return false;
    await record(tx as unknown as Db, options, "shared", requested);
    return true;
  });
  return changed ? report("narrowed", before, requested) : report("changed_concurrently", before, before);
}

async function record(db: Db, options: CompanyVisibilityOptions, from: CompanyVisibilityValue | null, to: CompanyVisibilityValue) {
  await logActivity(db, {
    companyId: options.companyId,
    actorType: options.actor?.actorType ?? "system",
    actorId: options.actor?.actorId ?? "company-visibility-backfill",
    action: "company.visibility_backfilled",
    entityType: "company",
    entityId: options.companyId,
    details: { from, to },
  });
}

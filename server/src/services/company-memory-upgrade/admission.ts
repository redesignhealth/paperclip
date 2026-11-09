/**
 * Admission control for company memory upgrades and company deletion.
 *
 * Concurrency & Locking Protocol:
 * - Transaction-scoped advisory lock establishes global serialization order between
 *   memory work admission (openUpgrade / tenant mutations) and company deletion:
 *   pg_advisory_xact_lock(hashtextextended(key, 0)).
 * - Row locking on `companies` uses FOR NO KEY UPDATE:
 *   - Self-conflicting: two transactions attempting FOR NO KEY UPDATE on the same company row
 *     block each other, preventing concurrent admission races.
 *   - NOT FOR UPDATE: FOR UPDATE conflicts with KEY SHARE, which deadlocks with concurrent child
 *     writers (e.g. native accounting writers holding child rows while saving company-scoped results).
 *   - NOT FOR KEY SHARE: KEY SHARE does not conflict with itself and would allow concurrent admission.
 * - Advisory lock MUST ALWAYS be acquired as the first statement of each participating transaction
 *   to maintain a strict global lock hierarchy and prevent deadlocks.
 */

import {
  companies,
  companyMemoryUpgrades,
  TERMINAL_UPGRADE_STATES,
  type Db,
} from "@paperclipai/db";
import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  CompanyMemoryUpgradeError,
  type CompanyMemoryUpgradeRow,
} from "./types.js";

export type CompanyMemoryUpgradeTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function companyMemoryAdmissionLockKey(companyId: string): string {
  return `paperclip:company-memory-admission:${companyId}`;
}

/**
 * Acquires the transaction-scoped advisory lock for the company.
 * MUST be the first statement of each participating transaction.
 */
export async function acquireCompanyMemoryAdmissionLock(
  tx: CompanyMemoryUpgradeTransaction,
  companyId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${companyMemoryAdmissionLockKey(companyId)}, 0))`,
  );
}

/**
 * Locks the company row FOR NO KEY UPDATE to test deletion intent under row-level mutual exclusion.
 * Returns null if the company does not exist.
 */
export async function lockCompanyForMemoryAdmission(
  tx: CompanyMemoryUpgradeTransaction,
  companyId: string,
): Promise<{ id: string; deletionStartedAt: Date | null } | null> {
  const [company] = await tx
    .select({
      id: companies.id,
      deletionStartedAt: companies.deletionStartedAt,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("no key update");

  return company ?? null;
}

/**
 * Finds any active (non-terminal) memory upgrade for the company FOR NO KEY UPDATE.
 * Returns null if no active upgrade exists.
 */
export async function findActiveUpgrade(
  tx: CompanyMemoryUpgradeTransaction,
  companyId: string,
): Promise<CompanyMemoryUpgradeRow | null> {
  const [active] = await tx
    .select()
    .from(companyMemoryUpgrades)
    .where(
      and(
        eq(companyMemoryUpgrades.companyId, companyId),
        notInArray(companyMemoryUpgrades.state, Array.from(TERMINAL_UPGRADE_STATES)),
      ),
    )
    .for("no key update");

  return active ?? null;
}

/**
 * Asserts that the company exists and is not undergoing deletion.
 * Acquires the advisory lock first, then locks the company row FOR NO KEY UPDATE.
 * Throws CompanyMemoryUpgradeError COMPANY_NOT_FOUND or COMPANY_DELETION_IN_PROGRESS.
 */
export async function assertCompanyAcceptsMemoryWork(
  tx: CompanyMemoryUpgradeTransaction,
  companyId: string,
): Promise<{ id: string; deletionStartedAt: Date | null }> {
  await acquireCompanyMemoryAdmissionLock(tx, companyId);
  const company = await lockCompanyForMemoryAdmission(tx, companyId);
  if (!company) {
    throw new CompanyMemoryUpgradeError(
      "Target company record does not exist in control plane database.",
      "COMPANY_NOT_FOUND",
    );
  }
  if (company.deletionStartedAt !== null) {
    throw new CompanyMemoryUpgradeError(
      "Target company is undergoing deletion.",
      "COMPANY_DELETION_IN_PROGRESS",
    );
  }
  return company;
}

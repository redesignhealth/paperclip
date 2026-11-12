/**
 * Scope migration marker read, write, and clear operations (TECH-8191 §Q1, §Q2, PR5.6).
 */

import { companyMemoryDatabases, companyMemoryUpgrades, type Db } from "@paperclipai/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isValidUuid } from "./census.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface SetScopeMigrationMarkerParams {
  companyId: string;
  mode: string;
  now?: Date;
}

export interface SetScopeMigrationMarkerFencedParams {
  upgradeId: string;
  leaseToken: string;
  companyId: string;
  mode: string;
  now?: Date;
}

export interface SetScopeMigrationMarkerResult {
  completedAt: Date;
  alreadySet: boolean;
}

export interface ScopeMigrationMarker {
  completedAt: Date | null;
  mode: string | null;
  agentScopeObservedAt: Date | null;
}

export interface ClearedScopeMigrationMarker {
  companyId: string;
  completedAt: Date | null;
  mode: string | null;
  agentScopeObservedAt: Date | null;
}

export async function setScopeMigrationMarkerFenced(
  cpDb: Db,
  params: SetScopeMigrationMarkerFencedParams,
): Promise<SetScopeMigrationMarkerResult> {
  const { upgradeId, leaseToken, companyId, mode } = params;
  if (!isValidUuid(companyId)) {
    throw new CompanyMemoryUpgradeError(`Invalid company ID: "${companyId}"`, "INVALID_ARGUMENT");
  }
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError(`Invalid upgrade ID: "${upgradeId}"`, "INVALID_ARGUMENT");
  }

  return await cpDb.transaction(async (tx) => {
    // 1. Lock the upgrade row with FOR UPDATE
    const [upgradeRow] = await tx
      .select({
        id: companyMemoryUpgrades.id,
        companyId: companyMemoryUpgrades.companyId,
        state: companyMemoryUpgrades.state,
        leaseToken: companyMemoryUpgrades.leaseToken,
        leaseExpiresAt: companyMemoryUpgrades.leaseExpiresAt,
      })
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgradeId))
      .for("update");

    // 2. Authoritative CP database clock sampled AFTER acquiring FOR UPDATE
    const [clockRow] = (await tx.execute(
      sql`SELECT clock_timestamp() AS db_now`,
    )) as unknown as Array<{ db_now: string | Date }>;
    const dbNow = clockRow?.db_now instanceof Date ? clockRow.db_now : new Date(clockRow?.db_now);

    // 3. Require matching companyId, token, flipping state, and non-expired lease by DB clock
    if (
      !upgradeRow ||
      upgradeRow.companyId !== companyId ||
      upgradeRow.leaseToken !== leaseToken ||
      upgradeRow.state !== "flipping" ||
      !upgradeRow.leaseExpiresAt ||
      upgradeRow.leaseExpiresAt.getTime() <= dbNow.getTime()
    ) {
      throw new CompanyMemoryUpgradeError(
        "Upgrade lease lost, expired, or state not flipping during marker write",
        "LEASE_FENCED_OUT",
      );
    }

    const markerTime = params.now ?? dbNow;

    // 4. Update company_memory_databases row
    const [updated] = await tx
      .update(companyMemoryDatabases)
      .set({ scopeMigrationCompletedAt: markerTime, scopeMigrationMode: mode, updatedAt: markerTime })
      .where(and(eq(companyMemoryDatabases.companyId, companyId), isNull(companyMemoryDatabases.scopeMigrationCompletedAt)))
      .returning({ completedAt: companyMemoryDatabases.scopeMigrationCompletedAt });

    if (updated?.completedAt) {
      return { completedAt: updated.completedAt, alreadySet: false };
    }

    const [existing] = await tx
      .select({ completedAt: companyMemoryDatabases.scopeMigrationCompletedAt, mode: companyMemoryDatabases.scopeMigrationMode })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyId));

    if (!existing?.completedAt) {
      throw new CompanyMemoryUpgradeError(`Failed to write scope migration marker for company ${companyId}`, "FLIP_MARKER_WRITE_FAILED");
    }

    if (!existing.mode || existing.mode !== mode) {
      throw new CompanyMemoryUpgradeError(
        `Existing scope migration marker mode mismatch: expected '${mode}', found '${existing.mode}'`,
        "FLIP_PRECONDITION_FAILED",
      );
    }

    return { completedAt: existing.completedAt, alreadySet: true };
  });
}

export async function setScopeMigrationMarker(
  cpDb: Db,
  params: SetScopeMigrationMarkerParams,
): Promise<SetScopeMigrationMarkerResult> {
  const { companyId, mode, now = new Date() } = params;
  if (!isValidUuid(companyId)) {
    throw new CompanyMemoryUpgradeError(`Invalid company ID: "${companyId}"`, "INVALID_ARGUMENT");
  }

  const [updated] = await cpDb
    .update(companyMemoryDatabases)
    .set({ scopeMigrationCompletedAt: now, scopeMigrationMode: mode, updatedAt: now })
    .where(and(eq(companyMemoryDatabases.companyId, companyId), isNull(companyMemoryDatabases.scopeMigrationCompletedAt)))
    .returning({ completedAt: companyMemoryDatabases.scopeMigrationCompletedAt });

  if (updated?.completedAt) {
    return { completedAt: updated.completedAt, alreadySet: false };
  }

  const [existing] = await cpDb
    .select({ completedAt: companyMemoryDatabases.scopeMigrationCompletedAt, mode: companyMemoryDatabases.scopeMigrationMode })
    .from(companyMemoryDatabases)
    .where(eq(companyMemoryDatabases.companyId, companyId));

  if (!existing?.completedAt) {
    throw new CompanyMemoryUpgradeError(`Failed to write scope migration marker for company ${companyId}`, "FLIP_MARKER_WRITE_FAILED");
  }

  if (!existing.mode || existing.mode !== mode) {
    throw new CompanyMemoryUpgradeError(
      `Existing scope migration marker mode mismatch: expected '${mode}', found '${existing.mode}'`,
      "FLIP_PRECONDITION_FAILED",
    );
  }

  return { completedAt: existing.completedAt, alreadySet: true };
}

export async function readScopeMigrationMarker(
  cpDb: Db,
  companyId: string,
): Promise<ScopeMigrationMarker | null> {
  if (!isValidUuid(companyId)) {
    throw new CompanyMemoryUpgradeError(`Invalid company ID: "${companyId}"`, "INVALID_ARGUMENT");
  }

  const [row] = await cpDb
    .select({
      completedAt: companyMemoryDatabases.scopeMigrationCompletedAt,
      mode: companyMemoryDatabases.scopeMigrationMode,
      agentScopeObservedAt: companyMemoryDatabases.scopeMigrationAgentScopeObservedAt,
    })
    .from(companyMemoryDatabases)
    .where(eq(companyMemoryDatabases.companyId, companyId));

  if (!row) return null;
  return {
    completedAt: row.completedAt ?? null,
    mode: row.mode ?? null,
    agentScopeObservedAt: row.agentScopeObservedAt ?? null,
  };
}

export async function clearScopeMigrationMarker(
  cpDb: Db,
  companyId: string,
): Promise<ClearedScopeMigrationMarker | null> {
  if (!isValidUuid(companyId)) {
    throw new CompanyMemoryUpgradeError(`Invalid company ID: "${companyId}"`, "INVALID_ARGUMENT");
  }

  const result = (await cpDb.execute(sql`
    WITH prior AS (
      SELECT company_id, scope_migration_completed_at, scope_migration_mode,
             scope_migration_agent_scope_observed_at
      FROM company_memory_databases WHERE company_id = ${companyId}::uuid
    ), cleared AS (
      UPDATE company_memory_databases
      SET scope_migration_completed_at = NULL, scope_migration_mode = NULL, updated_at = now()
      WHERE company_id = ${companyId}::uuid
      RETURNING company_id
    )
    SELECT * FROM prior;
  `)) as unknown as Array<{
    company_id: string;
    scope_migration_completed_at: Date | string | null;
    scope_migration_mode: string | null;
    scope_migration_agent_scope_observed_at: Date | string | null;
  }>;

  const first = result[0];
  if (!first) return null;
  return {
    companyId: first.company_id,
    completedAt: first.scope_migration_completed_at ? new Date(first.scope_migration_completed_at) : null,
    mode: first.scope_migration_mode ?? null,
    agentScopeObservedAt: first.scope_migration_agent_scope_observed_at ? new Date(first.scope_migration_agent_scope_observed_at) : null,
  };
}

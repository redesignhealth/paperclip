import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { companyMemoryDatabases, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export async function recordAgentScopedMemoryUse(
  db: Db,
  companyId: string,
  now?: Date,
): Promise<boolean> {
  try {
    const effectiveNow = now ?? new Date();
    const cutoff = new Date(effectiveNow.getTime() - 60 * 60 * 1000);
    const rows = await db
      .update(companyMemoryDatabases)
      .set({
        scopeMigrationAgentScopeObservedAt: effectiveNow,
      })
      .where(
        and(
          eq(companyMemoryDatabases.companyId, companyId),
          isNotNull(companyMemoryDatabases.scopeMigrationCompletedAt),
          or(
            isNull(companyMemoryDatabases.scopeMigrationAgentScopeObservedAt),
            lt(companyMemoryDatabases.scopeMigrationAgentScopeObservedAt, cutoff),
          ),
        ),
      )
      .returning({ id: companyMemoryDatabases.id });

    return rows.length > 0;
  } catch (err) {
    logger.warn({ err, companyId }, "failed to record agent-scoped memory observation");
    return false;
  }
}


import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { companyMemoryDatabases, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export async function recordAgentScopedMemoryUse(
  db: Db,
  companyId: string,
  now?: Date,
): Promise<boolean> {
  try {
    const effectiveNow = now ?? new Date();
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
            sql`${companyMemoryDatabases.scopeMigrationAgentScopeObservedAt} < ${effectiveNow} - interval '1 hour'`,
          ),
        ),
      )
      .returning({ id: companyMemoryDatabases.id });

    return rows.length > 0;
  } catch {
    logger.debug({ companyId }, "failed to record agent-scoped memory observation");
    return false;
  }
}

import { and, eq } from "drizzle-orm";
import { authUsers, companyMemberships, type Db } from "@paperclipai/db";

/**
 * Email of a default-MCP entry's frozen owner, or null when the owner is no longer an active member of THIS company
 * (or has no resolvable email). Checked on every setup attempt. Shared by the comms-board and agent-memory hooks so
 * both resolve the owner identically.
 */
export async function ownerEmailFor(db: Db, companyId: string, userId: string): Promise<string | null> {
  // The owner must be an active member of THIS company, checked on every attempt.
  const [membership] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .limit(1);
  if (!membership) return null;
  const [user] = await db.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId)).limit(1);
  return user?.email ?? null;
}

/**
 * Authoritative control-plane database clock helpers for company memory upgrade (TECH-8191).
 */

import { companyMemoryUpgrades, type Db } from "@paperclipai/db";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { Clock, CompanyMemoryUpgradeRow } from "./types.js";

export async function readCpNow(cpDb: Db): Promise<Date> {
  const rows = (await cpDb.execute(
    sql`SELECT clock_timestamp() AS db_now`,
  )) as unknown as Array<{ db_now: string | Date }>;
  const raw = rows[0]?.db_now;
  return raw instanceof Date ? raw : new Date(raw);
}

export interface UpgradeWithCpNow {
  row: CompanyMemoryUpgradeRow | null;
  dbNow: Date;
}

export async function readUpgradeWithCpNow(
  cpDb: Db,
  upgradeId: string,
): Promise<UpgradeWithCpNow> {
  const [selected] = await cpDb
    .select({
      ...getTableColumns(companyMemoryUpgrades),
      dbNow: sql<Date | string>`clock_timestamp()`,
    })
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgradeId));

  if (!selected) {
    const dbNow = await readCpNow(cpDb);
    return { row: null, dbNow };
  }

  const { dbNow: rawDbNow, ...row } = selected;
  const dbNow = rawDbNow instanceof Date ? rawDbNow : new Date(rawDbNow);
  return { row: row as CompanyMemoryUpgradeRow, dbNow };
}

export function frozenClock(at: Date): Clock {
  return { now: () => at };
}

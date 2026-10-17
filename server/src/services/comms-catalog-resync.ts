/**
 * Operator-triggered widening of EXISTING per-agent comms-board catalogs onto the current reviewed allowlist.
 *
 * A dedicated comms-board connection is a clone of the company template, and `cloneTemplateAccess` only ever narrows an
 * existing clone (rows are inserted `onConflictDoNothing`). Agents cloned while the reviewed allowlist was version 1
 * therefore keep `proposals_submit` / `proposals_get` DISABLED and outside their `app:<connectionId>` profile, even
 * after the template itself moved to version 2.
 *
 * Per eligible agent (ready, dedicated comms-board entry with a bound connection), a real run, in ONE transaction under
 * the same per-agent advisory lock the setup stage uses:
 *  1. resolves the managed template against the CURRENT reviewed allowlist (only a verified-usable template is used);
 *  2. runs `cloneTemplateAccess` with the allowlist, which inserts missing catalog rows and missing profile includes
 *     (and, as always, can only narrow anything outside the allowlist);
 *  3. for every allowlisted tool that is ACTIVE on the template and not active on the clone, sets the clone row active
 *     with `reviewedAt` (nothing outside the allowlist is ever touched).
 * It never creates an install, never grants access to another agent, and never changes credentials. Re-running changes
 * nothing for an agent that is already current.
 *
 * The report carries counts and agent ids only.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  agents,
  companies,
  toolCatalogEntries,
  toolConnections,
  toolProfileEntries,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { cloneTemplateAccess, commsWiringIntact, resolveTemplate } from "./default-mcp-setup.js";
import { DEFAULT_MCP_SPEC, readDefaultMcpState, type DefaultMcpEntryState } from "./default-mcp-spec.js";

export const COMMS_CATALOG_RESYNC_ENTRY_KEY = "comms-board";
export const COMMS_CATALOG_RESYNC_BATCH_LIMIT = 25;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_CATALOG_RESYNC_CONFIRMATION = "resync-comms-board-catalogs";

export type CommsCatalogResyncResult =
  | "would_widen"
  | "widened"
  | "already_current"
  | "skipped_terminated"
  | "skipped_company_archived"
  | "skipped_no_entry"
  | "skipped_not_ready"
  | "skipped_not_dedicated"
  | "skipped_wiring_invalid"
  | "skipped_template_unavailable"
  | "resync_error";

const RESULTS: readonly CommsCatalogResyncResult[] = [
  "would_widen", "widened", "already_current", "skipped_terminated", "skipped_company_archived", "skipped_no_entry",
  "skipped_not_ready", "skipped_not_dedicated", "skipped_wiring_invalid", "skipped_template_unavailable", "resync_error",
];

export interface CommsCatalogResyncOutcome {
  agentId: string;
  companyId: string;
  result: CommsCatalogResyncResult;
  /** Tool names that were (or, on a dry run, would be) made usable. Never anything outside the allowlist. */
  tools?: string[];
}

export interface CommsCatalogResyncReport {
  dryRun: boolean;
  scanned: number;
  outcomes: CommsCatalogResyncOutcome[];
  counts: Record<CommsCatalogResyncResult, number>;
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

export class CommsCatalogResyncConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export class CommsCatalogResyncInProgressError extends Error {
  constructor() {
    super("A catalog resync run is already in progress for this company");
  }
}

export interface CommsCatalogResyncOptions {
  companyId: string;
  limit?: number;
  afterId?: string;
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `COMMS_CATALOG_RESYNC_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
}

function emptyCounts(): CommsCatalogResyncReport["counts"] {
  return Object.fromEntries(RESULTS.map((r) => [r, 0])) as CommsCatalogResyncReport["counts"];
}

// One real run per company per process at a time; the per-agent advisory lock and the idempotent widening keep
// overlapping runs across instances harmless.
const runningCompanies = new Set<string>();

type Eligibility = { eligible: true; entry: DefaultMcpEntryState } | { eligible: false; result: CommsCatalogResyncResult };

function classify(metadata: unknown): Eligibility {
  const entry = readDefaultMcpState(metadata)?.entries[COMMS_CATALOG_RESYNC_ENTRY_KEY];
  if (!entry) return { eligible: false, result: "skipped_no_entry" };
  if (entry.setup.state !== "ready") return { eligible: false, result: "skipped_not_ready" };
  if (!entry.dedicated) return { eligible: false, result: "skipped_not_dedicated" };
  const binding = entry.binding;
  if (!binding?.secretId || !binding.connectionId || !binding.grantId || !entry.connectionId) {
    return { eligible: false, result: "skipped_not_ready" };
  }
  return { eligible: true, entry };
}

function commsSpec() {
  const spec = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === COMMS_CATALOG_RESYNC_ENTRY_KEY);
  if (!spec?.reviewedTools) throw new Error("comms-board spec has no reviewed allowlist");
  return spec;
}

/**
 * What a widening would do for this clone: allowlisted tools that are active on the template but not active (or
 * missing) on the clone, plus allowlisted active clone tools missing from the clone's profile. Read-only.
 */
async function plan(
  db: Pick<Db, "select">,
  companyId: string,
  templateId: string,
  dedicatedId: string,
  allow: ReadonlySet<string>,
): Promise<{ tools: string[]; profileGaps: number }> {
  const allowList = [...allow];
  const [templateRows, dedicatedRows] = await Promise.all([
    db
      .select()
      .from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.connectionId, templateId), inArray(toolCatalogEntries.toolName, allowList))),
    db
      .select()
      .from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.connectionId, dedicatedId), inArray(toolCatalogEntries.toolName, allowList))),
  ]);
  const dedicatedByName = new Map(dedicatedRows.filter((row) => row.entryKind === "tool").map((row) => [row.name, row]));
  const tools: string[] = [];
  for (const row of templateRows) {
    if (row.entryKind !== "tool" || row.status !== "active") continue;
    const clone = dedicatedByName.get(row.name);
    if (!clone || clone.status !== "active") tools.push(row.toolName);
  }

  const [profile] = await db
    .select()
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${dedicatedId}`)))
    .limit(1);
  const included = new Set<string | null>();
  if (profile) {
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    for (const entry of entries) {
      if (entry.selectorType === "catalog_entry" && entry.effect === "include") included.add(entry.catalogEntryId);
    }
  }
  let profileGaps = 0;
  for (const row of templateRows) {
    if (row.entryKind !== "tool" || row.status !== "active") continue;
    const clone = dedicatedByName.get(row.name);
    if (clone && clone.status === "active" && !included.has(clone.id)) profileGaps += 1;
  }
  tools.sort();
  return { tools, profileGaps: profile ? profileGaps : profileGaps + (templateRows.some((row) => row.status === "active") ? 1 : 0) };
}

export async function resyncCommsCatalogs(db: Db, options: CommsCatalogResyncOptions): Promise<CommsCatalogResyncReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMMS_CATALOG_RESYNC_CONFIRMATION) throw new CommsCatalogResyncConfirmationError();
  if (!dryRun) {
    if (runningCompanies.has(options.companyId)) throw new CommsCatalogResyncInProgressError();
    runningCompanies.add(options.companyId);
  }
  try {
    return await scan(db, options, dryRun);
  } finally {
    if (!dryRun) runningCompanies.delete(options.companyId);
  }
}

async function scan(db: Db, options: CommsCatalogResyncOptions, dryRun: boolean): Promise<CommsCatalogResyncReport> {
  const limit = Math.max(1, Math.min(options.limit ?? COMMS_CATALOG_RESYNC_BATCH_LIMIT, COMMS_CATALOG_RESYNC_BATCH_LIMIT));
  const rows = await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata, status: agents.status, companyStatus: companies.status })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(agents.companyId, options.companyId), options.afterId ? gt(agents.id, options.afterId) : undefined))
    .orderBy(asc(agents.id))
    .limit(limit);

  const outcomes: CommsCatalogResyncOutcome[] = [];
  const push = (row: { id: string; companyId: string }, result: CommsCatalogResyncResult, tools?: string[]) =>
    outcomes.push({ agentId: row.id, companyId: row.companyId, result, ...(tools && tools.length > 0 ? { tools } : {}) });

  for (const row of rows) {
    if (row.status === "terminated") { push(row, "skipped_terminated"); continue; }
    if (row.companyStatus === "archived") { push(row, "skipped_company_archived"); continue; }
    const eligibility = classify(row.metadata);
    if (!eligibility.eligible) { push(row, eligibility.result); continue; }
    try {
      const outcome = await resyncOne(db, row, eligibility.entry, dryRun);
      push(row, outcome.result, outcome.tools);
    } catch (err) {
      // Only the error class is logged: never a message, URL, header, token or body.
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "comms catalog resync item failed");
      push(row, "resync_error");
    }
  }

  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return { dryRun, scanned: rows.length, outcomes, counts, nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

async function resyncOne(
  db: Db,
  row: { id: string; companyId: string },
  entry: DefaultMcpEntryState,
  dryRun: boolean,
): Promise<{ result: CommsCatalogResyncResult; tools?: string[] }> {
  if (!(await commsWiringIntact(db, row.companyId, row.id, entry))) return { result: "skipped_wiring_invalid" };
  const spec = commsSpec();
  const reviewed = spec.reviewedTools!;
  const allow = new Set(reviewed.allow);
  const templateName = entry.templateKey || spec.connectionName; // the FROZEN key, never today's spec
  const dedicatedId = entry.binding!.connectionId!;

  if (dryRun) {
    const resolved = await resolveTemplate(db, row.companyId, templateName, reviewed);
    if ("reason" in resolved) return { result: "skipped_template_unavailable" };
    const [dedicated] = await db
      .select({ id: toolConnections.id, status: toolConnections.status, credentialPolicy: toolConnections.credentialPolicy })
      .from(toolConnections)
      .where(and(eq(toolConnections.id, dedicatedId), eq(toolConnections.companyId, row.companyId)))
      .limit(1);
    if (!dedicated || dedicated.status === "archived" || dedicated.credentialPolicy !== "per_agent") return { result: "skipped_wiring_invalid" };
    const wanted = await plan(db, row.companyId, resolved.template.id, dedicated.id, allow);
    return wanted.tools.length > 0 || wanted.profileGaps > 0 ? { result: "would_widen", tools: wanted.tools } : { result: "already_current" };
  }

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Same per-agent lock the setup stage takes, so a resync never interleaves with a setup retry for this agent.
    await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:default-mcp:dedicated:" + row.id}, 0))`);
    const resolved = await resolveTemplate(txDb, row.companyId, templateName, reviewed);
    if ("reason" in resolved) return { result: "skipped_template_unavailable" } as const;
    const template = resolved.template;
    const [dedicated] = await txDb
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.id, dedicatedId), eq(toolConnections.companyId, row.companyId)))
      .limit(1)
      .for("update");
    if (!dedicated || dedicated.status === "archived" || dedicated.credentialPolicy !== "per_agent") {
      return { result: "skipped_wiring_invalid" } as const;
    }
    const wanted = await plan(txDb, row.companyId, template.id, dedicated.id, allow);
    if (wanted.tools.length === 0 && wanted.profileGaps === 0) return { result: "already_current" } as const;

    const now = new Date();
    // Insert any missing clone rows and profile includes first (statuses copied from the template, outside-allowlist
    // rows disabled; includes do not depend on the clone row's status), then widen only allowlisted rows whose
    // template row is active.
    await cloneTemplateAccess(txDb, template, dedicated, row.id, allow);
    const templateActive = await txDb
      .select({ name: toolCatalogEntries.name })
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.companyId, row.companyId),
          eq(toolCatalogEntries.connectionId, template.id),
          eq(toolCatalogEntries.entryKind, "tool"),
          eq(toolCatalogEntries.status, "active"),
          inArray(toolCatalogEntries.toolName, [...allow]),
        ),
      );
    if (templateActive.length > 0) {
      await txDb
        .update(toolCatalogEntries)
        .set({ status: "active", reviewedAt: now, quarantinedAt: null, quarantineReason: null, updatedAt: now })
        .where(
          and(
            eq(toolCatalogEntries.companyId, row.companyId),
            eq(toolCatalogEntries.connectionId, dedicated.id),
            eq(toolCatalogEntries.entryKind, "tool"),
            inArray(toolCatalogEntries.name, templateActive.map((r) => r.name)),
            inArray(toolCatalogEntries.toolName, [...allow]),
            sql`${toolCatalogEntries.status} <> 'active'`,
          ),
        );
    }
    await logActivity(txDb, {
      companyId: row.companyId,
      actorType: "system",
      actorId: "comms-catalog-resync",
      action: "agent.default_mcp.comms_catalog_resynced",
      entityType: "agent",
      entityId: row.id,
      // Non-secret facts only.
      details: { key: COMMS_CATALOG_RESYNC_ENTRY_KEY, connectionId: dedicated.id, tools: wanted.tools, allowlistVersion: reviewed.version },
    });
    return { result: "widened", tools: wanted.tools } as const;
  });
}

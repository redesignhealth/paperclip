/**
 * One-time, re-runnable backfill of EMPTY private Arcana brains for agents that already exist (TECH-7326).
 *
 * New agents get their brain through the default-MCP `arcana-brain` entry (`arcanaBrainHook`,
 * default-mcp-setup.ts). This job gives an existing agent that same entry and runs THE SAME hook
 * through THE SAME claim/checkpoint runner, so there is no second provisioning path: the same vault
 * key, the same hash-only Arcana provision call, the same dedicated connection and grant. Nothing is
 * ever loaded into a brain: provisioning creates it empty and this job writes no memories, sources or
 * documents.
 *
 * What it changes, per agent, and nothing else:
 *  - adds ONLY the `arcana-brain` entry under `agents.metadata.defaultMcp` (a path-scoped `jsonb_set`;
 *    existing entries, owners and every other MCP setting are untouched, and an agent that had no
 *    `defaultMcp` state gets a state holding just this entry, which leaves its legacy access as is);
 *  - runs only the arcana hook (`spec: [arcana]`), never the comms-board hook;
 *  - when that finishes `ready`, installs the agent's OWN dedicated connection for that agent only
 *    (the deliberate, logged exception to TECH-7204's "defaults never silently enable existing agents").
 *
 * Stuck on an archived connection (`recreate_archived`): an entry that is pending/error/ready whose stored connection id resolves to
 * an ARCHIVED connection carrying this agent's OWN dedicated name is detached (entry `connectionId` and binding
 * `connectionId`/`grantId` cleared, vault secret kept, setup reset to pending with a fresh budget, enable marker set) so
 * the normal setup clones a fresh connection by name. Any other archived connection stays terminal, as before.
 *
 * Idempotent: an entry that is already ready, or whose setup is in progress, is skipped; a second run
 * provisions nothing and creates no second key, brain, connection, grant or install. A failed entry is
 * reset to pending and re-run (the stored vault key and Arcana's idempotent provision route make the
 * retry safe: same hash, no orphan key). A failure is isolated to its agent and reported with a reason.
 *
 * Gated like everything else in the default-MCP spec: the framework flag, the Arcana provisioner
 * configuration and the frozen company rollout scope. A real run needs `dryRun: false` AND the explicit
 * confirmation string; the default is a read-only census.
 */
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { agents, companies, toolConnections, toolProfiles, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { isCompanyInDefaultMcpTemplateScope, readDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { logActivity } from "./activity-log.js";
import { resolveArcanaProvisionerConfig } from "./arcana-provisioner-client.js";
import type { FetchLike } from "./comms-board-provisioner-client.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  isDefaultMcpSpecEnabled,
  readDefaultMcpState,
  type DefaultMcpEntryState,
} from "./default-mcp-spec.js";
import {
  dedicatedConnectionName,
  runDefaultMcpSetupForAgent,
  snapshotDefaultMcpForNewAgent,
  type DefaultMcpSetupContext,
} from "./default-mcp-setup.js";
import { resolveLegacyResponsibleUser } from "./default-mcp-legacy-enrollment.js";
import { toolAccessService } from "./tool-access.js";

export const ARCANA_BACKFILL_ENTRY_KEY = "arcana-brain";
export const ARCANA_BACKFILL_BATCH_LIMIT = 25;
export const ARCANA_BACKFILL_DEFAULT_DELAY_MS = 250;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const ARCANA_BACKFILL_CONFIRMATION = "provision-empty-arcana-brains";

/** Stored on the entry this job added (or retried): `pending` until the agent's own install is made. */
type BackfillEnable = "pending" | "done";
type ArcanaEntryState = DefaultMcpEntryState & { backfillEnable?: BackfillEnable };

export type ArcanaBackfillBlockedReason =
  | "feature_flag_off"
  | "arcana_not_configured"
  | "arcana_config_invalid"
  | "no_arcana_entry_in_spec"
  | "backfill_in_progress";

export type ArcanaBackfillSkipReason =
  | "company_archived"
  | "company_out_of_scope"
  | "agent_terminated"
  | "agent_pending_approval"
  | "corrupted_existing_state"
  | "already_provisioned"
  | "setup_in_progress"
  | "operator_excluded"
  | "lost_race";

export type ArcanaBackfillPlan = "add_entry" | "retry_failed" | "enable_only" | "recreate_archived";

export type ArcanaBackfillOutcome =
  | { agentId: string; companyId: string; result: "would_provision"; plan: ArcanaBackfillPlan }
  | { agentId: string; companyId: string; result: "provisioned"; plan: ArcanaBackfillPlan }
  | { agentId: string; companyId: string; result: "pending"; plan: ArcanaBackfillPlan; reason: string }
  | { agentId: string; companyId: string; result: "failed"; plan: ArcanaBackfillPlan; reason: string }
  | { agentId: string; companyId: string; result: "skipped"; reason: ArcanaBackfillSkipReason };

export interface ArcanaBackfillReport {
  dryRun: boolean;
  /** Set when a gate is closed. A real run does nothing while blocked; a census still lists the agents. */
  blocked: ArcanaBackfillBlockedReason | null;
  /** Rows scanned in this batch (bounded by `limit`), not a total across pages. */
  scanned: number;
  outcomes: ArcanaBackfillOutcome[];
  counts: Record<ArcanaBackfillOutcome["result"], number>;
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

export class ArcanaBackfillConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export interface ArcanaBackfillOptions {
  companyId?: string;
  limit?: number;
  afterId?: string;
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `ARCANA_BACKFILL_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  /** Pause between agents that needed an external call (rate limit). Tests pass 0. */
  delayMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
  templateScope?: DefaultMcpSetupContext["templateScope"];
}

const ARCANA_ENTRY = DEFAULT_MCP_SPEC.find((entry) => entry.key === ARCANA_BACKFILL_ENTRY_KEY);

// One run per company per process at a time. Across instances the row lock, the claim and the idempotent
// Arcana provision route are what keep overlapping runs from duplicating anything.
const runningCompanies = new Set<string>();

function entryPath(...rest: string[]): SQL {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", ARCANA_BACKFILL_ENTRY_KEY, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

/** Same "absent / corrupted / present" split as the legacy enrollment (not exported there). */
function classifyMetadata(metadata: unknown): "absent" | "corrupted" | "present" {
  if (metadata !== null && metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) return "corrupted";
  if (!metadata || typeof metadata !== "object") return "absent";
  const raw = (metadata as Record<string, unknown>)[DEFAULT_MCP_METADATA_KEY];
  if (raw === undefined || raw === null) return "absent";
  return readDefaultMcpState(metadata) !== null ? "present" : "corrupted";
}

type Planned =
  | { kind: "skip"; reason: ArcanaBackfillSkipReason }
  | { kind: "act"; plan: ArcanaBackfillPlan };

/**
 * `archivedOwnConnection`: the entry's stored connection resolves to an ARCHIVED connection carrying this agent's own
 * dedicated name (see `hasArchivedOwnConnection`). Setup looks the connection up by that stored id and never clones a
 * fresh one, so such an entry (pending/`binding_failed`, `error`, or `ready` with a dead connection) can only be unstuck by `recreate_archived`.
 */
function planFor(metadata: unknown, archivedOwnConnection = false): Planned {
  const classification = classifyMetadata(metadata);
  if (classification === "corrupted") return { kind: "skip", reason: "corrupted_existing_state" };
  if (classification === "absent") return { kind: "act", plan: "add_entry" };
  const entry = readDefaultMcpState(metadata)?.entries[ARCANA_BACKFILL_ENTRY_KEY] as ArcanaEntryState | undefined;
  if (!entry) return { kind: "act", plan: "add_entry" };
  const state = entry.setup.state;
  if (state === "not_required" && entry.setup.reason === "operator_excluded") return { kind: "skip", reason: "operator_excluded" };
  if (state === "ready" && archivedOwnConnection) return { kind: "act", plan: "recreate_archived" };
  if (state === "ready") return entry.backfillEnable === "pending" ? { kind: "act", plan: "enable_only" } : { kind: "skip", reason: "already_provisioned" };
  if ((state === "error" || state === "pending") && archivedOwnConnection) return { kind: "act", plan: "recreate_archived" };
  if (state === "error") return { kind: "act", plan: "retry_failed" };
  return { kind: "skip", reason: "setup_in_progress" };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The entry exactly as the new-agent snapshot builds it, with nothing written: used only to avoid a second builder. */
async function buildEntryWithoutWriting(
  db: Pick<Db, "select" | "insert" | "update" | "execute">,
  input: { companyId: string; agentId: string; ownerUserId: string | null; status: string; now: Date },
): Promise<ArcanaEntryState> {
  const noWrite = { set: () => ({ where: async () => [] }) };
  const probe = {
    select: db.select.bind(db),
    insert: db.insert.bind(db),
    execute: db.execute.bind(db),
    update: () => noWrite,
  } as unknown as Pick<Db, "select" | "insert" | "update" | "execute">;
  const state = await snapshotDefaultMcpForNewAgent(probe, {
    companyId: input.companyId,
    agentId: input.agentId,
    ownerUserId: input.ownerUserId,
    status: input.status,
    spec: [ARCANA_ENTRY!],
    now: input.now,
  });
  return { ...state.entries[ARCANA_BACKFILL_ENTRY_KEY]!, backfillEnable: "pending" };
}

/** Adds ONLY this entry to the agent, under a row lock, never overwriting another entry. */
async function addEntry(
  db: Db,
  row: { id: string; companyId: string },
  ownerUserId: string | null,
  now: Date,
): Promise<"added" | ArcanaBackfillSkipReason> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: agents.metadata, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, row.id), eq(agents.companyId, row.companyId)))
      .limit(1)
      .for("update");
    if (!locked) return "lost_race" as const;
    if (locked.status === "terminated") return "agent_terminated" as const;
    if (locked.status === "pending_approval") return "agent_pending_approval" as const;
    const planned = planFor(locked.metadata);
    if (planned.kind === "skip") return planned.reason;
    if (planned.plan !== "add_entry") return "lost_race" as const;
    const entry = await buildEntryWithoutWriting(tx as unknown as Db, {
      companyId: row.companyId,
      agentId: row.id,
      ownerUserId,
      status: locked.status,
      now,
    });
    const hasState = classifyMetadata(locked.metadata) === "present";
    await tx
      .update(agents)
      .set({
        metadata: hasState
          ? sql`jsonb_set(${agents.metadata}, ${entryPath()}, ${JSON.stringify(entry)}::jsonb, true)`
          : sql`jsonb_set(coalesce(${agents.metadata}, '{}'::jsonb), ARRAY[${DEFAULT_MCP_METADATA_KEY}::text], ${JSON.stringify({ version: 1, entries: { [ARCANA_BACKFILL_ENTRY_KEY]: entry } })}::jsonb, true)`,
      })
      .where(eq(agents.id, row.id));
    return "added" as const;
  });
}

/** error -> pending (guarded on `error`), a fresh retry budget, and the enable marker: this job now owns the outcome. */
async function resetFailedEntry(db: Db, agentId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, ${entryPath("setup")}, (${agents.metadata} #> ${entryPath("setup")}) || ${JSON.stringify({ state: "pending", reason: null, attemptCount: 0, nextAttemptAt: null, leaseUntil: null, claimId: null, updatedAt: now.toISOString() })}::jsonb, false), ${entryPath("backfillEnable")}, '"pending"'::jsonb, true)`,
    })
    .where(and(eq(agents.id, agentId), sql`${agents.metadata} #>> ${entryPath("setup", "state")} = 'error'`))
    .returning({ id: agents.id });
  return rows.length === 1;
}

/**
 * True only for a dedicated entry with a stored vault secret whose stored connection id resolves, in this company, to an
 * ARCHIVED connection named exactly this agent's own dedicated name (`<templateKey>:<agentId>`). Any other connection (an
 * org template, another agent's, a live one, a missing row) is never matched, so general archived-template handling
 * ("revoked" stays terminal) is untouched.
 */
async function hasArchivedOwnConnection(db: Pick<Db, "select">, row: { id: string; companyId: string; metadata: unknown }): Promise<boolean> {
  const entry = readDefaultMcpState(row.metadata)?.entries[ARCANA_BACKFILL_ENTRY_KEY];
  if (!entry || !entry.dedicated || !entry.connectionId || !entry.binding?.secretId) return false;
  if (entry.setup.state !== "pending" && entry.setup.state !== "error" && entry.setup.state !== "ready") return false;
  const [connection] = await db
    .select({ name: toolConnections.name, status: toolConnections.status })
    .from(toolConnections)
    .where(and(eq(toolConnections.companyId, row.companyId), eq(toolConnections.id, entry.connectionId)))
    .limit(1);
  return Boolean(connection && connection.status === "archived" && connection.name === dedicatedConnectionName(entry.templateKey, row.id));
}

/**
 * Detaches the stale archived connection so the normal setup clones a fresh one by name: clears the entry's
 * `connectionId` and the binding's `connectionId`/`grantId` (the vault secret and everything else on the binding are
 * kept), resets setup to pending with a fresh retry budget and sets the enable marker. Guarded on the entry still being
 * pending/error and still pointing at exactly that connection.
 */
async function resetArchivedConnectionEntry(db: Db, companyId: string, agentId: string, previousConnectionId: string, now: Date): Promise<boolean> {
  const setupPatch = JSON.stringify({ state: "pending", reason: null, attemptCount: 0, nextAttemptAt: null, leaseUntil: null, claimId: null, updatedAt: now.toISOString() });
  const reset = await db.transaction(async (tx) => {
    const rows = await tx
      .update(agents)
      .set({
        metadata: sql`jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(${agents.metadata}, ${entryPath("connectionId")}, 'null'::jsonb, false), ${entryPath("binding", "connectionId")}, 'null'::jsonb, false), ${entryPath("binding", "grantId")}, 'null'::jsonb, false), ${entryPath("setup")}, (${agents.metadata} #> ${entryPath("setup")}) || ${setupPatch}::jsonb, false), ${entryPath("backfillEnable")}, '"pending"'::jsonb, true)`,
      })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.companyId, companyId),
          sql`${agents.metadata} #>> ${entryPath("connectionId")} = ${previousConnectionId}`,
          sql`${agents.metadata} #>> ${entryPath("setup", "state")} IN ('pending', 'error', 'ready')`,
        ),
      )
      .returning({ id: agents.id });
    if (rows.length !== 1) return false;
    // The archived connection's access profile carries the dedicated name, and profile names are unique per company, so
    // it would block the new connection's profile. Free the name by renaming (never deleting) that one stale profile.
    const [stale] = await tx
      .select({ id: toolProfiles.id, name: toolProfiles.name })
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${previousConnectionId}`)))
      .limit(1);
    if (stale) {
      await tx
        .update(toolProfiles)
        .set({ name: `${stale.name} (archived ${previousConnectionId.slice(0, 8)})`, updatedAt: now })
        .where(eq(toolProfiles.id, stale.id));
    }
    return true;
  });
  if (!reset) return false;
  await logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "arcana-brain-backfill",
    action: "agent.default_mcp.arcana_connection_recreate_requested",
    entityType: "agent",
    entityId: agentId,
    // Non-secret facts only.
    details: { key: ARCANA_BACKFILL_ENTRY_KEY, previousConnectionId },
  });
  return true;
}

async function readEntry(db: Db, agentId: string): Promise<ArcanaEntryState | undefined> {
  const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return readDefaultMcpState(row?.metadata)?.entries[ARCANA_BACKFILL_ENTRY_KEY] as ArcanaEntryState | undefined;
}

/** Installs the agent's OWN dedicated connection for that agent only, then records it (once). Local writes only. */
export async function enableForAgent(db: Db, companyId: string, agentId: string, entry: ArcanaEntryState): Promise<"enabled" | "already" | "failed"> {
  if (!entry.dedicated || !entry.connectionId || !entry.binding?.grantId) {
    logger.warn({ agentId, cause: "entry_not_bound" }, "arcana brain backfill enable skipped");
    return "failed";
  }
  const [connection] = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, entry.connectionId)))
    .limit(1);
  // The stored dedicated connection id is authoritative, but the name must still be this agent's own.
  if (!connection || connection.status === "archived" || connection.name !== dedicatedConnectionName(entry.templateKey, agentId)) {
    logger.warn({ agentId, cause: connection ? "connection_mismatch" : "connection_missing" }, "arcana brain backfill enable skipped");
    return "failed";
  }
  await toolAccessService(db).addAgentConnectionInstall(db, connection, agentId, undefined, {
    install: true,
    bindingSource: "default_mcp_spec",
  });
  const flipped = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, ${entryPath("enabled")}, 'true'::jsonb, false), ${entryPath("backfillEnable")}, '"done"'::jsonb, false)`,
    })
    .where(and(eq(agents.id, agentId), sql`${agents.metadata} #>> ${entryPath("backfillEnable")} = 'pending'`))
    .returning({ id: agents.id });
  // The install above is idempotent. Only the caller that flipped the marker records and reports the enable,
  // so a racing worker never writes a second audit event or claims a write it did not make.
  if (flipped.length === 0) return "already";
  await logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "arcana-brain-backfill",
    action: "agent.default_mcp.arcana_backfill_enabled",
    entityType: "agent",
    entityId: agentId,
    // Non-secret facts only.
    details: { key: ARCANA_BACKFILL_ENTRY_KEY, connectionId: connection.id },
  });
  return "enabled";
}

function emptyCounts(): ArcanaBackfillReport["counts"] {
  return { would_provision: 0, provisioned: 0, pending: 0, failed: 0, skipped: 0 };
}

function blockedReason(env: NodeJS.ProcessEnv): ArcanaBackfillBlockedReason | null {
  if (!ARCANA_ENTRY) return "no_arcana_entry_in_spec";
  if (!isDefaultMcpSpecEnabled(env)) return "feature_flag_off";
  const config = resolveArcanaProvisionerConfig(env);
  if (config.ok) return null;
  return config.reason === "provisioner_not_configured" ? "arcana_not_configured" : "arcana_config_invalid";
}

export async function backfillArcanaBrains(db: Db, options: ArcanaBackfillOptions = {}): Promise<ArcanaBackfillReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== ARCANA_BACKFILL_CONFIRMATION) throw new ArcanaBackfillConfirmationError();
  const env = options.env ?? process.env;
  const blocked = blockedReason(env);
  const empty = (reason: ArcanaBackfillBlockedReason | null): ArcanaBackfillReport => ({
    dryRun,
    blocked: reason,
    scanned: 0,
    outcomes: [],
    counts: emptyCounts(),
    nextCursor: null,
  });
  // A real run does nothing while any gate is closed; a census still lists what a real run would do.
  if (!dryRun && blocked) return empty(blocked);
  if (blocked === "no_arcana_entry_in_spec") return empty(blocked);

  const lockKey = options.companyId ?? "*";
  if (!dryRun) {
    if (runningCompanies.has("*") || runningCompanies.has(lockKey) || (lockKey === "*" && runningCompanies.size > 0)) return empty("backfill_in_progress");
    runningCompanies.add(lockKey);
  }
  try {
    return await scan(db, options, { dryRun, blocked, env });
  } finally {
    if (!dryRun) runningCompanies.delete(lockKey);
  }
}

async function scan(
  db: Db,
  options: ArcanaBackfillOptions,
  gate: { dryRun: boolean; blocked: ArcanaBackfillBlockedReason | null; env: NodeJS.ProcessEnv },
): Promise<ArcanaBackfillReport> {
  const limit = Math.max(1, Math.min(options.limit ?? ARCANA_BACKFILL_BATCH_LIMIT, ARCANA_BACKFILL_BATCH_LIMIT));
  const scope = options.templateScope ?? readDefaultMcpTemplateScope();
  const delayMs = options.delayMs ?? ARCANA_BACKFILL_DEFAULT_DELAY_MS;
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      metadata: agents.metadata,
      status: agents.status,
      companyStatus: companies.status,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(options.companyId ? eq(agents.companyId, options.companyId) : undefined, options.afterId ? gt(agents.id, options.afterId) : undefined))
    .orderBy(asc(agents.id))
    .limit(limit);

  const outcomes: ArcanaBackfillOutcome[] = [];
  const skip = (row: { id: string; companyId: string }, reason: ArcanaBackfillSkipReason) =>
    outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason });
  let calledOut = false;

  for (const row of rows) {
    if (row.status === "terminated") { skip(row, "agent_terminated"); continue; }
    if (row.companyStatus === "archived") { skip(row, "company_archived"); continue; }
    if (!isCompanyInDefaultMcpTemplateScope(scope, row.companyId)) { skip(row, "company_out_of_scope"); continue; }
    if (row.status === "pending_approval") { skip(row, "agent_pending_approval"); continue; }
    const planned = planFor(row.metadata, await hasArchivedOwnConnection(db, row));
    if (planned.kind === "skip") { skip(row, planned.reason); continue; }
    if (gate.dryRun) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "would_provision", plan: planned.plan });
      continue;
    }

    // Failures are isolated to this agent: nothing thrown here stops the batch.
    try {
      if (calledOut && delayMs > 0) await sleep(delayMs);
      const now = options.now?.() ?? new Date();
      const outcome = await provisionOne(db, row, planned.plan, { ...options, env: gate.env, at: now });
      calledOut = outcome.touchedArcana;
      outcomes.push(outcome.outcome);
    } catch (err) {
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "arcana brain backfill item failed");
      calledOut = true; // an unexpected error may have followed an Arcana call: keep the pacing conservative
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "failed", plan: planned.plan, reason: "backfill_error" });
    }
  }

  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return {
    dryRun: gate.dryRun,
    blocked: gate.blocked,
    scanned: rows.length,
    outcomes,
    counts,
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

async function provisionOne(
  db: Db,
  row: { id: string; companyId: string },
  plan: ArcanaBackfillPlan,
  options: ArcanaBackfillOptions & { env: NodeJS.ProcessEnv; at: Date },
): Promise<{ outcome: ArcanaBackfillOutcome; touchedArcana: boolean }> {
  const base = { agentId: row.id, companyId: row.companyId };
  const touchedArcana = plan !== "enable_only";
  if (plan === "add_entry") {
    const [existing] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, row.id)).limit(1);
    const owner = await ownerFor(db, row, existing?.metadata);
    const added = await addEntry(db, row, owner, options.at);
    if (added !== "added") return { outcome: { ...base, result: "skipped", reason: added }, touchedArcana: false };
  } else if (plan === "retry_failed") {
    if (!(await resetFailedEntry(db, row.id, options.at))) return { outcome: { ...base, result: "skipped", reason: "lost_race" }, touchedArcana: false };
  } else if (plan === "recreate_archived") {
    const [current] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, row.id)).limit(1);
    const stale = readDefaultMcpState(current?.metadata)?.entries[ARCANA_BACKFILL_ENTRY_KEY]?.connectionId;
    if (!stale || !(await resetArchivedConnectionEntry(db, row.companyId, row.id, stale, options.at))) {
      return { outcome: { ...base, result: "skipped", reason: "lost_race" }, touchedArcana: false };
    }
  }

  if (plan !== "enable_only") {
    // The same runner and hook that provision a new agent, restricted to this one entry.
    await runDefaultMcpSetupForAgent(
      { db, env: options.env, fetchImpl: options.fetchImpl, spec: [ARCANA_ENTRY!], now: () => options.at, templateScope: options.templateScope },
      { companyId: row.companyId, agentId: row.id },
    );
  }

  const entry = await readEntry(db, row.id);
  if (!entry) return { outcome: { ...base, result: "failed", plan, reason: "entry_missing" }, touchedArcana };
  if (entry.setup.state === "ready") {
    const enabled = await enableForAgent(db, row.companyId, row.id, entry);
    if (enabled === "failed") return { outcome: { ...base, result: "failed", plan, reason: "enable_failed" }, touchedArcana };
    if (enabled === "already") return { outcome: { ...base, result: "skipped", reason: "lost_race" }, touchedArcana };
    return { outcome: { ...base, result: "provisioned", plan }, touchedArcana };
  }
  if (entry.setup.state === "error") {
    return { outcome: { ...base, result: "failed", plan, reason: entry.setup.reason ?? "provisioner_failed" }, touchedArcana };
  }
  // Waiting (template or config) or retrying: the durable sweep carries it on; a later run reports setup_in_progress.
  return { outcome: { ...base, result: "pending", plan, reason: entry.setup.reason ?? "setup_pending" }, touchedArcana };
}

/** The verified human already recorded on the agent's other entries, else the one resolved from its creation activity, else none. */
async function ownerFor(db: Db, row: { id: string; companyId: string }, metadata: unknown): Promise<string | null> {
  for (const [, entry] of Object.entries(readDefaultMcpState(metadata)?.entries ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof entry.ownerUserId === "string" && entry.ownerUserId) return entry.ownerUserId;
  }
  return (await resolveLegacyResponsibleUser(db, row.companyId, row.id))?.userId ?? null;
}

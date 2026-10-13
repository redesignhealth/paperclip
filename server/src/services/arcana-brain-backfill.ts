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
import { agents, companies, toolConnections, type Db } from "@paperclipai/db";
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
  | "lost_race";

export type ArcanaBackfillPlan = "add_entry" | "retry_failed" | "enable_only";

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

function planFor(metadata: unknown): Planned {
  const classification = classifyMetadata(metadata);
  if (classification === "corrupted") return { kind: "skip", reason: "corrupted_existing_state" };
  if (classification === "absent") return { kind: "act", plan: "add_entry" };
  const entry = readDefaultMcpState(metadata)?.entries[ARCANA_BACKFILL_ENTRY_KEY] as ArcanaEntryState | undefined;
  if (!entry) return { kind: "act", plan: "add_entry" };
  const state = entry.setup.state;
  if (state === "ready") return entry.backfillEnable === "pending" ? { kind: "act", plan: "enable_only" } : { kind: "skip", reason: "already_provisioned" };
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

async function readEntry(db: Db, agentId: string): Promise<ArcanaEntryState | undefined> {
  const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return readDefaultMcpState(row?.metadata)?.entries[ARCANA_BACKFILL_ENTRY_KEY] as ArcanaEntryState | undefined;
}

/** Installs the agent's OWN dedicated connection for that agent only, then records it (once). Local writes only. */
async function enableForAgent(db: Db, companyId: string, agentId: string, entry: ArcanaEntryState): Promise<boolean> {
  if (!entry.dedicated || !entry.connectionId || !entry.binding?.grantId) return false;
  const [connection] = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, entry.connectionId)))
    .limit(1);
  // The stored dedicated connection id is authoritative, but the name must still be this agent's own.
  if (!connection || connection.status === "archived" || connection.name !== dedicatedConnectionName(entry.templateKey, agentId)) return false;
  await toolAccessService(db).addAgentConnectionInstall(db, connection, agentId, undefined, {
    install: true,
    bindingSource: "default_mcp_spec",
  });
  await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, ${entryPath("enabled")}, 'true'::jsonb, false), ${entryPath("backfillEnable")}, '"done"'::jsonb, false)`,
    })
    .where(and(eq(agents.id, agentId), sql`${agents.metadata} #>> ${entryPath("backfillEnable")} = 'pending'`));
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
  return true;
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
    const planned = planFor(row.metadata);
    if (planned.kind === "skip") { skip(row, planned.reason); continue; }
    if (gate.dryRun) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "would_provision", plan: planned.plan });
      continue;
    }

    // Failures are isolated to this agent: nothing thrown here stops the batch.
    try {
      if (calledOut && delayMs > 0) await sleep(delayMs);
      const now = options.now?.() ?? new Date();
      const outcome = await provisionOne(db, row, planned.plan, { ...options, env: gate.env, now });
      if (outcome.touchedArcana) calledOut = true;
      outcomes.push(outcome.outcome);
    } catch (err) {
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "arcana brain backfill item failed");
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
  options: ArcanaBackfillOptions & { env: NodeJS.ProcessEnv; now: Date },
): Promise<{ outcome: ArcanaBackfillOutcome; touchedArcana: boolean }> {
  const base = { agentId: row.id, companyId: row.companyId };
  if (plan === "add_entry") {
    const [existing] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, row.id)).limit(1);
    const owner = await ownerFor(db, row, existing?.metadata);
    const added = await addEntry(db, row, owner, options.now);
    if (added !== "added") return { outcome: { ...base, result: "skipped", reason: added }, touchedArcana: false };
  } else if (plan === "retry_failed") {
    if (!(await resetFailedEntry(db, row.id, options.now))) return { outcome: { ...base, result: "skipped", reason: "lost_race" }, touchedArcana: false };
  }

  if (plan !== "enable_only") {
    // The same runner and hook that provision a new agent, restricted to this one entry.
    await runDefaultMcpSetupForAgent(
      { db, env: options.env, fetchImpl: options.fetchImpl, spec: [ARCANA_ENTRY!], now: () => options.now, templateScope: options.templateScope },
      { companyId: row.companyId, agentId: row.id },
    );
  }

  const entry = await readEntry(db, row.id);
  if (!entry) return { outcome: { ...base, result: "failed", plan, reason: "entry_missing" }, touchedArcana: true };
  if (entry.setup.state === "ready") {
    const enabled = await enableForAgent(db, row.companyId, row.id, entry);
    if (!enabled) return { outcome: { ...base, result: "failed", plan, reason: "enable_failed" }, touchedArcana: true };
    return { outcome: { ...base, result: "provisioned", plan }, touchedArcana: true };
  }
  if (entry.setup.state === "error") {
    return { outcome: { ...base, result: "failed", plan, reason: entry.setup.reason ?? "provisioner_failed" }, touchedArcana: true };
  }
  // Waiting (template or config) or retrying: the durable sweep carries it on; a later run reports setup_in_progress.
  return { outcome: { ...base, result: "pending", plan, reason: entry.setup.reason ?? "setup_pending" }, touchedArcana: true };
}

/** The verified human already recorded on the agent's other entries, else the one resolved from its creation activity, else none. */
async function ownerFor(db: Db, row: { id: string; companyId: string }, metadata: unknown): Promise<string | null> {
  for (const entry of Object.values(readDefaultMcpState(metadata)?.entries ?? {})) {
    if (typeof entry.ownerUserId === "string" && entry.ownerUserId) return entry.ownerUserId;
  }
  return (await resolveLegacyResponsibleUser(db, row.companyId, row.id))?.userId ?? null;
}

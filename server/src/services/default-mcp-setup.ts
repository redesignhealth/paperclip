/**
 * Default MCP spec runtime (TECH-7204): applies `DEFAULT_MCP_SPEC` to a NEW agent.
 *
 *  1. `snapshotDefaultMcpForNewAgent` runs INSIDE the agent-create transaction and records the
 *     agent's per-entry state under the server-managed `agents.metadata.defaultMcp` key (a
 *     `jsonb_set` of that key only). For an ordinary template it offers permission only (OFF, no
 *     install) or, for `defaultEnabled`, install + permission through the normal install helper.
 *  2. Setup hooks run AFTER commit, never inside a transaction around an external call and never
 *     awaited by agent creation. A durable sweep is the backstop. Every claim and checkpoint is a
 *     path-scoped `jsonb_set` guarded by a random `claimId`, so an owner bind or a stale claimer can
 *     neither lose nor clobber an outcome.
 *
 * Retry policy (the board and ownership POSTs are insert-only, so a lost response leaves a live
 * identity or token): pre-call checkpoints are written BEFORE each POST. A claim that finds a
 * checkpoint without its result is an UNKNOWN outcome and is terminal. Only steps that created
 * nothing external (missing config/template/owner/approval) or that follow a stored secret (the
 * dedicated connection stage, one local transaction) are retried, with bounded capped backoff.
 *
 * Effective install state is derived from install rows plus `installAppliesToAgent`
 * (default-mcp-spec.ts); a company-wide install never authorizes a managed connection.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import {
  agents,
  authUsers,
  companyMemberships,
  companySecrets,
  connectionGrants,
  toolCatalogEntries,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { syncConnectionCredentialBindings } from "./connection-credential-bindings.js";
import {
  composeCommsBoardIdentity,
  mintCommsBoardCredential,
  readCommsBoardProvisionerConfig,
  registerCommsBoardAgent,
  type FetchLike,
} from "./comms-board-provisioner-client.js";
import {
  DEFAULT_MCP_BACKOFF_BASE_MS,
  DEFAULT_MCP_BACKOFF_MAX_MS,
  DEFAULT_MCP_LEASE_MS,
  DEFAULT_MCP_MAX_ATTEMPTS,
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  isDefaultMcpSpecEnabled,
  readDefaultMcpState,
  type DefaultMcpAgentState,
  type DefaultMcpBindingRef,
  type DefaultMcpEntrySpec,
  type DefaultMcpEntryState,
  type DefaultMcpSetupHookKey,
  type DefaultMcpSetupReason,
} from "./default-mcp-spec.js";
import { secretService } from "./secrets.js";
import { credentialRefConfigPath, toolAccessService } from "./tool-access.js";

type DbLike = Pick<Db, "select" | "insert" | "update" | "execute">;

/** `ARRAY['defaultMcp','entries',<key>,...rest]` as bound text parameters. */
function entryPathSql(key: string, ...rest: string[]): SQL {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", key, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

type EntryPatch = {
  binding?: DefaultMcpBindingRef | null;
  connectionId?: string | null;
  setup?: Partial<DefaultMcpEntryState["setup"]>;
};

/**
 * Path-scoped write of only `setup.*`, `binding` and `connectionId`, and only while the entry is
 * still claimed by `claimId`. `ownerUserId`, `templateKey` and every other key are never touched.
 */
async function patchEntryUnderClaim(
  db: Pick<Db, "update">,
  agentId: string,
  key: string,
  claimId: string,
  patch: EntryPatch,
): Promise<boolean> {
  let expr: SQL = sql`${agents.metadata}`;
  const set = (rest: string[], value: unknown) => {
    expr = sql`jsonb_set(${expr}, ${entryPathSql(key, ...rest)}, ${JSON.stringify(value)}::jsonb, true)`;
  };
  if (patch.binding !== undefined) set(["binding"], patch.binding);
  if (patch.connectionId !== undefined) set(["connectionId"], patch.connectionId);
  for (const [field, value] of Object.entries(patch.setup ?? {})) set(["setup", field], value);
  const rows = await db
    .update(agents)
    .set({ metadata: expr })
    .where(
      and(
        eq(agents.id, agentId),
        sql`${agents.metadata} #>> ${entryPathSql(key, "setup", "claimId")} = ${claimId}`,
        sql`${agents.metadata} #>> ${entryPathSql(key, "setup", "state")} = 'in_progress'`,
      ),
    )
    .returning({ id: agents.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Phase 1: in-transaction snapshot
// ---------------------------------------------------------------------------

type Connection = typeof toolConnections.$inferSelect;

/** The org-curated (wizard-shaped) access profile of a template, if it has one. Additive, so it never shadows company tools. */
async function curatedAppProfile(db: Pick<Db, "select">, template: Connection) {
  const [profile] = await db
    .select()
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, template.companyId), eq(toolProfiles.profileKey, `app:${template.id}`)))
    .limit(1);
  const meta = (profile?.metadata ?? {}) as Record<string, unknown>;
  return profile && meta.source === "app_gallery_finish" && meta.connectionId === template.id ? profile : null;
}

/** A wizard-shaped profile offering exactly the template's ACTIVE (reviewed) actions; created only when none exists. */
async function ensureReviewedAppProfile(db: Pick<Db, "select" | "insert">, template: Connection) {
  const [existing] = await db
    .select({ id: toolProfiles.id })
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, template.companyId), eq(toolProfiles.profileKey, `app:${template.id}`)))
    .limit(1);
  if (existing) return;
  const [profile] = await db
    .insert(toolProfiles)
    .values({
      companyId: template.companyId,
      profileKey: `app:${template.id}`,
      name: template.name,
      description: `Access profile for ${template.name}.`,
      status: "active",
      defaultAction: "deny",
      metadata: { source: "app_gallery_finish", connectionId: template.id },
    })
    .onConflictDoNothing()
    .returning({ id: toolProfiles.id });
  if (!profile) return;
  const actions = await db
    .select()
    .from(toolCatalogEntries)
    .where(
      and(
        eq(toolCatalogEntries.companyId, template.companyId),
        eq(toolCatalogEntries.connectionId, template.id),
        eq(toolCatalogEntries.status, "active"),
        eq(toolCatalogEntries.entryKind, "tool"),
      ),
    );
  for (const action of actions) {
    await db.insert(toolProfileEntries).values({
      companyId: template.companyId,
      profileId: profile.id,
      selectorType: "catalog_entry",
      effect: "include",
      applicationId: template.applicationId,
      connectionId: template.id,
      catalogEntryId: action.id,
    });
  }
}

export async function snapshotDefaultMcpForNewAgent(
  db: DbLike,
  input: {
    companyId: string;
    agentId: string;
    /** Accepted for compatibility; the write is a path-scoped `jsonb_set`, never a whole-blob overwrite. */
    existingMetadata?: unknown;
    /** Verified human actor from the server-side request context; null for agent actors and built-ins. */
    ownerUserId?: string | null;
    status?: string;
    spec?: readonly DefaultMcpEntrySpec[];
    now?: Date;
  },
): Promise<DefaultMcpAgentState> {
  const spec = input.spec ?? DEFAULT_MCP_SPEC;
  const nowIso = (input.now ?? new Date()).toISOString();
  const entries: Record<string, DefaultMcpEntryState> = {};
  const service = toolAccessService(db as unknown as Db);

  for (const entry of spec) {
    // Scoped by company: a same-named connection in another tenant is never matched.
    const templates = await db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, input.companyId),
          eq(toolConnections.name, entry.connectionName),
          ne(toolConnections.status, "archived"),
        ),
      );
    const template = templates.length === 1 ? templates[0]! : null;
    const dedicated = Boolean(entry.setupHook);

    let enabled = false;
    if (template && !dedicated) {
      if (entry.defaultEnabled) {
        // Install + permission through the normal install helper (offers the reviewed actions).
        await ensureReviewedAppProfile(db, template);
        await service.addAgentConnectionInstall(db as unknown as Db, template, input.agentId, undefined, {
          install: true,
          // Server-tagged (additive) so the default-ON app never narrows away company-bound profiles.
          bindingSource: "default_mcp_spec",
        });
        enabled = true;
      } else if ((await curatedAppProfile(db, template))) {
        // OFF: the agent is offered the org's curated access (visible, permitted) with NO install.
        await service.addAgentConnectionInstall(db as unknown as Db, template, input.agentId, undefined, {
          install: false,
          bindingSource: "default_mcp_spec",
        });
      }
    }

    entries[entry.key] = {
      key: entry.key,
      templateKey: entry.connectionName,
      dedicated,
      enabled,
      templateConnectionId: template?.id ?? null,
      // Ordinary entries toggle the org connection itself; dedicated ones get their own connection at setup.
      connectionId: dedicated ? null : (template?.id ?? null),
      ownerUserId: input.ownerUserId ?? null,
      setup: {
        state: dedicated ? "pending" : "not_required",
        reason: dedicated && input.status === "pending_approval" ? "awaiting_approval" : null,
        attemptCount: 0,
        nextAttemptAt: null,
        leaseUntil: null,
        claimId: null,
        registerAttemptedAt: null,
        mintAttemptedAt: null,
        updatedAt: nowIso,
      },
      binding: null,
    };
  }

  const state: DefaultMcpAgentState = { version: 1, entries };
  // Only the protected key is written, merged into whatever metadata the row currently holds.
  await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(coalesce(${agents.metadata}, '{}'::jsonb), ARRAY[${DEFAULT_MCP_METADATA_KEY}::text], ${JSON.stringify(state)}::jsonb, true)`,
    })
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  return state;
}

/**
 * Sets `ownerUserId` ONLY where it is still null, by path (never touching `setup`, so a concurrent
 * claim is not disturbed). Callers must have verified the user; use `bindDefaultMcpOwnerForApproval`
 * for the approval flow, which also checks active membership of the agent's company.
 */
export async function bindDefaultMcpOwnerIfUnset(db: DbLike, agentId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId)).limit(1);
  for (const entry of Object.values(readDefaultMcpState(row?.metadata)?.entries ?? {})) {
    if (entry.setup.state === "not_required") continue;
    await db
      .update(agents)
      .set({
        metadata: sql`jsonb_set(${agents.metadata}, ${entryPathSql(entry.key, "ownerUserId")}, to_jsonb(${userId}::text), false)`,
      })
      .where(
        and(
          eq(agents.id, agentId),
          sql`jsonb_typeof(${agents.metadata} #> ${entryPathSql(entry.key, "ownerUserId")}) = 'null'`,
        ),
      );
  }
}

/**
 * Approval-time owner binding, run INSIDE the activation transaction (before any post-commit
 * schedule). The approver must be an active member of the agent's company; the creation-time owner
 * is never overridden.
 */
export async function bindDefaultMcpOwnerForApproval(
  db: DbLike,
  input: { companyId: string; agentId: string; approverUserId: string | null | undefined },
) {
  if (!input.approverUserId) return;
  const [membership] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.approverUserId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .limit(1);
  if (!membership) return;
  await bindDefaultMcpOwnerIfUnset(db, input.agentId, input.approverUserId);
}

// ---------------------------------------------------------------------------
// Phase 2: claim + hook runner
// ---------------------------------------------------------------------------

export type DefaultMcpHookResult =
  | { kind: "ready"; reason?: null }
  /** Nothing external happened yet; retried indefinitely with capped backoff. */
  | { kind: "waiting"; reason: DefaultMcpSetupReason }
  /** Counts toward the bounded retry budget. Only allowed once a secret is stored. */
  | { kind: "retry"; reason: DefaultMcpSetupReason }
  | { kind: "error"; reason: DefaultMcpSetupReason };

export interface DefaultMcpHookInput {
  db: Db;
  companyId: string;
  agentId: string;
  entry: DefaultMcpEntrySpec;
  /** Latest claimed entry state. Kept current by `checkpoint`. */
  current: () => DefaultMcpEntryState;
  /**
   * Durably persist progress (path-scoped, guarded by this claim). Pass `tx` to commit the write
   * together with a local transaction. Throws when the claim was lost.
   */
  checkpoint: (
    patch: {
      binding?: DefaultMcpBindingRef | null;
      connectionId?: string | null;
      registerAttemptedAt?: string;
      mintAttemptedAt?: string;
    },
    tx?: Pick<Db, "update">,
  ) => Promise<void>;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
}

export type DefaultMcpSetupHook = ((input: DefaultMcpHookInput) => Promise<DefaultMcpHookResult>) & {
  /**
   * Optional cheap, local check that a READY entry's wiring still matches reality. A drifted entry is
   * returned to `pending` so the (idempotent) local stage repairs it; nothing external is ever re-run.
   */
  verifyReady?: (db: Db, companyId: string, agentId: string, entry: DefaultMcpEntryState) => Promise<boolean>;
};

export interface DefaultMcpSetupContext {
  db: Db;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  spec?: readonly DefaultMcpEntrySpec[];
  hooks?: Partial<Record<DefaultMcpSetupHookKey, DefaultMcpSetupHook>>;
  now?: () => Date;
}

class ClaimLostError extends Error {}

export function defaultMcpBackoffMs(attemptCount: number): number {
  return Math.min(DEFAULT_MCP_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1), DEFAULT_MCP_BACKOFF_MAX_MS);
}

/**
 * Claims one entry: a path-scoped `jsonb_set` of `setup` only, whose WHERE clause (pending and due,
 * or in progress with an expired lease) is evaluated against the CURRENT row. Exactly one caller on
 * any instance wins, and an owner bind or other concurrent write can never invalidate it.
 */
async function claimEntry(
  db: Pick<Db, "update">,
  agentId: string,
  key: string,
  now: Date,
): Promise<DefaultMcpEntryState | null> {
  const claimId = randomUUID();
  const nowIso = now.toISOString();
  const setupPath = entryPathSql(key, "setup");
  // Server-written ISO-8601 UTC strings compare correctly as text, so a malformed stored value can
  // never raise a cast error (it just compares arbitrarily and the entry is retried or ignored).
  const stamp = (field: string) => sql`coalesce(${agents.metadata} #>> ${entryPathSql(key, "setup", field)}, '') COLLATE "C"`;
  const attemptCountSql = sql`CASE WHEN (${agents.metadata} #>> ${entryPathSql(key, "setup", "attemptCount")}) ~ '^[0-9]{1,6}$' THEN (${agents.metadata} #>> ${entryPathSql(key, "setup", "attemptCount")})::int ELSE 0 END`;
  const patch = {
    state: "in_progress",
    reason: null,
    nextAttemptAt: null,
    leaseUntil: new Date(now.getTime() + DEFAULT_MCP_LEASE_MS).toISOString(),
    claimId,
    updatedAt: nowIso,
  };
  const rows = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(${agents.metadata}, ${setupPath}, (${agents.metadata} #> ${setupPath}) || ${JSON.stringify(patch)}::jsonb || jsonb_build_object('attemptCount', ${attemptCountSql} + 1), false)`,
    })
    .where(
      and(
        eq(agents.id, agentId),
        notInArray(agents.status, ["pending_approval", "terminated"]),
        sql`(
          (${agents.metadata} #>> ${entryPathSql(key, "setup", "state")} = 'pending' AND ${stamp("nextAttemptAt")} <= ${nowIso}::text COLLATE "C")
          OR (${agents.metadata} #>> ${entryPathSql(key, "setup", "state")} = 'in_progress' AND ${stamp("leaseUntil")} <= ${nowIso}::text COLLATE "C")
        )`,
      ),
    )
    .returning({ entry: sql<DefaultMcpEntryState>`${agents.metadata} #> ${entryPathSql(key)}` });
  return rows[0]?.entry ?? null;
}

export async function runDefaultMcpSetupForAgent(
  ctx: DefaultMcpSetupContext,
  input: { companyId: string; agentId: string },
): Promise<void> {
  const spec = ctx.spec ?? DEFAULT_MCP_SPEC;
  const hooks = ctx.hooks ?? DEFAULT_MCP_SETUP_HOOKS;
  const env = ctx.env ?? process.env;
  const fetchImpl = ctx.fetchImpl ?? fetch;

  for (const entry of spec) {
    if (!entry.setupHook) continue;
    const hook = hooks[entry.setupHook];
    if (!hook) continue;

    const now = ctx.now?.() ?? new Date();
    // Company scope: the claim only matches an agent of THIS company.
    const [owned] = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .limit(1);
    if (!owned) continue;
    if (hook.verifyReady) {
      const [row] = await ctx.db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, input.agentId)).limit(1);
      const stored = readDefaultMcpState(row?.metadata)?.entries[entry.key];
      if (stored?.setup.state === "ready" && !(await hook.verifyReady(ctx.db, input.companyId, input.agentId, stored))) {
        // Wiring drifted since it was marked ready: back to pending (guarded on `ready`) for a local repair.
        await ctx.db
          .update(agents)
          .set({
            metadata: sql`jsonb_set(${agents.metadata}, ${entryPathSql(entry.key, "setup")}, (${agents.metadata} #> ${entryPathSql(entry.key, "setup")}) || ${JSON.stringify({ state: "pending", reason: null, nextAttemptAt: null, updatedAt: now.toISOString() })}::jsonb, false)`,
          })
          .where(and(eq(agents.id, input.agentId), sql`${agents.metadata} #>> ${entryPathSql(entry.key, "setup", "state")} = 'ready'`));
      }
    }
    const claimed = await claimEntry(ctx.db, input.agentId, entry.key, now);
    if (!claimed) continue;
    const claimId = claimed.setup.claimId!;

    let current = claimed;
    const checkpoint: DefaultMcpHookInput["checkpoint"] = async (patch, tx) => {
      const setup: EntryPatch["setup"] = { updatedAt: (ctx.now?.() ?? new Date()).toISOString() };
      if (patch.registerAttemptedAt) setup.registerAttemptedAt = patch.registerAttemptedAt;
      if (patch.mintAttemptedAt) setup.mintAttemptedAt = patch.mintAttemptedAt;
      const entryPatch: EntryPatch = { setup };
      if (patch.binding !== undefined) entryPatch.binding = patch.binding;
      if (patch.connectionId !== undefined) entryPatch.connectionId = patch.connectionId;
      if (!(await patchEntryUnderClaim(tx ?? ctx.db, input.agentId, entry.key, claimId, entryPatch))) throw new ClaimLostError();
      current = {
        ...current,
        connectionId: patch.connectionId === undefined ? current.connectionId : patch.connectionId,
        binding: patch.binding === undefined ? current.binding : patch.binding,
        setup: { ...current.setup, ...setup },
      };
    };

    let result: DefaultMcpHookResult;
    try {
      result = await hook({
        db: ctx.db,
        companyId: input.companyId,
        agentId: input.agentId,
        entry,
        current: () => current,
        checkpoint,
        env,
        fetchImpl,
      });
    } catch (err) {
      if (err instanceof ClaimLostError) continue;
      // Only the error class is logged: never a message, URL, header, or body.
      logger.warn(
        { agentId: input.agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        "default MCP setup hook failed",
      );
      result = { kind: "error", reason: "provisioner_failed" };
    }

    const finished = ctx.now?.() ?? new Date();
    const attempts = current.setup.attemptCount;
    let nextState: DefaultMcpEntryState["setup"]["state"];
    const reason: DefaultMcpSetupReason | null = result.reason ?? null;
    let nextAttemptAt: string | null = null;
    if (result.kind === "ready") nextState = "ready";
    else if (result.kind === "waiting") {
      nextState = "pending";
      nextAttemptAt = new Date(finished.getTime() + defaultMcpBackoffMs(attempts)).toISOString();
    } else if (result.kind === "retry") {
      if (attempts >= DEFAULT_MCP_MAX_ATTEMPTS) nextState = "error";
      else {
        nextState = "pending";
        nextAttemptAt = new Date(finished.getTime() + defaultMcpBackoffMs(attempts)).toISOString();
      }
    } else nextState = "error";

    const stored = await patchEntryUnderClaim(ctx.db, input.agentId, entry.key, claimId, {
      setup: { state: nextState, reason, nextAttemptAt, leaseUntil: null, claimId: null, updatedAt: finished.toISOString() },
    });
    if (!stored) continue;
    await logActivity(ctx.db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "default-mcp-spec",
      action: "agent.default_mcp.setup",
      entityType: "agent",
      entityId: input.agentId,
      // Non-secret facts only.
      details: {
        key: entry.key,
        state: nextState,
        reason,
        attemptCount: attempts,
        ownerUserId: current.ownerUserId,
        baseSub: current.binding?.baseSub ?? null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Durable sweep + non-blocking scheduling
// ---------------------------------------------------------------------------

export const DEFAULT_MCP_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_MCP_SWEEP_LIMIT = 25;

export async function sweepDefaultMcpSetups(ctx: DefaultMcpSetupContext & { limit?: number }): Promise<number> {
  const now = (ctx.now?.() ?? new Date()).toISOString();
  // Type-guarded in the function argument itself (a WHERE guard alone can be reordered by the
  // planner), and text-compared timestamps: one malformed legacy/forged row cannot abort the batch.
  const result: unknown = await ctx.db.execute(sql`
    select a.id as id, a.company_id as company_id
    from agents a
    where a.status not in ('pending_approval', 'terminated')
      and jsonb_typeof(a.metadata -> ${DEFAULT_MCP_METADATA_KEY}) = 'object'
      and exists (
        select 1 from jsonb_each(
          case when jsonb_typeof(a.metadata -> ${DEFAULT_MCP_METADATA_KEY} -> 'entries') = 'object'
               then a.metadata -> ${DEFAULT_MCP_METADATA_KEY} -> 'entries'
               else '{}'::jsonb end
        ) e(key, val)
        where (val -> 'setup' ->> 'state' = 'pending'
                and coalesce(val -> 'setup' ->> 'nextAttemptAt', '') COLLATE "C" <= ${now}::text COLLATE "C")
           or (val -> 'setup' ->> 'state' = 'in_progress'
                and coalesce(val -> 'setup' ->> 'leaseUntil', '') COLLATE "C" <= ${now}::text COLLATE "C")
      )
    order by a.updated_at asc
    limit ${ctx.limit ?? DEFAULT_MCP_SWEEP_LIMIT}
  `);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
    id: string;
    company_id: string;
  }>;
  for (const row of rows) {
    try {
      await runDefaultMcpSetupForAgent(ctx, { companyId: row.company_id, agentId: row.id });
    } catch (err) {
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP setup sweep item failed");
    }
  }
  return rows.length;
}

const inFlight = new Set<Promise<unknown>>();

/** Fire-and-observe: kicks setup after the create/approval commit without blocking the request. */
export function scheduleDefaultMcpSetup(db: Db, input: { companyId: string; agentId: string }, ctx: Omit<DefaultMcpSetupContext, "db"> = {}) {
  const run = new Promise<void>((resolve) => {
    setImmediate(() => {
      runDefaultMcpSetupForAgent({ db, ...ctx }, input)
        .catch((err) =>
          logger.warn({ agentId: input.agentId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP setup failed"),
        )
        .finally(resolve);
    });
  });
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** Test seam: resolves once every scheduled setup has finished. */
export async function waitForScheduledDefaultMcpSetups(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/** Starts the backstop sweep (startup + every 60s, unref'd). No-op unless the feature flag is on. */
export function startDefaultMcpSetupSweep(db: Db, ctx: Omit<DefaultMcpSetupContext, "db"> = {}): () => void {
  if (!isDefaultMcpSpecEnabled(ctx.env ?? process.env)) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    sweepDefaultMcpSetups({ db, ...ctx })
      .catch((err) => logger.warn({ errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP setup sweep failed"))
      .finally(() => {
        running = false;
      });
  };
  const startup = setImmediate(tick);
  const timer = setInterval(tick, DEFAULT_MCP_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearImmediate(startup);
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// Hook: comms_board_identity
// ---------------------------------------------------------------------------

async function ownerEmailFor(db: Db, companyId: string, userId: string): Promise<string | null> {
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

/** Read-only template lookup by the FROZEN template key. Returns a waiting reason when it can't be used. */
async function resolveTemplate(db: Pick<Db, "select">, companyId: string, name: string): Promise<{ template: Connection } | { reason: DefaultMcpSetupReason }> {
  const rows = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, name), ne(toolConnections.status, "archived")));
  if (rows.length === 0) return { reason: "template_not_found" };
  if (rows.length > 1) return { reason: "template_ambiguous" };
  const template = rows[0]!;
  // An org opts in by providing an active, api-key MCP template that already carries a header credential ref.
  const header = (template.credentialRefs ?? []).find((ref) => ref.placement === "header");
  if (template.status !== "active" || template.authKind !== "api_key" || template.transport !== "mcp_remote" || !header) {
    return { reason: "template_unsupported" };
  }
  return { template };
}

/** Deterministic, company-scoped name: the org template name plus the agent UUID. */
export const dedicatedConnectionName = (templateName: string, agentId: string) => `${templateName}:${agentId}`;

/**
 * Copies the template's catalog and access profile onto the dedicated connection, completely and
 * idempotently (every insert is conflict-safe and missing pieces are filled in on a retry), and
 * gives ONLY this agent access. Quarantine/review status is copied as-is; the profile is always
 * default-deny. Access is not an install: the agent sees the app "permitted but not installed".
 */
async function cloneTemplateAccess(db: Db, template: Connection, dedicated: Connection, agentId: string) {
  const templateEntries = await db
    .select()
    .from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, template.companyId), eq(toolCatalogEntries.connectionId, template.id)))
    .orderBy(asc(toolCatalogEntries.name));
  for (const entry of templateEntries) {
    const { id: _id, ...rest } = entry;
    await db.insert(toolCatalogEntries).values({ ...rest, connectionId: dedicated.id }).onConflictDoNothing();
  }
  const dedicatedEntries = await db
    .select({ id: toolCatalogEntries.id, name: toolCatalogEntries.name })
    .from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, template.companyId), eq(toolCatalogEntries.connectionId, dedicated.id)));
  const dedicatedIdByName = new Map(dedicatedEntries.map((entry) => [entry.name, entry.id]));
  const idMap = new Map(templateEntries.map((entry) => [entry.id, dedicatedIdByName.get(entry.name) ?? null]));

  const [templateProfile] = await db
    .select()
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, template.companyId), eq(toolProfiles.profileKey, `app:${template.id}`)))
    .limit(1);
  if (!templateProfile) return;
  await db
    .insert(toolProfiles)
    .values({
      companyId: template.companyId,
      profileKey: `app:${dedicated.id}`,
      name: dedicated.name,
      description: `Access profile for ${dedicated.name}.`,
      status: "active",
      defaultAction: "deny",
      metadata: { source: "app_gallery_finish", connectionId: dedicated.id },
    })
    .onConflictDoNothing();
  const [profile] = await db
    .select()
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, template.companyId), eq(toolProfiles.profileKey, `app:${dedicated.id}`)))
    .limit(1);
  if (!profile) throw new Error("dedicated profile missing");

  const signature = (entry: { selectorType: string; effect: string; catalogEntryId: string | null; toolName: string | null; riskLevel: string | null; connectionId: string | null }) =>
    [entry.selectorType, entry.effect, entry.catalogEntryId, entry.toolName, entry.riskLevel, entry.connectionId].join("|");
  const existing = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
  const have = new Set(existing.map(signature));
  const wanted = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, templateProfile.id));
  for (const entry of wanted) {
    const { id: _id, profileId: _profileId, ...rest } = entry;
    const mapped = {
      ...rest,
      profileId: profile.id,
      connectionId: entry.connectionId === template.id ? dedicated.id : entry.connectionId,
      catalogEntryId: entry.catalogEntryId ? (idMap.get(entry.catalogEntryId) ?? null) : null,
    };
    // A template include whose action has no counterpart is skipped, never widened.
    if (entry.catalogEntryId && !mapped.catalogEntryId) continue;
    if (have.has(signature(mapped))) continue;
    await db.insert(toolProfileEntries).values(mapped);
    have.add(signature(mapped));
  }
  // Permission (not install) for this agent only. The binding is server-tagged, so the existing
  // precedence treats it as an additive app offering and it never drops company-bound profiles.
  await db
    .insert(toolProfileBindings)
    .values({ companyId: template.companyId, profileId: profile.id, targetType: "agent", targetId: agentId, priority: 100, metadata: { source: "default_mcp_spec", connectionId: dedicated.id } })
    .onConflictDoNothing();
}

/**
 * The whole local stage in ONE transaction: dedicated connection (find or clone), catalog + profile
 * copy, grant upsert, credential bindings, and the claim-guarded checkpoint. No network inside. The
 * per-agent advisory lock serializes a retry against a lease takeover, since connection names are
 * not unique in the database.
 */
async function ensureDedicatedStage(
  input: DefaultMcpHookInput,
  templateName: string,
  binding: DefaultMcpBindingRef,
  ownerUserId: string | null,
): Promise<void> {
  const { db, companyId, agentId } = input;
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:default-mcp:dedicated:" + agentId}, 0))`);

    const resolved = await resolveTemplate(txDb, companyId, templateName);
    if ("reason" in resolved) throw new Error(`template unavailable: ${resolved.reason}`);
    const template = resolved.template;
    const name = dedicatedConnectionName(template.name, agentId);
    const known = input.current().connectionId;
    const existing = await txDb
      .select()
      .from(toolConnections)
      .where(
        known
          ? and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, known))
          : and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, name), ne(toolConnections.status, "archived")),
      );
    if (existing.length > 1) throw new Error("ambiguous dedicated connection");
    let dedicated = existing[0];
    if (dedicated && (dedicated.name !== name || dedicated.credentialPolicy !== "per_agent")) throw new Error("unexpected dedicated connection");
    if (!dedicated) {
      const templateRef = (template.credentialRefs ?? []).find((ref) => ref.placement === "header")!;
      dedicated = await toolAccessService(txDb).cloneConnectionFromTemplate(txDb, template, {
        name,
        credentialRefs: [{ ...templateRef, secretId: binding.secretId!, version: "latest" }],
      });
    }
    await cloneTemplateAccess(txDb, template, dedicated, agentId);

    const headerRefs = (dedicated.credentialRefs ?? []).filter((ref) => ref.placement === "header");
    // More than one header ref makes the credential mapping ambiguous: never pick one.
    if (headerRefs.length !== 1) throw new Error("dedicated connection must have exactly one header credential ref");
    let headerRef = headerRefs[0]!;
    if (headerRef.secretId !== binding.secretId) {
      // The agent's own vault secret is authoritative: point the connection's ref back at it.
      headerRef = { ...headerRef, secretId: binding.secretId! };
      const credentialRefs = dedicated.credentialRefs.map((ref) => (ref.placement === "header" ? headerRef : ref));
      const [fixed] = await txDb
        .update(toolConnections)
        .set({ credentialRefs, updatedAt: new Date() })
        .where(eq(toolConnections.id, dedicated.id))
        .returning();
      dedicated = fixed!;
    }
    const secretRef = {
      secretId: binding.secretId!,
      versionSelector: "latest" as const,
      configPath: credentialRefConfigPath(headerRef),
      required: true,
      label: "Comms board token",
    };
    const [grant] = await txDb
      .insert(connectionGrants)
      .values({
        companyId,
        connectionId: dedicated.id,
        kind: "agent",
        subjectAgentId: agentId,
        credentialSecretRefs: [secretRef],
        status: "active",
        createdByUserId: ownerUserId,
      })
      .onConflictDoUpdate({
        target: [connectionGrants.connectionId, connectionGrants.subjectAgentId],
        set: { credentialSecretRefs: [secretRef], status: "active", revokedAt: null, updatedAt: new Date() },
      })
      .returning({ id: connectionGrants.id });
    // The connection ref and the grant ref are the same secret at the same config path, so the
    // existing binding sync collapses them into one binding for this single agent/connection.
    await syncConnectionCredentialBindings(txDb, dedicated);
    await input.checkpoint({ binding: { ...binding, connectionId: dedicated.id, grantId: grant!.id }, connectionId: dedicated.id }, txDb);
  });
}

export const commsBoardIdentityHook: DefaultMcpSetupHook = async (input) => {
  const { db, companyId, agentId, entry } = input;
  const current = input.current();
  const templateName = current.templateKey || entry.connectionName; // the FROZEN key, never today's spec
  let binding = current.binding;

  if (!binding?.secretId) {
    // Checkpoints without their result mean a previous attempt's POST outcome is unknown. Terminal.
    if (current.setup.mintAttemptedAt) return { kind: "error", reason: "mint_unknown" };
    if (current.setup.registerAttemptedAt && !binding?.boardAgentId) return { kind: "error", reason: "board_unknown" };
  }

  // Everything that can be missing is checked BEFORE any external call, so waiting never leaves an orphan.
  const config = readCommsBoardProvisionerConfig(input.env);
  if (!binding?.secretId && !config) return { kind: "waiting", reason: "provisioner_not_configured" };
  const ownerEmail = current.ownerUserId ? await ownerEmailFor(db, companyId, current.ownerUserId) : null;
  if (!binding?.secretId && !ownerEmail) return { kind: "waiting", reason: "owner_required" };
  const resolved = await resolveTemplate(db, companyId, templateName);
  if ("reason" in resolved) return { kind: "waiting", reason: resolved.reason };

  if (!binding?.secretId) {
    if (!binding?.boardAgentId) {
      const [agentRow] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .limit(1);
      const identity = composeCommsBoardIdentity(agentId, normalizeAgentUrlKey(agentRow?.name ?? "") ?? "");
      if (!identity) return { kind: "error", reason: "invalid_subject" };
      // Pre-call checkpoint: from here an unresolved attempt is an unknown outcome.
      await input.checkpoint({ registerAttemptedAt: new Date().toISOString() });
      const registered = await registerCommsBoardAgent(
        config!,
        {
          boardSub: identity.boardSub,
          displayName: `${(agentRow?.name ?? "Agent").slice(0, 200)} (${agentId.slice(0, 8)})`,
          ownerEmail: ownerEmail!,
        },
        input.fetchImpl,
      );
      if (!registered.ok) return { kind: "error", reason: registered.reason };
      binding = {
        boardAgentId: registered.boardAgentId,
        baseSub: identity.baseSub,
        agentKey: identity.agentKey,
        boardSub: identity.boardSub,
        secretId: null,
        secretVersion: null,
        connectionId: null,
        grantId: null,
        tokenExpiresAt: null,
      };
      await input.checkpoint({ binding });
    }

    await input.checkpoint({ mintAttemptedAt: new Date().toISOString() });
    const minted = await mintCommsBoardCredential(config!, { baseSub: binding.baseSub, ownerEmail: ownerEmail! }, input.fetchImpl);
    if (!minted.ok) return { kind: "error", reason: minted.reason };

    let secretId: string;
    try {
      const secret = await secretService(db).create(
        companyId,
        {
          name: `Comms Board token (agent ${agentId})`,
          key: `comms_board.${agentId}`,
          provider: "local_encrypted",
          value: minted.boardToken,
          description: `Managed comms-board token for agent ${agentId}. Provisioned at agent creation.`,
        },
        { userId: current.ownerUserId },
      );
      secretId = secret.id;
    } catch {
      // The token cannot be fetched again; the identity stays on the entry so the orphan is identifiable.
      return { kind: "error", reason: "secret_store_failed" };
    }
    binding = { ...binding, secretId, secretVersion: "latest", tokenExpiresAt: minted.tokenExpiresAt };
    await input.checkpoint({ binding });
  }

  // A deleted/disabled vault secret is an intentionally revoked credential: never re-minted or recreated.
  if (binding?.secretId && !(await vaultSecretUsable(db, companyId, binding.secretId))) {
    return { kind: "error", reason: "secret_unavailable" };
  }

  // Secret stored: the rest is one local, idempotent, retryable transaction (no external call).
  try {
    await ensureDedicatedStage(input, templateName, binding, current.ownerUserId);
    return { kind: "ready" };
  } catch (err) {
    if (err instanceof ClaimLostError) throw err;
    return { kind: "retry", reason: "binding_failed" };
  }
};

export const DEFAULT_MCP_SETUP_HOOKS: Partial<Record<DefaultMcpSetupHookKey, DefaultMcpSetupHook>> = {
  comms_board_identity: commsBoardIdentityHook,
};

/** The wiring a READY comms entry depends on, checked against the real rows (local reads only). */
async function commsWiringIntact(db: Pick<Db, "select">, companyId: string, agentId: string, entry: DefaultMcpEntryState): Promise<boolean> {
  const binding = entry.binding;
  if (!binding?.secretId || !binding.connectionId || !binding.grantId) return false;
  const [connection] = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.id, binding.connectionId), eq(toolConnections.companyId, companyId)))
    .limit(1);
  if (!connection || connection.credentialPolicy !== "per_agent" || connection.status === "archived") return false;
  const headers = (connection.credentialRefs ?? []).filter((ref) => ref.placement === "header");
  if (headers.length !== 1 || headers[0]!.secretId !== binding.secretId) return false;
  const [grant] = await db
    .select()
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.id, binding.grantId),
        eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "agent"),
        eq(connectionGrants.subjectAgentId, agentId),
        eq(connectionGrants.status, "active"),
      ),
    )
    .limit(1);
  if (!grant || grant.credentialSecretRefs.length !== 1) return false;
  const ref = grant.credentialSecretRefs[0]!;
  if (ref.secretId !== binding.secretId || ref.configPath !== credentialRefConfigPath(headers[0]!)) return false;
  return vaultSecretUsable(db, companyId, binding.secretId);
}

/** The vault secret must exist in this company and be active and not soft-deleted (the secret service's own validity fields). */
async function vaultSecretUsable(db: Pick<Db, "select">, companyId: string, secretId: string): Promise<boolean> {
  const [secret] = await db
    .select({ id: companySecrets.id })
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.id, secretId),
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(secret);
}

commsBoardIdentityHook.verifyReady = (db, companyId, agentId, entry) => commsWiringIntact(db, companyId, agentId, entry);

/**
 * Fail-closed, validated lookup of an agent's comms-board binding for the wake bridge: the agent
 * must belong to `companyId`, the entry must be ready, the dedicated connection, its single header
 * path, the ACTIVE agent grant and the vault secret must all agree, and the token must not be
 * expired. Returns ids only; the token is never exported. (The pure `readCommsBoardBindingReference`
 * only reads metadata and is advisory.)
 */
export async function resolveCommsBoardBinding(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
  now: Date = new Date(),
): Promise<DefaultMcpBindingRef | null> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  const entry = readDefaultMcpState(row?.metadata)?.entries["comms-board"];
  if (!entry || entry.setup.state !== "ready" || !entry.binding) return null;
  if (entry.binding.tokenExpiresAt && Date.parse(entry.binding.tokenExpiresAt) <= now.getTime()) return null;
  if (!(await commsWiringIntact(db, companyId, agentId, entry))) return null;
  return { ...entry.binding };
}

/**
 * Legacy-agent enrollment for the default MCP spec (TECH-7339).
 *
 * Applies the same durable snapshot + setup path used for new-agent creation
 * (`snapshotDefaultMcpForNewAgent` / `scheduleDefaultMcpSetup`, `default-mcp-setup.ts`) to agents
 * created before the feature existed. No client metadata PATCH, direct SQL edit or one-off token
 * script: this is the same server-managed `agents.metadata.defaultMcp` write, through the same
 * code path, so an enrolled agent is indistinguishable from one created after the feature shipped.
 *
 * Idempotent: only an agent whose `defaultMcp` key is absent or explicitly null (the same
 * "legacy/unmanaged" definition used everywhere else in this feature, see
 * doc/connections/DEFAULT-MCP-SPEC.md) is touched. An agent that already has a snapshot -- however
 * it got there -- is left alone, so a repeated batch never duplicates an identity, connection,
 * binding or credential. An agent whose `defaultMcp` key is present but fails validation is reported
 * as `corrupted_existing_state` rather than silently overwritten; that state fails closed at runtime
 * (see `readDefaultMcpState`) and this path does not second-guess that.
 *
 * Respects the same gates as new-agent creation: the feature flag
 * (`PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED`) and the frozen company rollout scope
 * (`PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS`). An archived company is skipped and reported, never
 * enrolled. `dryRun` performs the same scan and classification with no writes (a census).
 */
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { readDefaultMcpTemplateScope, isCompanyInDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  isDefaultMcpSpecEnabled,
  isValidDefaultMcpTemplate,
  readDefaultMcpState,
} from "./default-mcp-spec.js";
import { scheduleDefaultMcpSetup, snapshotDefaultMcpForNewAgent, LegacyPreserveUnsatisfiedError } from "./default-mcp-setup.js";
export { LegacyPreserveUnsatisfiedError } from "./default-mcp-setup.js";

export const DEFAULT_MCP_LEGACY_ENROLLMENT_BATCH_LIMIT = 25;

export type LegacyEnrollmentSkipReason =
  | "company_archived"
  | "company_out_of_scope"
  | "owner_required"
  | "corrupted_existing_state"
  | "agent_terminated"
  | "legacy_access_conflict";

export type LegacyEnrollmentOutcome =
  | { agentId: string; companyId: string; result: "enrolled" }
  | { agentId: string; companyId: string; result: "would_enroll" }
  | { agentId: string; companyId: string; result: "skipped"; reason: LegacyEnrollmentSkipReason };

export interface LegacyEnrollmentReport {
  /** Rows actually scanned in this batch (bounded by `limit`), not a total count across all pages. */
  scanned: number;
  outcomes: LegacyEnrollmentOutcome[];
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

/** Same "legacy/unmanaged" definition as `readDefaultMcpState`, split from "corrupted". */
function classifyDefaultMcpMetadata(metadata: unknown): "absent" | "corrupted" | "present" {
  // A non-null, non-plain-object metadata value (array, string, number) is malformed agent metadata,
  // not "no defaultMcp key" -- treating it as absent would let the enrollment write attempt a
  // `jsonb_set` against a non-object root and throw inside the transaction. Report it instead.
  if (metadata !== null && metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) {
    return "corrupted";
  }
  if (!metadata || typeof metadata !== "object") return "absent";
  const raw = (metadata as Record<string, unknown>)[DEFAULT_MCP_METADATA_KEY];
  if (raw === undefined || raw === null) return "absent";
  return readDefaultMcpState(metadata) !== null ? "present" : "corrupted";
}

export interface LegacyResponsibleUser {
  userId: string;
  emailNorm: string;
}

const AGENT_CREATION_ACTIONS = ["agent.created", "agent.hire_created"] as const;
const AGENT_APPROVAL_ACTIONS = ["agent.approved"] as const;

async function earliestUserActorFor(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
  actions: readonly string[],
): Promise<string | null> {
  const [row] = await db
    .select({ actorId: activityLog.actorId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, agentId),
        eq(activityLog.actorType, "user"),
        inArray(activityLog.action, actions),
      ),
    )
    .orderBy(asc(activityLog.createdAt))
    .limit(1);
  return row?.actorId ?? null;
}

async function distinctUserActorsFor(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
  actions: readonly string[],
): Promise<string[]> {
  const rows = await db
    .select({ actorId: activityLog.actorId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, agentId),
        eq(activityLog.actorType, "user"),
        inArray(activityLog.action, actions),
      ),
    )
    .orderBy(asc(activityLog.createdAt));
  return Array.from(new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id))));
}

async function latestApprovedHireApproverFor(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ decidedByUserId: approvals.decidedByUserId })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.type, "hire_agent"),
        eq(approvals.status, "approved"),
        sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
      ),
    )
    .orderBy(desc(sql`coalesce(${approvals.decidedAt}, ${approvals.createdAt})`))
    .limit(1);
  return row?.decidedByUserId ?? null;
}

async function resolveApproverCandidate(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<string | null> {
  const activityApprovers = await distinctUserActorsFor(db, companyId, agentId, AGENT_APPROVAL_ACTIONS);
  const tableApproverId = await latestApprovedHireApproverFor(db, companyId, agentId);

  // If activity log has multiple conflicting approver actors, evidence is conflicting
  if (activityApprovers.length > 1) {
    return null;
  }
  const activityApproverId = activityApprovers[0] ?? null;

  // In normal operation a single approved action logs BOTH sources with the same decider.
  // If both sources exist and disagree, this is conflict evidence, not legitimate supersession -> return null (owner_required)
  if (activityApproverId && tableApproverId) {
    if (activityApproverId !== tableApproverId) {
      return null;
    }
    return activityApproverId;
  }

  // If only one exists, missing the other is valid
  return activityApproverId ?? tableApproverId;
}

async function validateActiveHumanUser(
  db: Pick<Db, "select">,
  companyId: string,
  candidateId: string | null | undefined,
): Promise<LegacyResponsibleUser | null> {
  if (!candidateId || candidateId.trim().toLowerCase() === "board") return null;
  const [membership] = await db
    .select({ email: authUsers.email })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, candidateId),
        eq(companyMemberships.status, "active"),
        eq(authUsers.emailVerified, true),
      ),
    )
    .limit(1);
  const emailNorm = (membership?.email ?? "").trim().toLowerCase();
  if (!emailNorm) return null;
  return { userId: candidateId, emailNorm };
}

/**
 * The human responsible for a specific legacy agent:
 * 1. The earliest verified-human actor on its own `agent.created`/`agent.hire_created` activity.
 *    If human creator history exists, it wins. If that human creator is inactive, unverified or a
 *    board sentinel, `owner_required` is returned -- never substituted with an approver or company owner.
 * 2. If no human creation record (e.g. agent-created, system-created, or legacy agent), the
 *    approval evidence from `agent.approved` activity log and `approvals` table. If both exist and
 *    disagree, this is conflicting evidence and returns `owner_required`. Missing one valid other
 *    source is allowed.
 *
 * Deliberately NOT `activityLog.responsibleUserId` (falls back to the company default) and NOT the
 * company's owner/admin: a company-wide fallback here would attribute a specific agent's credential
 * to a human who may have had nothing to do with it. Board sentinels ('board'), cross-company actors,
 * and inactive or unverified candidates are treated as `owner_required`, never silently substituted.
 */
export async function resolveLegacyResponsibleUser(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<LegacyResponsibleUser | null> {
  const creatorId = await earliestUserActorFor(db, companyId, agentId, AGENT_CREATION_ACTIONS);
  if (creatorId) {
    return validateActiveHumanUser(db, companyId, creatorId);
  }

  const approverId = await resolveApproverCandidate(db, companyId, agentId);
  if (approverId) {
    return validateActiveHumanUser(db, companyId, approverId);
  }

  return null;
}

export interface LegacyAccessAssessment {
  /** Ordinary (non-dedicated) entry keys this agent already has effective access to; preserve as ON. */
  preserveKeys: ReadonlySet<string>;
  /** Map of entry.key -> connectionId for ordinary entries to preserve as ON. */
  preserveConnections: ReadonlyMap<string, string>;
  /** An existing install or grant exists but can't be safely mapped to a valid, unambiguous template,
   * or touches a dedicated entry (e.g. comms-board) that would be masked/forbidden by snapshot management. */
  conflict: boolean;
}

/**
 * Before a legacy agent is snapshotted, a company-wide install on one of the ordinary (non-dedicated)
 * spec entries (e.g. Google) grants it effective access today (see `installAppliesToAgent`: a
 * company install applies whenever the agent has no `defaultMcp` state at all). The instant the
 * agent becomes snapshot-managed, that same function stops honoring a company-wide install for a
 * managed connection -- only an explicit per-agent install counts. Left alone, enrollment would
 * silently revoke access with no DB row ever changing. This inspects each ordinary entry's existing
 * agent-or-company install (if any) and reports which entry keys to carry forward as an explicit
 * install (`preserveKeys` and `preserveConnections`), or flags `conflict` when an install exists but
 * can't be safely attributed to one valid template -- the caller skips the whole agent
 * (`legacy_access_conflict`) rather than guess.
 *
 * Note: Ordinary ON preservation is based ONLY on actual applicable install rows (installedConnectionIds),
 * never on mere active grants (an active agent grant on Google without an install row does NOT mean the
 * tool was installed or active for the agent).
 *
 * Dedicated entries (e.g. comms-board) require dedicated per-agent connections created by the setup
 * hook. If an agent already has an install OR active agent grant on any comms-board connection,
 * snapshotting would immediately mask/forbid that connection under `managedConnectionRole` ("forbidden")
 * without a dedicated migration. Such agents are flagged as `conflict` and left unchanged.
 */
export async function assessLegacyAccess(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<LegacyAccessAssessment> {
  const installs = await db
    .select({ connectionId: toolConnectionInstalls.connectionId, targetType: toolConnectionInstalls.targetType, targetId: toolConnectionInstalls.targetId })
    .from(toolConnectionInstalls)
    .where(
      and(
        eq(toolConnectionInstalls.companyId, companyId),
        inArray(toolConnectionInstalls.targetType, ["agent", "company"]),
      ),
    );
  const installedConnectionIds = new Set(
    installs
      .filter((install) => (install.targetType === "agent" && install.targetId === agentId) || (install.targetType === "company" && install.targetId === companyId))
      .map((install) => install.connectionId),
  );

  const grants = await db
    .select({ connectionId: connectionGrants.connectionId })
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.subjectAgentId, agentId),
        eq(connectionGrants.status, "active"),
      ),
    );

  const activeCommsConnectionIds = new Set([
    ...installedConnectionIds,
    ...grants.map((g) => g.connectionId),
  ]);

  if (installedConnectionIds.size === 0 && activeCommsConnectionIds.size === 0) {
    return { preserveKeys: new Set(), preserveConnections: new Map(), conflict: false };
  }

  // Check dedicated entries (e.g. comms-board) against both installs and active agent grants
  const dedicatedEntries = DEFAULT_MCP_SPEC.filter((entry) => Boolean(entry.setupHook));
  for (const entry of dedicatedEntries) {
    const commsConnections = await db
      .select({ id: toolConnections.id, name: toolConnections.name })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          ne(toolConnections.status, "archived"),
        ),
      );

    const hasCommsConflict = commsConnections.some(
      (conn) =>
        activeCommsConnectionIds.has(conn.id) &&
        (conn.name === entry.connectionName ||
          conn.name.startsWith(`${entry.connectionName}:`) ||
          conn.name === "comms-board"),
    );

    if (hasCommsConflict) {
      return { preserveKeys: new Set(), preserveConnections: new Map(), conflict: true };
    }
  }

  // Check ordinary entries (e.g. rh-google-mcp, personal rh-mcp) based ONLY on applicable install rows
  const ordinaryEntries = DEFAULT_MCP_SPEC.filter((entry) => !entry.setupHook);
  const preserveKeys = new Set<string>();
  const preserveConnections = new Map<string, string>();

  for (const entry of ordinaryEntries) {
    const candidates = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, entry.connectionName), ne(toolConnections.status, "archived")));
    const relevantInstalled = candidates.filter((candidate) => installedConnectionIds.has(candidate.id));
    if (relevantInstalled.length === 0) continue; // no install touches this entry's connection name
    const candidate = candidates.length === 1 ? candidates[0]! : null;
    const valid = candidate && isValidDefaultMcpTemplate(entry, candidate) ? candidate : null;
    if (valid && relevantInstalled.length === 1 && relevantInstalled[0]!.id === valid.id) {
      preserveKeys.add(entry.key);
      preserveConnections.set(entry.key, valid.id);
    } else {
      // An install exists but points at an ambiguous name collision or a connection that fails the
      // entry's template requirements -- there is no safe way to know this install still means what
      // it used to, so this agent is not enrolled at all rather than guessing.
      return { preserveKeys: new Set(), preserveConnections: new Map(), conflict: true };
    }
  }
  return { preserveKeys, preserveConnections, conflict: false };
}

/**
 * Scans agents in id order (stable, resumable pagination), classifies each one, and -- unless
 * `dryRun` -- enrolls eligible legacy agents through the existing new-agent snapshot/setup hooks.
 * Bounded to `limit` rows per call; callers needing full coverage page with `nextCursor` until it
 * is null. Returns an empty report (no scan) when the feature flag is off.
 */
export async function enrollLegacyAgentsWithDefaultMcp(
  db: Db,
  options: {
    companyId?: string;
    limit?: number;
    afterId?: string;
    dryRun?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LegacyEnrollmentReport> {
  const env = options.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env)) {
    return { scanned: 0, outcomes: [], nextCursor: null };
  }
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_MCP_LEGACY_ENROLLMENT_BATCH_LIMIT, DEFAULT_MCP_LEGACY_ENROLLMENT_BATCH_LIMIT));
  const scope = readDefaultMcpTemplateScope();

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
    .where(
      and(
        options.companyId ? eq(agents.companyId, options.companyId) : undefined,
        options.afterId ? gt(agents.id, options.afterId) : undefined,
      ),
    )
    .orderBy(asc(agents.id))
    .limit(limit);

  const outcomes: LegacyEnrollmentOutcome[] = [];
  for (const row of rows) {
    const classification = classifyDefaultMcpMetadata(row.metadata);
    if (classification === "present") continue; // already enrolled; not an error, not reported
    if (classification === "corrupted") {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "corrupted_existing_state" });
      continue;
    }
    // A terminated agent is the agent-level equivalent of an archived company: excluded from the
    // normal agent listing everywhere else in this service (see `agentService(db).list`), and
    // enrolling it would leave a pending defaultMcp snapshot with no running agent to ever finish
    // setup for it.
    if (row.status === "terminated") {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "agent_terminated" });
      continue;
    }
    if (row.companyStatus === "archived") {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "company_archived" });
      continue;
    }
    if (!isCompanyInDefaultMcpTemplateScope(scope, row.companyId)) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "company_out_of_scope" });
      continue;
    }
    // Resolved before the dry-run short-circuit so a census and a live run agree: a company with no
    // eligible owner reports `owner_required` in both, rather than a dry run promising `would_enroll`
    // for an agent a live run would actually skip.
    const owner = await resolveLegacyResponsibleUser(db, row.companyId, row.id);
    if (!owner) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "owner_required" });
      continue;
    }
    const access = await assessLegacyAccess(db, row.companyId, row.id);
    if (access.conflict) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "legacy_access_conflict" });
      continue;
    }
    if (options.dryRun) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "would_enroll" });
      continue;
    }
    // Row-locked re-check before writing: the pre-scan above is not a snapshot isolation guarantee,
    // so two overlapping batches (or a batch racing the agent's own first heartbeat, a termination,
    // or an approval) could otherwise act on stale metadata, owner membership, access installs or status.
    // Locking here re-reads metadata, status, responsible owner, and access under the row lock.
    // If any precondition is unsatisfied or changed, LegacyPreserveUnsatisfiedError rolls back the
    // transaction atomically with zero writes, preserving private metadata and existing installs.
    try {
      const txResult = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ metadata: agents.metadata, status: agents.status })
          .from(agents)
          .where(eq(agents.id, row.id))
          .limit(1)
          .for("update");
        if (!locked || classifyDefaultMcpMetadata(locked.metadata) !== "absent") return "lost_race" as const;
        if (locked.status === "terminated") return "terminated" as const;

        const lockedOwner = await resolveLegacyResponsibleUser(tx, row.companyId, row.id);
        if (!lockedOwner) {
          throw new LegacyPreserveUnsatisfiedError("owner_required");
        }

        const lockedAccess = await assessLegacyAccess(tx, row.companyId, row.id);
        if (lockedAccess.conflict) {
          throw new LegacyPreserveUnsatisfiedError("legacy_access_conflict");
        }

        await snapshotDefaultMcpForNewAgent(tx, {
          companyId: row.companyId,
          agentId: row.id,
          existingMetadata: locked.metadata,
          ownerUserId: lockedOwner.userId,
          status: locked.status,
          preserveEnabledKeys: lockedAccess.preserveKeys,
          expectedPreserveConnectionIds: lockedAccess.preserveConnections,
        });
        return "enrolled" as const;
      });
      if (txResult === "lost_race") continue; // lost the race or the agent was deleted mid-batch; not an error, not reported
      if (txResult === "terminated") {
        outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "agent_terminated" });
        continue;
      }
      // After the snapshot write commits; setup makes external calls, and the durable 60s sweep
      // (`sweepDefaultMcpSetups`) is the backstop if this process dies before it runs.
      scheduleDefaultMcpSetup(db, { companyId: row.companyId, agentId: row.id }, { env });
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "enrolled" });
    } catch (err) {
      if (err instanceof LegacyPreserveUnsatisfiedError) {
        outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: err.reason });
        continue;
      }
      throw err;
    }
  }

  return {
    scanned: rows.length,
    outcomes,
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

/** Convenience dry-run wrapper: a census with no writes, same classification/skip reasons. */
export async function censusLegacyAgentsPendingDefaultMcp(
  db: Db,
  options: { companyId?: string; limit?: number; afterId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LegacyEnrollmentReport> {
  return enrollLegacyAgentsWithDefaultMcp(db, { ...options, dryRun: true });
}

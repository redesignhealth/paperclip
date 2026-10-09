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
import { and, asc, eq, gt } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { readDefaultMcpTemplateScope, isCompanyInDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  isDefaultMcpSpecEnabled,
  readDefaultMcpState,
} from "./default-mcp-spec.js";
import { scheduleDefaultMcpSetup, snapshotDefaultMcpForNewAgent } from "./default-mcp-setup.js";
import { pickTemplateOwner } from "./default-mcp-template.js";

export const DEFAULT_MCP_LEGACY_ENROLLMENT_BATCH_LIMIT = 25;

export type LegacyEnrollmentSkipReason =
  | "company_archived"
  | "company_out_of_scope"
  | "owner_required"
  | "corrupted_existing_state"
  | "agent_terminated";

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
    const owner = await pickTemplateOwner(db, row.companyId);
    if (!owner) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "owner_required" });
      continue;
    }
    if (options.dryRun) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "would_enroll" });
      continue;
    }
    // Row-locked re-check before writing: the pre-scan above is not a snapshot isolation guarantee,
    // so two overlapping batches (or a batch racing the agent's own first heartbeat, a termination,
    // or an approval) could otherwise act on stale metadata or a stale status. Locking here (same
    // `for("update")` pattern as the company template claim in default-mcp-template.ts) re-reads
    // both metadata and status at lock time: a second caller sees the first caller's write and skips
    // instead of re-snapshotting, and an agent terminated in that same window is skipped rather than
    // enrolled with a stale `status`.
    const txResult = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ metadata: agents.metadata, status: agents.status })
        .from(agents)
        .where(eq(agents.id, row.id))
        .limit(1)
        .for("update");
      if (!locked || classifyDefaultMcpMetadata(locked.metadata) !== "absent") return "lost_race" as const;
      if (locked.status === "terminated") return "terminated" as const;
      await snapshotDefaultMcpForNewAgent(tx, {
        companyId: row.companyId,
        agentId: row.id,
        existingMetadata: locked.metadata,
        ownerUserId: owner.userId,
        status: locked.status,
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

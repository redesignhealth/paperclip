import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, commsWakeConversations, commsWakeEvents, companies, issueComments, issues } from "@paperclipai/db";
import { isAgentAwaitingSetup } from "../modules/agent-lifecycle/index.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { CommsWakeEvent } from "./comms-wake-event.js";
import { readDefaultMcpState } from "./default-mcp-spec.js";
import { ownerEmailFor } from "./default-mcp-owner.js";
import { issueService } from "./issues.js";
import { resolveRoutineResponsibleUserId } from "./routines.js";

/** Origin kind that marks an issue as the carrier of one comms-board conversation. */
export const COMMS_WAKE_ISSUE_ORIGIN_KIND = "comms_board_conversation";
/** Wake reason for a comms-board event. Distinct from `issue_assigned` (resets the session) and from comment reasons. */
export const COMMS_WAKE_REASON = "comms_board_message_received";
const COMMS_WAKE_ACTOR_ID = "comms_board_wake";
const COMMS_BOARD_ENTRY_KEY = "comms-board";
/** Outcome written while one request holds an event; see `claimCommsWakeEvent`. */
export const COMMS_WAKE_PROCESSING = "processing";

type WakeOptions = {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
};

/** The slice of the heartbeat service this module needs; tests pass a stub. */
export type CommsWakeHeartbeat = { wakeup: (agentId: string, opts: WakeOptions) => Promise<unknown> };

export type CommsWakeIssueResult =
  | { status: "accepted"; sessionRef: string }
  | { status: "retry_later"; reason: string }
  | { status: "gone" };

type EventRow = typeof commsWakeEvents.$inferSelect;

type ProcessInput = {
  companyId: string;
  agentId: string;
  event: CommsWakeEvent;
  eventRow: Pick<EventRow, "id" | "issueId" | "commentId">;
};

const GONE_REASONS = new Set(["terminated", "missing", "assignee_terminated"]);
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class MappingRaceError extends Error {}

function isClosed(status: string) {
  return status === "done" || status === "cancelled";
}

function safeCode(value: unknown, fallback: string) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
}

/** Reason code carried by a 409 from the issue or wake services. */
function conflictReason(err: HttpError) {
  const details = (err.details ?? {}) as Record<string, unknown>;
  if (typeof details.reason === "string" && GONE_REASONS.has(details.reason)) return "gone" as const;
  if (typeof details.code === "string" && details.code !== "agent_not_assignable") return safeCode(details.code, "agent_not_runnable");
  if (typeof details.reason === "string") return safeCode(details.reason, "agent_not_runnable");
  if (details.scopeType !== undefined) return "budget_blocked";
  return "agent_not_runnable";
}

/** Text for the pointer comment. It names the conversation and message, never message content. */
export function buildCommsWakeComment(event: CommsWakeEvent) {
  const { kind, conversationId, seq, messageType, senderAgentId } = event.data;
  const closing =
    "Then mark this issue done, even if there was nothing to do; it reopens when the next message arrives.";
  if (kind === "invite") {
    return [
      `New comms-board invitation. Conversation: \`${conversationId}\`.`,
      `You were invited to this conversation by board agent \`${senderAgentId}\`.`,
      "Check your board inbox with your comms-board tools and accept or decline the invitation.",
      closing,
    ].join(" ");
  }
  const type = messageType && SAFE_LABEL.test(messageType) ? messageType : "unknown";
  return [
    `New comms-board message. Conversation: \`${conversationId}\`.`,
    `Message number: \`${seq ?? "unknown"}\`.`,
    `Type: \`${type}\`.`,
    `From board agent: \`${senderAgentId}\`.`,
    "Read the conversation with your comms-board tools for context (earlier messages too, not only this one) and do what the message asks. Reply on the board only if a reply is needed: not just to acknowledge, and not again if you already answered it.",
    closing,
  ].join(" ");
}

const ISSUE_DESCRIPTION =
  "This issue tracks one comms-board conversation. New board messages for this conversation arrive here as comments. " +
  "Read the conversation with your comms-board tools and act on it. Details: `references/comms-board-wake.md` in the paperclip skill.";

export function commsWakeIssueService(db: Db, deps: { heartbeat: CommsWakeHeartbeat }) {
  const issuesSvc = issueService(db);

  /**
   * The conversation owner for system-written wakes: the verified owner frozen on the agent's comms-board entry while
   * they are still an active member of the company, else the company default (the same fallback routines use).
   */
  async function resolveResponsibleUserId(companyId: string, agentId: string) {
    const [agent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    const ownerUserId = readDefaultMcpState(agent?.metadata)?.entries?.[COMMS_BOARD_ENTRY_KEY]?.ownerUserId ?? null;
    if (ownerUserId && (await ownerEmailFor(db, companyId, ownerUserId))) return ownerUserId;
    return resolveRoutineResponsibleUserId(db, companyId, null);
  }

  /**
   * The conversation's mapped issue, and whether it can still carry the conversation: it must exist in this company and
   * still be assigned to this agent. A mapped issue that was reassigned or unassigned is re-homed to a new issue
   * (deletion needs no handling: the mapping row is deleted with the issue).
   */
  async function findMapping(reader: Pick<Db, "select">, companyId: string, agentId: string, boardConversationId: string) {
    const [row] = await reader
      .select({ id: commsWakeConversations.id, issueId: commsWakeConversations.issueId, assigneeAgentId: issues.assigneeAgentId })
      .from(commsWakeConversations)
      .leftJoin(issues, and(eq(issues.id, commsWakeConversations.issueId), eq(issues.companyId, commsWakeConversations.companyId)))
      .where(
        and(
          eq(commsWakeConversations.companyId, companyId),
          eq(commsWakeConversations.agentId, agentId),
          eq(commsWakeConversations.boardConversationId, boardConversationId),
        ),
      );
    if (!row) return null;
    return { id: row.id, issueId: row.issueId, usable: row.assigneeAgentId === agentId };
  }

  /** A board-supplied session reference is only usable if it names an unmapped issue of this agent in this company. */
  async function adoptableIssueId(tx: Pick<Db, "select">, companyId: string, agentId: string, sessionRef: string | null) {
    if (!sessionRef || !UUID.test(sessionRef)) return null;
    const [issue] = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, sessionRef), eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId)));
    if (!issue) return null;
    const [mapped] = await tx
      .select({ id: commsWakeConversations.id })
      .from(commsWakeConversations)
      .where(eq(commsWakeConversations.issueId, issue.id));
    return mapped ? null : issue.id;
  }

  async function findOrCreateIssueId(input: ProcessInput) {
    const { companyId, agentId, event } = input;
    const boardConversationId = event.data.conversationId;
    const existing = await findMapping(db, companyId, agentId, boardConversationId);
    if (existing?.usable) return existing.issueId;

    const responsibleUserId = await resolveResponsibleUserId(companyId, agentId);
    const attempt = () =>
      db.transaction(async (tx) => {
        // Serializes first events for one (agent, conversation); the unique index below is the backstop.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`comms-wake-conversation:${agentId}:${boardConversationId}`}, 0))`,
        );
        const mapped = await findMapping(tx, companyId, agentId, boardConversationId);
        if (mapped?.usable) return mapped.issueId;

        let issueId = await adoptableIssueId(tx, companyId, agentId, event.data.sessionRef);
        if (!issueId) {
          const created = await issuesSvc.create(
            companyId,
            {
              title: `Comms board conversation ${boardConversationId.slice(0, 8)}`,
              description: ISSUE_DESCRIPTION,
              status: "todo",
              assigneeAgentId: agentId,
              originKind: COMMS_WAKE_ISSUE_ORIGIN_KIND,
              originId: boardConversationId,
              actorResponsibleUserId: responsibleUserId,
              // Never deduplicate against another conversation's issue: the mapping table is the identity.
              allowDuplicate: true,
            },
            tx,
          );
          issueId = created.id;
        }
        if (mapped) {
          // Re-home: the previously mapped issue no longer belongs to this agent. It stays with whoever has it.
          await tx
            .update(commsWakeConversations)
            .set({ issueId, updatedAt: new Date() })
            .where(eq(commsWakeConversations.id, mapped.id));
          return issueId;
        }
        const inserted = await tx
          .insert(commsWakeConversations)
          .values({ companyId, agentId, boardConversationId, issueId })
          .onConflictDoNothing({ target: [commsWakeConversations.agentId, commsWakeConversations.boardConversationId] })
          .returning({ id: commsWakeConversations.id });
        if (inserted.length === 0) throw new MappingRaceError();
        return issueId;
      });
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof MappingRaceError)) throw err;
      const winner = await findMapping(db, companyId, agentId, boardConversationId);
      if (!winner) throw err;
      return winner.issueId;
    }
  }

  /** Reopens a closed issue through the issue service, the same status move a board comment on a closed issue makes. */
  async function reopenIfClosed(issueId: string) {
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    if (issue && isClosed(issue.status)) await issuesSvc.update(issueId, { status: "todo" });
  }

  /** One system comment per event: the event row is locked while the comment and its id are written together. */
  async function ensureComment(input: ProcessInput, issueId: string) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ commentId: commsWakeEvents.commentId })
        .from(commsWakeEvents)
        .where(eq(commsWakeEvents.id, input.eventRow.id))
        .for("update");
      if (row?.commentId) {
        // The comment_id foreign key is single-column, so check in code that it is this issue's comment in this company.
        const [own] = await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(and(eq(issueComments.id, row.commentId), eq(issueComments.issueId, issueId), eq(issueComments.companyId, input.companyId)));
        if (own) return own.id;
      }
      const comment = await issuesSvc.addComment(issueId, buildCommsWakeComment(input.event), {}, { authorType: "system" }, tx);
      await tx.update(commsWakeEvents).set({ commentId: comment.id }).where(eq(commsWakeEvents.id, input.eventRow.id));
      return comment.id;
    });
  }

  /** Wakes the agent on the issue with the comment attached, then reads back what the queue did with it. */
  async function wake(input: ProcessInput, issueId: string, commentId: string): Promise<{ queued: true } | { queued: false; reason: string }> {
    const idempotencyKey = `comms-wake:${input.agentId}:${input.event.eventId}`;
    const latest = () =>
      db
        .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)))
        .orderBy(desc(agentWakeupRequests.requestedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

    // A previous attempt that already queued, deferred or coalesced this wake must not wake the agent a second time.
    const [alreadyAccepted] = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
          ne(agentWakeupRequests.status, "skipped"),
          ne(agentWakeupRequests.status, "failed"),
          ne(agentWakeupRequests.status, "cancelled"),
        ),
      )
      .limit(1);
    if (alreadyAccepted) return { queued: true };

    const run = await deps.heartbeat.wakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: COMMS_WAKE_REASON,
      payload: { issueId, commentId, mutation: "comms_board_wake" },
      idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: COMMS_WAKE_ACTOR_ID,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        source: "comms_board.wake",
        wakeReason: COMMS_WAKE_REASON,
      },
    });
    if (run) return { queued: true };
    // A null result is either a skip (agent cannot run now) or a deferral behind an active run; the receipt tells which.
    const receipt = await latest();
    if (!receipt) return { queued: false, reason: "wake_not_recorded" };
    if (receipt.status === "skipped") return { queued: false, reason: safeCode(receipt.reason, "wake_skipped") };
    // Paperclip's own wake request ended without a run: the board must not be told it was accepted.
    if (receipt.status === "failed") return { queued: false, reason: "wake_failed" };
    if (receipt.status === "cancelled") return { queued: false, reason: "wake_cancelled" };
    return { queued: true };
  }

  /** Only the request holding the claim (outcome "processing") may write the outcome, so a late repeat never overwrites it. */
  async function finish(eventRowId: string, patch: Partial<typeof commsWakeEvents.$inferInsert>) {
    await db
      .update(commsWakeEvents)
      .set(patch)
      .where(and(eq(commsWakeEvents.id, eventRowId), eq(commsWakeEvents.outcome, COMMS_WAKE_PROCESSING)));
  }

  /**
   * Nothing is created for an agent that cannot run now: an issue assigned to a paused agent would be picked up by
   * stranded-work recovery and marked blocked. Mirrors the checks the wake queue makes before it accepts a wake.
   */
  async function cannotRunNow(companyId: string, agentId: string): Promise<CommsWakeIssueResult | null> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent) return { status: "gone" };
    const invokability = await evaluateAgentInvokabilityFromDb(db, isAgentAwaitingSetup(agent) ? { ...agent, status: "idle" } : agent);
    if (!invokability.invokable) {
      if (GONE_REASONS.has(invokability.reason)) return { status: "gone" };
      return { status: "retry_later", reason: safeCode(invokability.reason, "agent_not_runnable") };
    }
    const [company] = await db.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
    if (!company || company.status !== "active") return { status: "retry_later", reason: "company.inactive" };
    return null;
  }

  async function process(input: ProcessInput): Promise<CommsWakeIssueResult> {
    let step = "precheck";
    try {
      const blocked = await cannotRunNow(input.companyId, input.agentId);
      if (blocked) {
        await finish(input.eventRow.id, { outcome: blocked.status === "gone" ? "gone" : "retry_later" });
        return blocked;
      }
      step = "issue";
      const issueId = await findOrCreateIssueId(input);
      // The issue_id foreign key is single-column, so check in code that the issue is this agent's, in this company.
      const [ownIssue] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId), eq(issues.assigneeAgentId, input.agentId)));
      if (!ownIssue) {
        await finish(input.eventRow.id, { outcome: "retry_later" });
        return { status: "retry_later", reason: "issue_unavailable" };
      }
      if (input.eventRow.issueId !== issueId) await finish(input.eventRow.id, { issueId });
      step = "reopen";
      await reopenIfClosed(issueId);
      step = "comment";
      const commentId = await ensureComment(input, issueId);
      step = "wake";
      const result = await wake(input, issueId, commentId);
      if (!result.queued) {
        await finish(input.eventRow.id, { outcome: "retry_later" });
        return { status: "retry_later", reason: result.reason };
      }
      await finish(input.eventRow.id, { outcome: "accepted", sessionRef: issueId });
      return { status: "accepted", sessionRef: issueId };
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 404 && step === "wake") {
          await finish(input.eventRow.id, { outcome: "gone" });
          return { status: "gone" };
        }
        if (err.status === 409) {
          const reason = conflictReason(err);
          if (reason === "gone") {
            await finish(input.eventRow.id, { outcome: "gone" });
            return { status: "gone" };
          }
          await finish(input.eventRow.id, { outcome: "retry_later" });
          return { status: "retry_later", reason };
        }
        const code = (err.details as { code?: unknown } | undefined)?.code;
        if (err.status === 422 && code === "responsible_user_unresolved") {
          await finish(input.eventRow.id, { outcome: "retry_later" });
          return { status: "retry_later", reason: "responsible_user_unresolved" };
        }
      }
      // Release the claim so the board's quick retry for a 5xx is processed, not told the event is in progress.
      await finish(input.eventRow.id, { outcome: null }).catch(() => undefined);
      logger.error(
        { agentId: input.agentId, eventId: input.event.eventId, step, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        "comms wake processing failed",
      );
      throw err;
    }
  }

  return { process };
}

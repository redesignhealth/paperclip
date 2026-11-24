import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents, commsWakeEvents, commsWakeRegistrations } from "@paperclipai/db";
import { HttpError, badRequest, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { commsWakeEventSchema } from "./comms-wake-event.js";
import { COMMS_WAKE_PROCESSING, commsWakeIssueService, type CommsWakeHeartbeat } from "./comms-wake-issue.js";
import { parseCommsWakeSecret, precheckCommsWakeHeaders, verifyCommsWakeSignature } from "./comms-wake-signature.js";
import { secretService } from "./secrets.js";

/** Config path recorded on the vault access event when the signing secret is read. */
export const COMMS_WAKE_SECRET_CONFIG_PATH = "comms_wake.signing_secret";

export type CommsWakeResponse =
  | { status: "accepted" | "duplicate"; sessionRef: string | null }
  | { status: "retry_later"; reason: string };

export type CommsWakeRequest = {
  agentId: string;
  rawBody: Buffer | null;
  body: unknown;
  webhookId: string | undefined;
  webhookTimestamp: string | undefined;
  webhookSignature: string | undefined;
  nowMs?: number;
};

/** How long a request may hold an event before another delivery may take it over. */
const COMMS_WAKE_CLAIM_LEASE_MS = 2 * 60 * 1000;

const gone = () => new HttpError(410, "Wake registration not found");

export function commsWakeService(db: Db, deps: { heartbeat: CommsWakeHeartbeat }) {
  const secrets = secretService(db);
  const issueFlow = commsWakeIssueService(db, deps);

  async function loadRegistration(agentId: string) {
    return db
      .select({
        companyId: commsWakeRegistrations.companyId,
        boardAgentId: commsWakeRegistrations.boardAgentId,
        signingSecretId: commsWakeRegistrations.signingSecretId,
      })
      .from(commsWakeRegistrations)
      .where(eq(commsWakeRegistrations.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function receive(input: CommsWakeRequest): Promise<CommsWakeResponse> {
    // An agent id that is not a uuid, an unknown agent and an agent without a
    // registration all produce the same 410.
    if (!z.string().uuid().safeParse(input.agentId).success) throw gone();
    const registration = await loadRegistration(input.agentId);
    if (!registration) throw gone();

    // Cheap checks first: nothing here touches the vault, so unauthenticated junk causes no audited secret read.
    const precheck = input.rawBody
      ? precheckCommsWakeHeaders({
          webhookId: input.webhookId,
          timestamp: input.webhookTimestamp,
          signatureHeader: input.webhookSignature,
          nowMs: input.nowMs,
        })
      : "missing_header";
    if (precheck) {
      logger.warn({ agentId: input.agentId, reason: precheck }, "comms wake rejected");
      throw unauthorized("Invalid webhook signature");
    }

    let secretValue: string;
    try {
      secretValue = await secrets.resolveSecretValue(registration.companyId, registration.signingSecretId, "latest", {
        accessContext: {
          consumerType: "system",
          consumerId: input.agentId,
          configPath: COMMS_WAKE_SECRET_CONFIG_PATH,
          actorType: "system",
          actorId: null,
        },
      });
    } catch (err) {
      logger.error({ agentId: input.agentId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "comms wake signing secret could not be resolved");
      throw new HttpError(500, "Wake signing secret is unavailable");
    }
    const key = parseCommsWakeSecret(secretValue);
    if (!key) {
      logger.error({ agentId: input.agentId }, "comms wake signing secret is not a whsec_ secret");
      throw new HttpError(500, "Wake signing secret is unavailable");
    }

    // Nothing from the body is read or stored before this passes.
    const verified = input.rawBody
      ? verifyCommsWakeSignature({
          key,
          webhookId: input.webhookId,
          timestamp: input.webhookTimestamp,
          signatureHeader: input.webhookSignature,
          rawBody: input.rawBody,
          nowMs: input.nowMs,
        })
      : ({ ok: false, reason: "missing_header" } as const);
    if (!verified.ok) {
      logger.warn({ agentId: input.agentId, reason: verified.reason }, "comms wake rejected");
      throw unauthorized("Invalid webhook signature");
    }

    const claimedEventId = (input.body as { eventId?: unknown } | null)?.eventId;
    if (claimedEventId !== input.webhookId) {
      logger.warn({ agentId: input.agentId, reason: "webhook_id_mismatch" }, "comms wake rejected");
      throw unauthorized("Webhook id does not match the event id");
    }

    const parsed = commsWakeEventSchema.safeParse(input.body);
    if (!parsed.success) {
      throw badRequest("Invalid wake event", parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })));
    }
    const event = parsed.data;
    if (event.data.recipientAgentId !== registration.boardAgentId) {
      logger.warn({ agentId: input.agentId, reason: "recipient_mismatch" }, "comms wake rejected");
      throw unauthorized("Event is not addressed to this agent");
    }

    const [agent] = await db
      .select({ status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, registration.companyId)));
    if (!agent || agent.status === "terminated") throw gone();

    // An event is finished only once its outcome is "accepted". A repeat of an unfinished event (for example one that
    // answered retry_later) is processed again and reuses the issue and comment it already created.
    await db
      .insert(commsWakeEvents)
      .values({
        companyId: registration.companyId,
        agentId: input.agentId,
        eventId: event.eventId,
        kind: event.data.kind,
        reason: event.data.reason,
        boardConversationId: event.data.conversationId,
        seq: event.data.seq,
        messageType: event.data.messageType,
        senderBoardAgentId: event.data.senderAgentId,
        boardSessionRef: event.data.sessionRef,
      })
      .onConflictDoNothing({ target: [commsWakeEvents.agentId, commsWakeEvents.eventId] });
    const readRow = () =>
      db
        .select({
          id: commsWakeEvents.id,
          issueId: commsWakeEvents.issueId,
          commentId: commsWakeEvents.commentId,
          outcome: commsWakeEvents.outcome,
          sessionRef: commsWakeEvents.sessionRef,
        })
        .from(commsWakeEvents)
        .where(and(eq(commsWakeEvents.agentId, input.agentId), eq(commsWakeEvents.eventId, event.eventId)))
        .then((rows) => rows[0]!);
    const row = await readRow();
    if (row.outcome === "accepted") return { status: "duplicate", sessionRef: row.sessionRef };

    // One request at a time processes an event. The claim is the outcome column itself ("processing"), with the
    // received_at column as the lease time so a request that died mid-way does not hold the event forever.
    const leaseCutoff = new Date(Date.now() - COMMS_WAKE_CLAIM_LEASE_MS);
    const [claimed] = await db
      .update(commsWakeEvents)
      .set({ outcome: COMMS_WAKE_PROCESSING, receivedAt: new Date() })
      .where(
        and(
          eq(commsWakeEvents.id, row.id),
          or(
            isNull(commsWakeEvents.outcome),
            and(ne(commsWakeEvents.outcome, "accepted"), ne(commsWakeEvents.outcome, COMMS_WAKE_PROCESSING)),
            and(eq(commsWakeEvents.outcome, COMMS_WAKE_PROCESSING), lt(commsWakeEvents.receivedAt, leaseCutoff)),
          ),
        ),
      )
      .returning({ id: commsWakeEvents.id, issueId: commsWakeEvents.issueId, commentId: commsWakeEvents.commentId });
    if (!claimed) {
      // Another delivery of this event holds it (or finished it just now). Never overwrite its outcome.
      const current = await readRow();
      if (current.outcome === "accepted") return { status: "duplicate", sessionRef: current.sessionRef };
      return { status: "retry_later", reason: "event_in_progress" };
    }

    const result = await issueFlow.process({ companyId: registration.companyId, agentId: input.agentId, event, eventRow: claimed });
    if (result.status === "gone") throw gone();
    return result;
  }

  return { receive };
}

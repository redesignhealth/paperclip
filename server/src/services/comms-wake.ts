import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { commsWakeEvents, commsWakeRegistrations } from "@paperclipai/db";
import { HttpError, badRequest, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { commsWakeEventSchema } from "./comms-wake-event.js";
import { parseCommsWakeSecret, verifyCommsWakeSignature } from "./comms-wake-signature.js";
import { secretService } from "./secrets.js";

/** Config path recorded on the vault access event when the signing secret is read. */
export const COMMS_WAKE_SECRET_CONFIG_PATH = "comms_wake.signing_secret";

export type CommsWakeResponse = { status: "accepted" | "duplicate"; sessionRef: string | null };

export type CommsWakeRequest = {
  agentId: string;
  rawBody: Buffer | null;
  body: unknown;
  webhookId: string | undefined;
  webhookTimestamp: string | undefined;
  webhookSignature: string | undefined;
  nowMs?: number;
};

const gone = () => new HttpError(410, "Wake registration not found");

export function commsWakeService(db: Db) {
  const secrets = secretService(db);

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

    const inserted = await db
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
      .onConflictDoNothing({ target: [commsWakeEvents.agentId, commsWakeEvents.eventId] })
      .returning({ id: commsWakeEvents.id });
    if (inserted.length > 0) return { status: "accepted", sessionRef: null };

    const existing = await db
      .select({ sessionRef: commsWakeEvents.sessionRef })
      .from(commsWakeEvents)
      .where(and(eq(commsWakeEvents.agentId, input.agentId), eq(commsWakeEvents.eventId, event.eventId)))
      .then((rows) => rows[0] ?? null);
    return { status: "duplicate", sessionRef: existing?.sessionRef ?? null };
  }

  return { receive };
}

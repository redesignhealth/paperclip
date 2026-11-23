import { z } from "zod";

/** Wake event body sent by the comms board. Unknown extra fields are ignored. */
export const commsWakeEventSchema = z.object({
  eventId: z.string().uuid(),
  name: z.literal("comms.wake"),
  timestamp: z.string().datetime({ offset: true }),
  data: z.object({
    kind: z.enum(["message", "invite"]),
    recipientAgentId: z.string().uuid(),
    conversationId: z.string().uuid(),
    seq: z.number().int().nullable(),
    messageType: z.string().nullable(),
    senderAgentId: z.string().uuid(),
    sessionRef: z.string().max(255).nullable(),
    reason: z.enum(["rule", "open_conversation"]),
  }),
  cursor: z.unknown().optional(),
});

export type CommsWakeEvent = z.infer<typeof commsWakeEventSchema>;

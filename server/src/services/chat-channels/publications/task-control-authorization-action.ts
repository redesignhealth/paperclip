import { and, eq } from "drizzle-orm";
import { chatActions } from "@paperclipai/db";
import type { DbOrTransaction } from "../runtime-types.js";

type SelectableDb = Pick<DbOrTransaction, "select">;

/**
 * Reads the issued task-control authorization action for a publication.
 *
 * A closed or deleted conversation yields no conversation row. Querying
 * `chat_actions.conversation_id` (a uuid column) with an empty-string
 * placeholder then raises `invalid input syntax for type uuid: ""` on every
 * publication retry. Return null before touching the database instead.
 */
export async function findIssuedTaskControlAuthorizationAction(
  tx: SelectableDb,
  input: {
    companyId: string;
    endpointId: string;
    conversationId: string | null | undefined;
    publicationId: string;
  },
) {
  if (!input.conversationId) return null;
  return tx
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, input.companyId),
        eq(chatActions.endpointId, input.endpointId),
        eq(chatActions.conversationId, input.conversationId),
        eq(chatActions.kind, "task_control_authorization"),
        eq(chatActions.providerActionId, `task-control-authorization:${input.publicationId}`),
        eq(chatActions.status, "issued"),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
}

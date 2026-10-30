import { object, slackClient } from "../../connectors/slack-client.js";
import { logger } from "../../../middleware/logger.js";

// Users with no usable email are not re-queried on every guest message.
const MISS_TTL_MS = 10 * 60 * 1000;
const misses = new Map<string, number>();
export function resetSlackEmailMissCache() {
  misses.clear();
}

function directoryToken(workspaceId: string): string | null {
  const raw = process.env.PAPERCLIP_SLACK_DIRECTORY_TOKENS;
  if (!raw) return null;
  try {
    const token = object(JSON.parse(raw))[workspaceId];
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    logger.warn("PAPERCLIP_SLACK_DIRECTORY_TOKENS is not valid JSON");
    return null;
  }
}

/**
 * Looks up a Slack user's email through the workspace directory app. Returns
 * the lowercased email only for a real, active human in that workspace. Fails
 * closed: any error, missing token, or disabled flag yields null.
 */
export async function resolveSlackEmail(input: {
  workspaceId: string;
  slackUserId: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  if (process.env.PAPERCLIP_SLACK_EMAIL_MATCH_ENABLED !== "true") return null;
  const token = directoryToken(input.workspaceId);
  if (!token) {
    logger.debug({ workspaceId: input.workspaceId }, "No Slack directory token for workspace");
    return null;
  }
  const missKey = `${input.workspaceId}:${input.slackUserId}`;
  if ((misses.get(missKey) ?? 0) > Date.now()) return null;
  try {
    const user = object((await slackClient(token, input.fetchImpl)("users.info", { user: input.slackUserId })).user);
    const email = object(user.profile).email;
    if (
      user.id !== input.slackUserId ||
      user.deleted === true ||
      user.is_bot === true ||
      user.is_app_user === true ||
      (user.team_id !== undefined && user.team_id !== input.workspaceId) ||
      typeof email !== "string" ||
      email.length === 0
    ) {
      misses.set(missKey, Date.now() + MISS_TTL_MS);
      return null;
    }
    return email.toLowerCase();
  } catch (error) {
    logger.warn({ workspaceId: input.workspaceId, code: object(object(error).details).code }, "Slack directory lookup failed");
    return null;
  }
}

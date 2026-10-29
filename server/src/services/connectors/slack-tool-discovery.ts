import type { Db } from "@paperclipai/db";
import { resolveSlackTaskAuthorization, slackEndpointCandidates, SLACK_ENDPOINT_SELECTION_REQUIRED, SLACK_TASK_AUTHORIZATION_DENIED, type SlackTaskBinding } from "./slack-authority.js";
import { CHAT_REQUESTER_AUTHORIZATION_CHANGED } from "../chat-channels/run-origin.js";
import { slackEnabledToolsForEndpoint } from "./slack-opt-ins.js";
import { ensureSlackBotCatalogCurrent, slackActiveCatalogToolNames } from "./slack-catalog.js";

/** Only source-tagged eligibility denials are quiet; infrastructure faults propagate. */
export function isSlackAuthorizationDenial(error: unknown): error is { status: 403; details?: unknown } {
  if (error === null || typeof error !== "object" || !("status" in error) || error.status !== 403) return false;
  const details = ("details" in error ? error.details : undefined) as { code?: unknown } | undefined;
  return [SLACK_ENDPOINT_SELECTION_REQUIRED, SLACK_TASK_AUTHORIZATION_DENIED,
    CHAT_REQUESTER_AUTHORIZATION_CHANGED, "chat_action_authorization_changed",
    "run_identity_not_active", "run_task_identity_invalid"].some(code => code === details?.code);
}

/**
 * Discovery uses dispatch authority, refreshing each authorized endpoint before
 * reading its callable catalog. Ambiguous ordinary tasks see the union, never a
 * grant on a different endpoint. A denied candidate contributes nothing, without
 * discarding other candidates; real faults reach the logged fail-closed boundary.
 */
export async function slackToolNamesForAgent(
  db: Db,
  binding: Pick<SlackTaskBinding, "companyId" | "agentId" | "endpointId" | "identityContextId"> &
    Partial<Pick<SlackTaskBinding, "runId" | "issueId">>,
): Promise<Set<string>> {
  if (!binding.runId || !binding.issueId) return new Set();
  const task = { ...binding, runId: binding.runId, issueId: binding.issueId };
  const namesFor = async (authority: Awaited<ReturnType<typeof resolveSlackTaskAuthorization>>) => {
    await ensureSlackBotCatalogCurrent(db, authority.endpoint, authority.userId);
    const enabled = await slackEnabledToolsForEndpoint(db, authority.endpoint);
    const activeNames = await slackActiveCatalogToolNames(db, authority.endpoint);
    return enabled.filter(tool => activeNames.has(tool.name)).map(tool => tool.name);
  };
  try {
    return new Set(await namesFor(await resolveSlackTaskAuthorization(db, task)));
  } catch (error) {
    if (!isSlackAuthorizationDenial(error)) throw error;
    if (binding.endpointId || (error.details as { code?: string } | undefined)?.code !== SLACK_ENDPOINT_SELECTION_REQUIRED)
      return new Set();
  }
  const names = new Set<string>();
  for (const candidate of await slackEndpointCandidates(db, task)) {
    try {
      const authority = await resolveSlackTaskAuthorization(db, { ...task, endpointId: candidate.id });
      for (const name of await namesFor(authority)) names.add(name);
    } catch (error) {
      if (!isSlackAuthorizationDenial(error)) throw error;
    }
  }
  return names;
}

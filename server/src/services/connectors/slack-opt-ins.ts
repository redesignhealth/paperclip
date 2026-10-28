import { and, eq, inArray } from "drizzle-orm";
import { chatEndpoints, type Db } from "@paperclipai/db";
import {
  SLACK_TOOLS,
  SLACK_OPT_IN_BOT_SCOPE_GROUPS,
  isSlackToolEnabledForOptIns,
  slackOptInGroupsForTool,
  slackOptInGroupsForSetup,
  slackRequestedOptInGroups,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { forbidden } from "../../errors.js";

/**
 * TECH-7988: the opt-in groups that decide which Slack tools an endpoint may
 * use. Reads only persisted endpoint setup, so every caller sees the same
 * answer without touching Slack.
 */
export type SlackSetupOptIns = {
  slackOptInScopeGroups?: readonly SlackOptInScopeGroup[];
  slackInstalledOptInScopeGroups?: readonly SlackOptInScopeGroup[];
};

export function slackEndpointOptInGroups(
  setup: SlackSetupOptIns | null | undefined,
): SlackOptInScopeGroup[] {
  return slackOptInGroupsForSetup(setup);
}

/** The groups the operator requested, used for install-time scope verification. */
export function slackEndpointRequestedOptInGroups(
  setup: SlackSetupOptIns | null | undefined,
): SlackOptInScopeGroup[] {
  return slackRequestedOptInGroups(setup);
}

export function isSlackToolEnabledForSetup(
  setup: SlackSetupOptIns | null | undefined,
  tool: { name: string; scopes: readonly string[] },
): boolean {
  return isSlackToolEnabledForOptIns(tool, slackEndpointOptInGroups(setup));
}

/**
 * Fail closed before any Slack API call: a tool whose scopes this agent never
 * requested is rejected here rather than surfacing as a Slack `missing_scope`
 * at call time.
 */
export function assertSlackToolEnabledForSetup(
  setup: SlackSetupOptIns | null | undefined,
  toolName: string,
): void {
  const tool = SLACK_TOOLS.find((entry) => entry.name === toolName);
  if (!tool || isSlackToolEnabledForSetup(setup, tool)) return;
  const groups = slackOptInGroupsForTool(tool);
  const labels = groups
    .map((group) => SLACK_OPT_IN_BOT_SCOPE_GROUPS[group].label)
    .join(", ");
  throw forbidden(
    `${toolName} is not enabled for this agent. Enable ${labels} in the agent's Slack setup, then reconnect so Slack grants the new permissions.`,
    { code: "slack_tool_not_enabled", groups },
  );
}

/** Scope-based check for a catalog entry, independent of endpoint plumbing. */
export { isSlackToolEnabledForOptIns };

/** The tools an endpoint with these opt-ins may use, for catalog/capability listing. */
export function slackEnabledToolsForSetup(setup: SlackSetupOptIns | null | undefined) {
  const groups = slackEndpointOptInGroups(setup);
  return SLACK_TOOLS.filter((tool) => isSlackToolEnabledForOptIns(tool, groups));
}

/**
 * The Slack tools an agent's endpoints currently enable, unioned across its
 * active Slack connections. Used where tool definitions are assembled for a run
 * rather than for one addressed endpoint.
 */
export async function slackToolNamesForAgent(
  db: Db,
  binding: { companyId: string; agentId: string; endpointId?: string },
): Promise<Set<string>> {
  const rows = await db
    .select({ setup: chatEndpoints.setup })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, binding.companyId),
        eq(chatEndpoints.assignedAgentId, binding.agentId),
        eq(chatEndpoints.provider, "slack"),
        inArray(chatEndpoints.status, ["active", "verifying"]),
        ...(binding.endpointId
          ? [eq(chatEndpoints.id, binding.endpointId)]
          : []),
      ),
    );
  const enabled = new Set<string>();
  for (const row of rows) {
    for (const tool of slackEnabledToolsForSetup(row.setup)) enabled.add(tool.name);
  }
  return enabled;
}

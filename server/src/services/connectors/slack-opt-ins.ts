import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, type Db } from "@paperclipai/db";
import {
  SLACK_TOOLS,
  SLACK_OPT_IN_BOT_SCOPE_GROUPS,
  isSlackToolEnabledForOptIns,
  slackOptInGroupsForSetup,
  slackOptInGroupsForTool,
  slackRequestedOptInGroups,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { forbidden } from "../../errors.js";

/**
 * TECH-7988: the opt-in groups that decide which Slack tools an endpoint may
 * use. Gating reads only what the live install holds, so a requested but not
 * yet installed group exposes no tools.
 */
export type SlackSetupOptIns = {
  slackOptInScopeGroups?: readonly SlackOptInScopeGroup[];
  slackInstalledOptInScopeGroups?: readonly SlackOptInScopeGroup[];
};

type SlackGatingOptions = { legacyInstall?: boolean };

/** A database handle or transaction; both support the reads below. */
type SlackReadExecutor = Pick<Db, "select">;

export function slackEndpointOptInGroups(
  setup: SlackSetupOptIns | null | undefined,
  options?: SlackGatingOptions,
): SlackOptInScopeGroup[] {
  return slackOptInGroupsForSetup(setup, options);
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
  options?: SlackGatingOptions,
): boolean {
  return isSlackToolEnabledForOptIns(tool, slackEndpointOptInGroups(setup, options));
}

/**
 * Fail closed before any Slack API call: a tool whose scopes this agent does
 * not have installed is rejected here rather than surfacing as a Slack
 * `missing_scope` at call time. An unknown tool name is rejected too, so a
 * caller cannot fall through to a `SLACK_TOOLS.find(...)` assertion.
 */
export function assertSlackToolEnabledForSetup(
  setup: SlackSetupOptIns | null | undefined,
  toolName: string,
  options?: SlackGatingOptions,
): void {
  const tool = SLACK_TOOLS.find((entry) => entry.name === toolName);
  if (!tool)
    throw forbidden(`Unknown Slack tool: ${toolName}`, {
      code: "slack_tool_unknown",
    });
  if (isSlackToolEnabledForSetup(setup, tool, options)) return;
  const groups = slackOptInGroupsForTool(tool);
  const labels = groups
    .map((group) => SLACK_OPT_IN_BOT_SCOPE_GROUPS[group].label)
    .join(", ");
  throw forbidden(
    groups.length > 0
      ? `${toolName} is not enabled for this agent. Enable ${labels} in the agent's Slack setup, then reconnect so Slack grants the new permissions.`
      : `${toolName} is not enabled for this agent.`,
    { code: "slack_tool_not_enabled", groups },
  );
}

/** Scope-based check for a catalog entry, independent of endpoint plumbing. */
export { isSlackToolEnabledForOptIns };

/** The tools an endpoint with these installed groups may use. */
export function slackEnabledToolsForSetup(
  setup: SlackSetupOptIns | null | undefined,
  options?: SlackGatingOptions,
) {
  const groups = slackEndpointOptInGroups(setup, options);
  return SLACK_TOOLS.filter((tool) => isSlackToolEnabledForOptIns(tool, groups));
}

/** True when the requested groups differ from what the install holds. */
export function slackEndpointOptInsChanged(
  setup: SlackSetupOptIns | null | undefined,
  options?: SlackGatingOptions,
): boolean {
  const requested = slackRequestedOptInGroups(setup);
  const installed = slackEndpointOptInGroups(setup, options);
  return JSON.stringify([...requested].sort()) !== JSON.stringify([...installed].sort());
}

/**
 * Which endpoints were already installed before per-agent opt-ins existed.
 *
 * The legacy full-grant fallback must never apply to a brand-new endpoint, so
 * it is keyed on a prior Slack registration/install rather than on the mere
 * absence of the setup fields.
 */
export async function slackLegacyInstallEndpoints(
  db: SlackReadExecutor,
  input: { companyId: string; agentId?: string; endpointIds?: readonly string[] },
): Promise<Set<string>> {
  const ids = input.endpointIds?.filter(Boolean) ?? [];
  if (input.endpointIds && ids.length === 0) return new Set();
  const rows = await db
    .select({ endpointId: chatSlackRegistrations.endpointId })
    .from(chatSlackRegistrations)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.id, chatSlackRegistrations.endpointId),
        eq(chatEndpoints.companyId, chatSlackRegistrations.companyId),
        eq(chatEndpoints.companyId, input.companyId),
      ),
    )
    .where(
      and(
        eq(chatSlackRegistrations.companyId, input.companyId),
        isNotNull(chatSlackRegistrations.appId),
        ne(chatSlackRegistrations.status, "removed"),
        // A prior successful install: the registration is configured, or bot
        // credentials were already bound. A draft that merely created an app
        // (status `install`) has never been installed.
        or(
          eq(chatSlackRegistrations.status, "configured"),
          isNotNull(chatSlackRegistrations.botUserId),
          isNotNull(chatEndpoints.botExternalId),
        ),
        ...(input.agentId ? [eq(chatEndpoints.assignedAgentId, input.agentId)] : []),
        ...(input.endpointIds ? [inArray(chatSlackRegistrations.endpointId, ids)] : []),
      ),
    );
  return new Set(rows.map((row) => row.endpointId));
}

export async function slackLegacyInstall(
  db: SlackReadExecutor,
  input: { companyId: string; endpointId: string },
): Promise<boolean> {
  return (await slackLegacyInstallEndpoints(db, {
    companyId: input.companyId,
    endpointIds: [input.endpointId],
  })).has(input.endpointId);
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
    .select({ id: chatEndpoints.id, setup: chatEndpoints.setup })
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
  const legacy = await slackLegacyInstallEndpoints(db, {
    companyId: binding.companyId,
    agentId: binding.agentId,
    endpointIds: rows.map((row) => row.id),
  });
  const enabled = new Set<string>();
  for (const row of rows) {
    for (const tool of slackEnabledToolsForSetup(row.setup, {
      legacyInstall: legacy.has(row.id),
    }))
      enabled.add(tool.name);
  }
  return enabled;
}

/** Gating for one already-loaded endpoint, resolving its legacy install. */
export async function slackEndpointOptInsForGating(
  db: Db,
  endpoint: { id: string; companyId: string; setup: SlackSetupOptIns | null },
): Promise<SlackGatingOptions> {
  if (
    endpoint.setup?.slackInstalledOptInScopeGroups !== undefined ||
    endpoint.setup?.slackOptInScopeGroups !== undefined
  )
    return {};
  return {
    legacyInstall: await slackLegacyInstall(db, {
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
    }),
  };
}

/** Capability/tool listing that must match runtime gating exactly. */
export async function slackEnabledToolsForEndpoint(
  db: Db,
  endpoint: { id: string; companyId: string; setup: SlackSetupOptIns | null },
) {
  return slackEnabledToolsForSetup(
    endpoint.setup,
    await slackEndpointOptInsForGating(db, endpoint),
  );
}

import { and, eq } from "drizzle-orm";
import { chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import {
  SLACK_TOOLS,
  slackBotScopes,
  type SlackToolCapabilities,
} from "@paperclipai/shared";
import { notFound } from "../../errors.js";
import { secretService } from "../secrets.js";
import { slackClient } from "./slack-client.js";
import {
  slackEnabledToolsForSetup,
  slackEndpointRequestedOptInGroups,
} from "./slack-opt-ins.js";
export async function slackCapabilities(
  db: Db,
  companyId: string,
  endpointId: string,
): Promise<SlackToolCapabilities> {
  const [row] = await db
    .select({ endpoint: chatEndpoints, connection: toolConnections })
    .from(chatEndpoints)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, chatEndpoints.connectionId),
        eq(toolConnections.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(chatEndpoints.companyId, companyId),
        eq(chatEndpoints.id, endpointId),
        eq(chatEndpoints.provider, "slack"),
      ),
    );
  if (
    !row ||
    !row.connection.enabled ||
    !["active", "verifying"].includes(row.endpoint.status)
  )
    throw notFound("Active Slack connection not found");
  const ref = row.connection.credentialSecretRefs.find(
    (r) => r.configPath === "credentials.botToken",
  );
  if (!ref) throw notFound("Slack bot credential is unavailable");
  const token = await secretService(db).resolveSecretValue(
    companyId,
    ref.secretId,
    ref.versionSelector ?? "latest",
    {
      consumerType: "tool_connection",
      consumerId: row.connection.id,
      configPath: ref.configPath,
      actorType: "system",
      actorId: null,
    },
  );
  const auth = await slackClient(token)("auth.test");
  const scopes = Array.isArray(auth.grantedScopes)
    ? auth.grantedScopes.filter((s): s is string => typeof s === "string")
    : null;
  // Only the scopes this endpoint's manifest requested are "required" here.
  // A correctly trimmed install must show no missing scopes.
  const requested = slackBotScopes(
    slackEndpointRequestedOptInGroups(row.endpoint.setup),
  );
  // Only tools this agent opted into are offered at all; the rest are hidden,
  // not merely unavailable.
  const enabledTools = new Set(
    slackEnabledToolsForSetup(row.endpoint.setup).map((tool) => tool.name),
  );
  return {
    grantedScopes: scopes,
    missingScopes: scopes
      ? requested.filter((scope) => !scopes.includes(scope))
      : [],
    tools: SLACK_TOOLS.filter((t) => enabledTools.has(t.name)).map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      available:
        t.name === "slack_search"
          ? true
          : scopes
            ? t.scopes.every((s) =>
                s.split("|").some((scope) => scopes.includes(scope)),
              )
            : null,
    })),
  };
}

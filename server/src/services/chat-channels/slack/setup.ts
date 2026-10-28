import { slackCommandForAgent } from "./commands.js";
import { canonicalCallbackUrl, slackCallbackMatchesPublicUrl } from "./callback-verification.js";
import type { EndpointRow, SlackCallbackSurface, InternalSetupState } from "../runtime-types.js";
import { isSlackLegacyInstall } from "../../connectors/slack-opt-ins.js";

import {
  slackOptInGroupsForSetup,
  type ChatEndpointCallbackSurfaces,
} from "@paperclipai/shared";

export function slackSetupState(input: {
  endpoint: Pick<
    EndpointRow,
    | "provider"
    | "providerAccountId"
    | "publicId"
    | "status"
    | "setup"
    | "botUsername"
    | "botExternalId"
  >;
  webhookUrl: string | null;
  step: EndpointRow["setup"]["step"];
  assignedAgentName?: string | null;
}) {
  const { endpoint, webhookUrl, step, assignedAgentName } = input;

      const observations = (endpoint.setup as InternalSetupState)
        .slackCallbackSurfaces;
      const currentUrl = webhookUrl ? canonicalCallbackUrl(webhookUrl) : null;
      const surfaceState = (
        surface: SlackCallbackSurface,
      ): ChatEndpointCallbackSurfaces[SlackCallbackSurface] => {
        const observation = observations?.[surface];
        if (!observation) return { status: "unverified" };
        return {
          status:
            currentUrl !== null &&
            slackCallbackMatchesPublicUrl(observation.url, currentUrl)
              ? "current"
              : "stale",
          observedAt: observation.observedAt,
        };
      };
      // Never synthesize an installed set here: a value means Slack actually
      // granted those groups. Only a row that predates per-agent opt-ins *and*
      // has a real bot installed projects the implied full grant as its
      // request, so the UI does not invite a needless reconnect. A brand-new
      // endpoint projects nothing. `isSlackLegacyInstall` is the same
      // definition verification, gating and persistence use.
      const legacyInstall = isSlackLegacyInstall(endpoint);
      const requestedOptInGroups = legacyInstall
        ? slackOptInGroupsForSetup(endpoint.setup, { legacyInstall: true })
        : undefined;
      const callbackSurfaces: ChatEndpointCallbackSurfaces = {
        events: surfaceState("events"),
        interactivity: surfaceState("interactivity"),
        slashCommands: surfaceState("slashCommands"),
      };
      return {
        step,
        testStartedAt: endpoint.setup.testStartedAt ?? null,
        testSkipped: endpoint.setup.testSkipped ?? false,
        authorizationUrl: "https://api.slack.com/apps?new_app=1",
        providerUrl: "https://app.slack.com/",
        webhookUrl,
        webhookVerifiedAt: endpoint.setup.webhookVerifiedAt ?? null,
        callbackSurfaces,
        callbacksNeedUpdate: Object.values(callbackSurfaces).some(
          (surface) => surface.status === "stale",
        ),
        slackApp: endpoint.setup.slackApp,
        slackSetupMethod: endpoint.setup.slackSetupMethod,
        slackAvatar: endpoint.setup.slackAvatar,
        slackManagerError: endpoint.setup.slackManagerError,
        slackAccount: endpoint.setup.slackAccount,
        slackOptInScopeGroups: endpoint.setup.slackOptInScopeGroups ?? requestedOptInGroups,
        slackInstalledOptInScopeGroups: endpoint.setup.slackInstalledOptInScopeGroups,
        // Slack registers the slash command in the provider configuration.
        // Keep that identity immutable when the assigned agent is renamed;
        // deriving it remains only a compatibility path for older rows.
        command:
          typeof endpoint.setup.command === "string"
            ? endpoint.setup.command
            : assignedAgentName
              ? slackCommandForAgent(assignedAgentName, endpoint.publicId)
              : null,
      } as const;

}

import type { ResolvedChatSdkProviderConfig } from "../../chat-sdk-runtime.js";

export function slackRuntimeConfig(endpoint: EndpointRow, userName: string, credentials: Record<string, string>): ResolvedChatSdkProviderConfig {
  return {
        provider: "slack",
        userName,
        credentials: {
          botToken: credentials.botToken,
          signingSecret: credentials.signingSecret,
          botUserId: endpoint.botExternalId ?? undefined,
        },
      };
}

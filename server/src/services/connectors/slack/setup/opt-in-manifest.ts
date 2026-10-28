import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, type Db } from "@paperclipai/db";
import {
  buildSlackAppManifest,
  slackAppConfigurationSchema,
  slackManifestBotScopes,
  slackOptInGroupsFromScopes,
  slackRequestedOptInGroups,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { conflict } from "../../../../errors.js";
import { object } from "./provider-client.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | DbTransaction;

/**
 * TECH-7988: an opt-in change after the app exists can only take effect through
 * a Slack manifest update followed by a reinstall. Rather than inventing a
 * parallel mechanism, rewrite the registration's stored manifest and mark it
 * `slack_manifest_update_pending` -- exactly the state the existing
 * configuration-token retry and managed reconnect paths already resolve.
 *
 * The prior installation keeps its granted scopes until the reinstall lands
 * (see `slackOptInGroupsForSetup`), so a pending change never silently drops
 * live access.
 */
export async function applySlackOptInManifestChange(
  executor: Executor,
  input: {
    endpointId: string;
    companyId: string;
    agentName: string;
    app: unknown;
    setup: { slackOptInScopeGroups?: readonly SlackOptInScopeGroup[] };
  },
): Promise<void> {
  const [row] = await executor
    .select()
    .from(chatSlackRegistrations)
    .where(eq(chatSlackRegistrations.endpointId, input.endpointId));
  if (!row?.appId || row.status === "removed") return;
  const eventUrl = object(object(row.manifest.settings).event_subscriptions)
    .request_url;
  if (typeof eventUrl !== "string" || !eventUrl)
    throw conflict(
      "The saved Slack app manifest is unavailable. Resume Slack setup to update its permissions.",
    );
  const app = slackAppConfigurationSchema.parse(input.app);
  const manifest = buildSlackAppManifest({
    app,
    agentName: input.agentName,
    webhookUrl: eventUrl,
    redirectUri: row.callbackUri,
    optInScopeGroups: slackRequestedOptInGroups(input.setup),
  });
  const manifestHash = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  if (manifestHash === row.manifestHash) return;
  await executor
    .update(chatSlackRegistrations)
    .set({
      manifest,
      manifestHash,
      errorCode: "slack_manifest_update_pending",
      updatedAt: new Date(),
    })
    .where(eq(chatSlackRegistrations.endpointId, input.endpointId));
}

/**
 * TECH-7988: record which opt-in groups the live installation actually
 * requested once its manifest is applied and Slack grants it. From here on a
 * further opt-in change is a pending difference, not a silent scope drop.
 */
export async function recordInstalledSlackOptIns(
  executor: Executor,
  input: { endpointId: string; companyId: string; manifest: unknown },
): Promise<void> {
  const installed = slackOptInGroupsFromScopes(
    slackManifestBotScopes(input.manifest),
  );
  const [row] = await executor
    .select({ setup: chatEndpoints.setup })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.id, input.endpointId),
        eq(chatEndpoints.companyId, input.companyId),
      ),
    );
  if (!row) return;
  // An absent field means "legacy, full grant", so an empty install must still
  // be recorded explicitly.
  const recorded = row.setup.slackInstalledOptInScopeGroups;
  if (recorded && JSON.stringify(recorded) === JSON.stringify(installed)) return;
  await executor
    .update(chatEndpoints)
    .set({
      setup: { ...row.setup, slackInstalledOptInScopeGroups: installed },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatEndpoints.id, input.endpointId),
        eq(chatEndpoints.companyId, input.companyId),
      ),
    );
}

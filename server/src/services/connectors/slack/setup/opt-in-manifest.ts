import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, type Db } from "@paperclipai/db";
import {
  buildSlackAppManifest,
  slackAppConfigurationSchema,
  slackOptInGroupsFromScopes,
  slackRequestedOptInGroups,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { conflict } from "../../../../errors.js";
import { object } from "./provider-client.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | DbTransaction;

/**
 * Bind an OAuth install attempt to the exact manifest it was started with.
 * `install()` records this on the state row; a callback whose registration
 * manifest has since changed is rejected rather than recording a grant the
 * user never approved.
 */
export function slackInstallManifestHash(manifest: unknown): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

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
 * TECH-7988: record which opt-in groups the live installation actually holds.
 *
 * Derived only from the scopes Slack granted the token -- never from the
 * manifest, which is a request and can change while an OAuth attempt is in
 * flight. Callers must pass a grant read from `auth.test`/`oauth.v2.access`
 * after the runtime accepted the credentials. A group counts as installed only
 * when all of its scopes were granted, so a partial grant leaves its tools
 * gated.
 */
export async function recordInstalledSlackOptIns(
  executor: Executor,
  input: { endpointId: string; companyId: string; grantedScopes: readonly string[] },
): Promise<void> {
  const installed = slackOptInGroupsFromScopes(input.grantedScopes);
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

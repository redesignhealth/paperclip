import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, type Db } from "@paperclipai/db";
import {
  buildSlackAppManifest,
  slackAppConfigurationSchema,
  slackOptInGroupsForSetup,
  slackOptInGroupsFromScopes,
  slackRequestedOptInGroups,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { conflict } from "../../../../errors.js";
import { object } from "./provider-client.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | DbTransaction;

/**
 * Stable, key-order-independent JSON. `chat_slack_registrations.manifest` is
 * JSONB, which does not preserve key order on read, so a plain stringify can
 * produce a false mismatch and reject a perfectly valid callback.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Bind an OAuth install attempt to the exact manifest it was started with.
 * `install()` records this on the state row; a callback whose registration
 * manifest has since changed is rejected rather than recording a grant the
 * user never approved.
 */
export function slackInstallManifestHash(manifest: unknown): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
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
 * live access. Toggling the request back to the installed set clears the
 * pending marker again, so an abandoned change cannot block installation.
 */
export async function applySlackOptInManifestChange(
  executor: Executor,
  input: {
    endpointId: string;
    companyId: string;
    agentName: string;
    app: unknown;
    setup: {
      slackOptInScopeGroups?: readonly SlackOptInScopeGroup[];
      slackInstalledOptInScopeGroups?: readonly SlackOptInScopeGroup[];
    };
  },
): Promise<void> {
  const [row] = await executor
    .select()
    .from(chatSlackRegistrations)
    .where(
      and(
        eq(chatSlackRegistrations.endpointId, input.endpointId),
        eq(chatSlackRegistrations.companyId, input.companyId),
      ),
    );
  if (!row?.appId || row.status === "removed") return;
  const eventUrl = object(object(row.manifest.settings).event_subscriptions)
    .request_url;
  if (typeof eventUrl !== "string" || !eventUrl)
    throw conflict(
      "The saved Slack app manifest is unavailable. Resume Slack setup to update its permissions.",
    );
  const requested = slackRequestedOptInGroups(input.setup);
  const installed = slackOptInGroupsForSetup(input.setup);
  const unchanged =
    JSON.stringify([...requested].sort()) ===
    JSON.stringify([...installed].sort());
  const app = slackAppConfigurationSchema.parse(input.app);
  const manifest = buildSlackAppManifest({
    app,
    agentName: input.agentName,
    webhookUrl: eventUrl,
    redirectUri: row.callbackUri,
    optInScopeGroups: requested,
  });
  const manifestHash = slackInstallManifestHash(manifest);
  if (unchanged) {
    // Requested groups now match what Slack already granted. Restore the saved
    // manifest and clear the pending marker so installs are not blocked.
    if (row.manifestHash === manifestHash && row.errorCode !== "slack_manifest_update_pending") return;
    await executor
      .update(chatSlackRegistrations)
      .set({
        manifest,
        manifestHash,
        // Restore the pre-pending status: a configured app is installable
        // again, while a draft stays in its own creation stage.
        ...(row.errorCode === "slack_manifest_update_pending"
          ? { errorCode: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatSlackRegistrations.endpointId, input.endpointId),
          eq(chatSlackRegistrations.companyId, input.companyId),
        ),
      );
    return;
  }
  if (manifestHash === row.manifestHash && row.errorCode === "slack_manifest_update_pending") return;
  await executor
    .update(chatSlackRegistrations)
    .set({
      manifest,
      manifestHash,
      errorCode: "slack_manifest_update_pending",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatSlackRegistrations.endpointId, input.endpointId),
        eq(chatSlackRegistrations.companyId, input.companyId),
      ),
    );
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
 *
 * Only this one key is written, atomically, so a concurrent write to any other
 * part of `setup` (not least `runtimeGeneration`) is never lost.
 */
export async function recordInstalledSlackOptIns(
  executor: Executor,
  input: { endpointId: string; companyId: string; grantedScopes: readonly string[] },
): Promise<void> {
  const installed = slackOptInGroupsFromScopes(input.grantedScopes);
  await executor
    .update(chatEndpoints)
    .set({
      setup: sql`jsonb_set(${chatEndpoints.setup}, '{slackInstalledOptInScopeGroups}', ${JSON.stringify(installed)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatEndpoints.id, input.endpointId),
        eq(chatEndpoints.companyId, input.companyId),
      ),
    );
}

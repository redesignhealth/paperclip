/** Platform-default Ramp Router key + default model for pi_local agents (create and boot reconcile). */
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

import { RAMP_ROUTER_API_KEY_ENV, PLATFORM_DEFAULT_ROUTER_SECRET } from "./hermes-create-defaults.js";
import { ensurePlatformDefaultSecret } from "./agent-hiring.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";
import { logger } from "../middleware/logger.js";

export const PI_LOCAL_ADAPTER_TYPE = "pi_local";
export const PI_DEFAULT_ROUTER_MODEL = "ramp-router/claude-sonnet-5-5";
// Earlier releases exposed Claude through a second provider; there is now one `ramp-router` provider.
const PI_LEGACY_ANTHROPIC_PROVIDER_PREFIX = "ramp-router-anthropic/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelOf(config: unknown): string {
  return isRecord(config) && typeof config.model === "string" ? config.model.trim() : "";
}

/** True for a pi_local agent with a captured key and no RAMP_ROUTER_API_KEY env entry. Every pi_local agent uses the Ramp Router. */
export function needsPlatformDefaultRouterKeyForPi(
  adapterType: string,
  adapterConfig: unknown,
  capturedKeyPresent: boolean,
): boolean {
  if (adapterType !== PI_LOCAL_ADAPTER_TYPE || !capturedKeyPresent) return false;
  const env = isRecord(adapterConfig) ? adapterConfig.env : undefined;
  if (env !== undefined && !isRecord(env)) return false;
  return !(env && Object.prototype.hasOwnProperty.call(env, RAMP_ROUTER_API_KEY_ENV));
}

/** True when the model still names the retired `ramp-router-anthropic` provider. */
export function needsPiRouterModelMigration(adapterConfig: unknown): boolean {
  return modelOf(adapterConfig).startsWith(PI_LEGACY_ANTHROPIC_PROVIDER_PREFIX);
}

function migratedModel(adapterConfig: Record<string, unknown>): Record<string, unknown> {
  const model = modelOf(adapterConfig);
  return model.startsWith(PI_LEGACY_ANTHROPIC_PROVIDER_PREFIX)
    ? { model: `ramp-router/${model.slice(PI_LEGACY_ANTHROPIC_PROVIDER_PREFIX.length)}` }
    : {};
}

/** Adds the secret_ref, fills the default model only when empty, and renames the retired provider prefix; never overwrites another explicit model. */
export function applyPiRouterDefaults(adapterConfig: Record<string, unknown>, secretId: string): Record<string, unknown> {
  const env = isRecord(adapterConfig.env) ? { ...adapterConfig.env } : {};
  env[RAMP_ROUTER_API_KEY_ENV] = { type: "secret_ref", secretId, version: "latest" };
  return {
    ...adapterConfig,
    env,
    ...(modelOf(adapterConfig) === "" ? { model: PI_DEFAULT_ROUTER_MODEL } : migratedModel(adapterConfig)),
  };
}

/** Idempotent boot reconcile for existing pi_local agents. Returns counts only. */
export async function reconcilePiAgentsRouterKey(db: Db, deploymentKey: string | null) {
  const summary = { scanned: 0, bound: 0, failed: 0 };
  if (!deploymentKey) return summary;
  const rows = await db
    .select({ id: agents.id, companyId: agents.companyId, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.adapterType, PI_LOCAL_ADAPTER_TYPE), ne(agents.status, "terminated")));
  const secretByCompany = new Map<string, string | null>();
  for (const row of rows) {
    summary.scanned += 1;
    const needsKey = needsPlatformDefaultRouterKeyForPi(PI_LOCAL_ADAPTER_TYPE, row.adapterConfig, true);
    if (!needsKey && !needsPiRouterModelMigration(row.adapterConfig)) continue;
    try {
      if (!needsKey) {
        const migrated = await createAgentLifecycle(db).updateConfiguration(row.id, {
          adapterConfig: { ...(row.adapterConfig as Record<string, unknown>), ...migratedModel(row.adapterConfig as Record<string, unknown>) },
        });
        if (migrated) summary.bound += 1;
        continue;
      }
      let secretId = secretByCompany.get(row.companyId);
      if (secretId === undefined) {
        const outcome = await ensurePlatformDefaultSecret(
          db, row.companyId, PLATFORM_DEFAULT_ROUTER_SECRET, deploymentKey,
          "The platform default Ramp Router key could not be stored.",
        );
        secretId = outcome.secretId;
        secretByCompany.set(row.companyId, secretId);
      }
      if (!secretId) continue;
      // The agent lifecycle module owns adapterConfig writes and needs the root connection, so the row cannot be locked
      // here. Re-read right before the write and re-check the predicate: the residual window is milliseconds at boot.
      const [fresh] = await db
        .select({ adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(and(eq(agents.id, row.id), eq(agents.companyId, row.companyId)));
      const config = isRecord(fresh?.adapterConfig) ? fresh.adapterConfig : null;
      if (!config || !needsPlatformDefaultRouterKeyForPi(PI_LOCAL_ADAPTER_TYPE, config, true)) continue;
      const updated = await createAgentLifecycle(db).updateConfiguration(row.id, {
        adapterConfig: applyPiRouterDefaults(config, secretId),
      });
      if (updated) summary.bound += 1;
    } catch (err) {
      summary.failed += 1;
      logger.error(
        { err: err instanceof Error ? err.message : String(err), agentId: row.id, companyId: row.companyId },
        "failed to bind pi_local agent to the platform default Ramp Router key",
      );
    }
  }
  return summary;
}

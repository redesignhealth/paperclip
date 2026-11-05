/** Platform-default Ramp Router key + default model for pi_local agents (create and boot reconcile). */
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

import { RAMP_ROUTER_API_KEY_ENV, PLATFORM_DEFAULT_ROUTER_SECRET } from "./hermes-create-defaults.js";
import { ensurePlatformDefaultSecret } from "./agent-hiring.js";
import { syncAgentAdapterEnvBindings } from "./agent-secret-bindings.js";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";

export const PI_LOCAL_ADAPTER_TYPE = "pi_local";
export const PI_DEFAULT_ROUTER_MODEL = "ramp-router-anthropic/claude-sonnet-5-5";
const PI_ROUTER_MODEL_PREFIX = "ramp-router";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelOf(config: unknown): string {
  return isRecord(config) && typeof config.model === "string" ? config.model.trim() : "";
}

/** True for a pi_local agent with a captured key, no RAMP_ROUTER_API_KEY env entry, and an empty or ramp-router model. */
export function needsPlatformDefaultRouterKeyForPi(
  adapterType: string,
  adapterConfig: unknown,
  capturedKeyPresent: boolean,
): boolean {
  if (adapterType !== PI_LOCAL_ADAPTER_TYPE || !capturedKeyPresent) return false;
  const env = isRecord(adapterConfig) ? adapterConfig.env : undefined;
  if (env !== undefined && !isRecord(env)) return false;
  if (env && Object.prototype.hasOwnProperty.call(env, RAMP_ROUTER_API_KEY_ENV)) return false;
  const model = modelOf(adapterConfig);
  return model === "" || model.startsWith(PI_ROUTER_MODEL_PREFIX);
}

/** Adds the secret_ref and fills the default model only when empty; never overwrites an explicit model. */
export function applyPiRouterDefaults(adapterConfig: Record<string, unknown>, secretId: string): Record<string, unknown> {
  const env = isRecord(adapterConfig.env) ? { ...adapterConfig.env } : {};
  env[RAMP_ROUTER_API_KEY_ENV] = { type: "secret_ref", secretId, version: "latest" };
  return {
    ...adapterConfig,
    env,
    ...(modelOf(adapterConfig) === "" ? { model: PI_DEFAULT_ROUTER_MODEL } : {}),
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
    if (!needsPlatformDefaultRouterKeyForPi(PI_LOCAL_ADAPTER_TYPE, row.adapterConfig, true)) continue;
    let newSecretId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [agent] = await tx
          .select({ adapterConfig: agents.adapterConfig })
          .from(agents)
          .where(and(eq(agents.id, row.id), eq(agents.companyId, row.companyId)))
          .for("update");
        const config = isRecord(agent?.adapterConfig) ? agent.adapterConfig : {};
        if (!needsPlatformDefaultRouterKeyForPi(PI_LOCAL_ADAPTER_TYPE, config, true)) return;
        let secretId = secretByCompany.get(row.companyId);
        if (secretId === undefined) {
          const outcome = await ensurePlatformDefaultSecret(
            tx as unknown as Db, row.companyId, PLATFORM_DEFAULT_ROUTER_SECRET, deploymentKey,
            "The platform default Ramp Router key could not be stored.",
          );
          secretId = outcome.secretId;
          newSecretId = secretId;
        }
        if (!secretId) return;
        const adapterConfig = applyPiRouterDefaults(config, secretId);
        await tx
          .update(agents)
          .set({ adapterConfig })
          .where(and(eq(agents.id, row.id), eq(agents.companyId, row.companyId)));
        await syncAgentAdapterEnvBindings({
          secretsSvc: secretService(tx as unknown as Db), companyId: row.companyId, agentId: row.id, adapterConfig,
        });
        summary.bound += 1;
      });
      if (newSecretId) secretByCompany.set(row.companyId, newSecretId);
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

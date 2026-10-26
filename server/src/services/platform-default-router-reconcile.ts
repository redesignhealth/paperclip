/**
 * TECH-7959: boot-time rotation reconcile for the managed platform-default Ramp Router secrets.
 *
 * Off unless the frozen boot flag PAPERCLIP_PLATFORM_ROUTER_RECONCILE=true was set (see
 * secrets/platform-default-router-key.ts) AND a valid deployment Router key was captured. When on,
 * every company's ACTIVE `local_encrypted`, Paperclip-managed, company-scoped secret with exactly the
 * platform key `ramp_router_api_key` AND exactly the platform name is compared (in constant time) with
 * the captured deployment key, and rotated through the ordinary rotate path on mismatch, guarded by
 * the version it was compared against. Renamed secrets (a different name), external references, other
 * providers, user-scoped secrets and inactive secrets are never touched.
 *
 * Only counts are ever returned or logged: never a value, a length, a hash, or a secret id.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets } from "@paperclipai/db";

import {
  isPlatformRouterReconcileEnabled,
  readPlatformDefaultRouterKey,
} from "../secrets/platform-default-router-key.js";
import { PLATFORM_DEFAULT_ROUTER_SECRET } from "./hermes-create-defaults.js";
import { secretService } from "./secrets.js";

export interface PlatformRouterReconcileSummary {
  enabled: boolean;
  scanned: number;
  unchanged: number;
  rotated: number;
  failed: number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time equality of two strings (compared through fixed-length digests). */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export async function reconcilePlatformDefaultRouterSecretsOnStartup(
  db: Db,
  input: {
    enabled?: boolean;
    deploymentKey?: string | null;
  } = {},
): Promise<PlatformRouterReconcileSummary> {
  const enabled = input.enabled ?? isPlatformRouterReconcileEnabled();
  const deploymentKey = input.deploymentKey === undefined ? readPlatformDefaultRouterKey() : input.deploymentKey;
  const summary: PlatformRouterReconcileSummary = { enabled: false, scanned: 0, unchanged: 0, rotated: 0, failed: 0 };
  if (!enabled || !deploymentKey) return summary;
  summary.enabled = true;

  const rows = await db
    .select({ id: companySecrets.id, companyId: companySecrets.companyId, latestVersion: companySecrets.latestVersion })
    .from(companySecrets)
    .where(and(
      eq(companySecrets.scope, "company"),
      eq(companySecrets.key, PLATFORM_DEFAULT_ROUTER_SECRET.key),
      eq(companySecrets.name, PLATFORM_DEFAULT_ROUTER_SECRET.name),
      eq(companySecrets.provider, "local_encrypted"),
      eq(companySecrets.managedMode, "paperclip_managed"),
      eq(companySecrets.status, "active"),
    ));

  const secrets = secretService(db);
  for (const row of rows) {
    summary.scanned += 1;
    try {
      const current = await secrets.resolveSecretValue(row.companyId, row.id, row.latestVersion);
      if (constantTimeEqual(current, deploymentKey)) {
        summary.unchanged += 1;
        continue;
      }
      // Compare-and-set on the version just compared: a concurrent rotation makes this a 409, which
      // is counted as failed and left for the next boot rather than overwritten.
      await secrets.rotate(row.id, { value: deploymentKey, expectedLatestVersion: row.latestVersion });
      summary.rotated += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

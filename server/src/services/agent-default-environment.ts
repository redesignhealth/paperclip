import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { supportedEnvironmentDriversForAdapter } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { environmentService } from "./environments.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";

type EnvironmentsLookup = Pick<ReturnType<typeof environmentService>, "getById" | "listBoundCompanyIds">;

/**
 * An environment may be a company default when it exists, is not archived, and is either unbound or bound to this
 * company. Throws 422 otherwise.
 */
export async function assertCompanyDefaultEnvironmentSelection(
  environmentsSvc: EnvironmentsLookup,
  companyId: string,
  environmentId: string | null | undefined,
) {
  if (environmentId === undefined || environmentId === null) return;
  await assertEnvironmentSelectionForCompany(environmentsSvc, companyId, environmentId);
  const bound = await environmentsSvc.listBoundCompanyIds(environmentId);
  if (bound.length > 0 && !bound.includes(companyId)) {
    throw unprocessable("Environment belongs to another company.");
  }
}

type FallbackEnvironment = { driver: string; status?: string | null; config?: Record<string, unknown> | null };

/**
 * Why `environment` cannot serve as a company/instance FALLBACK for an agent of `adapterType`, or null when it can.
 * Pure. An explicit agent selection is validated elsewhere and never passes through here.
 */
export function fallbackEnvironmentRejection(
  environment: FallbackEnvironment | null | undefined,
  options: { companyId: string; adapterType: string | null | undefined; boundCompanyIds: readonly string[] },
): string | null {
  if (!environment) return "Environment not found.";
  if (environment.status === "archived") return "Environment is archived.";
  if (options.boundCompanyIds.length > 0 && !options.boundCompanyIds.includes(options.companyId)) {
    return "Environment belongs to another company.";
  }
  const adapterType = options.adapterType ?? "process";
  const allowedDrivers: string[] = supportedEnvironmentDriversForAdapter(adapterType);
  if (!allowedDrivers.includes(environment.driver)) {
    return `Environment driver "${environment.driver}" is not allowed for adapter "${adapterType}".`;
  }
  if (environment.driver === "sandbox") {
    const config = environment.config && typeof environment.config === "object" ? environment.config : {};
    if (config.provider === "fake") return "The fake sandbox provider cannot execute runs.";
    // A sandbox environment with a curated adapter registry only leases the adapters it lists (the lease fails with
    // `Adapter "..." is not in the configured adapter registry` otherwise). The native runner is not a registry harness.
    const registry = Array.isArray(config.adapters) ? (config.adapters as Array<Record<string, unknown>>) : [];
    if (registry.length > 0 && adapterType !== "paperclip_runner"
      && !registry.some((entry) => entry?.adapterType === adapterType && entry.enabled !== false)) {
      return `Sandbox environment does not list an enabled "${adapterType}" adapter.`;
    }
  }
  return null;
}

/**
 * The company/instance fallback environment for an agent of `adapterType` that has no environment of its own
 * (TECH-10878): the company default, else (later) the instance new-agent default. Returns the first candidate that can
 * run this adapter, or null (Local). A candidate that cannot is skipped, never an error. Used at agent creation, which
 * stores the result on the agent row, and at run time for agents whose environment is still null.
 */
export async function resolveAgentFallbackEnvironmentId(
  db: Db,
  companyId: string,
  adapterType: string | null | undefined,
): Promise<string | null> {
  const row = await db
    .select({ defaultEnvironmentId: companies.defaultEnvironmentId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const candidates: Array<{ source: string; environmentId: string | null | undefined }> = [
    { source: "company", environmentId: row?.defaultEnvironmentId },
  ];
  const environmentsSvc = environmentService(db);
  for (const { source, environmentId } of candidates) {
    if (!environmentId) continue;
    const environment = await environmentsSvc.getById(environmentId);
    const boundCompanyIds = environment ? await environmentsSvc.listBoundCompanyIds(environmentId) : [];
    const reason = fallbackEnvironmentRejection(environment, { companyId, adapterType, boundCompanyIds });
    if (!reason) return environmentId;
    logger.warn(
      { companyId, adapterType, source, environmentId, reason },
      "[agents] Skipping unusable fallback environment for agent",
    );
  }
  return null;
}

/** Creation-time name for the same resolution. */
export const resolveInheritedAgentEnvironmentId = resolveAgentFallbackEnvironmentId;

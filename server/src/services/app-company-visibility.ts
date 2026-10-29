import type { CompanyVisibility } from "@paperclipai/shared";
import {
  appCompanyVisibilityUnavailableReason,
  getConnectableAppDefinition,
  isAppAvailableForCompanyVisibility,
} from "@paperclipai/shared";
import type { AppDefinition } from "@paperclipai/shared";
import { companies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { forbidden } from "../errors.js";

/**
 * Shared gate for apps whose AppDefinition declares `companyVisibility`.
 *
 * A declared allowlist is the only source of truth, so a NULL company
 * visibility fails closed. This deliberately does not reuse
 * `isCompanyVisibilityShared`, which treats NULL as private.
 */
export const APP_UNAVAILABLE_FOR_COMPANY_VISIBILITY_CODE =
  "app_unavailable_for_shared_company";

/**
 * Granola is identified by its reviewed source label or its exact canonical
 * MCP endpoint. Rows created before the label was pinned still match by URL.
 */
export function isGranolaConfig(config: Record<string, unknown>): boolean {
  if (config.sourceTemplateKey === "granola") return true;
  try {
    const url = new URL(String(config.url ?? ""));
    return url.protocol === "https:" && url.hostname === "mcp.granola.ai"
      && url.port === "" && url.pathname === "/mcp" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Minimal handle: a pool or a transaction both have `select`. */
type VisibilityReader = Pick<Db, "select">;

export async function loadCompanyVisibility(
  db: VisibilityReader,
  companyId: string,
): Promise<CompanyVisibility | null> {
  const [row] = await db
    .select({ visibility: companies.visibility })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row?.visibility ?? null;
}

/** The app a connection row represents, from its pinned source label. */
export function appForConnectionConfig(
  config: Record<string, unknown>,
): AppDefinition | null {
  if (isGranolaConfig(config)) return getConnectableAppDefinition("granola");
  const key = config.sourceTemplateKey;
  return typeof key === "string" && key ? getConnectableAppDefinition(key) : null;
}

/** Denial message, or null when the app may be used in this company. */
export function appCompanyVisibilityDenial(
  app: Pick<AppDefinition, "name" | "companyVisibility">,
  visibility: CompanyVisibility | null,
): string | null {
  return isAppAvailableForCompanyVisibility(app, visibility)
    ? null
    : appCompanyVisibilityUnavailableReason(app);
}

export function connectionCompanyVisibilityDenial(
  config: Record<string, unknown>,
  visibility: CompanyVisibility | null,
): string | null {
  const app = appForConnectionConfig(config);
  return app ? appCompanyVisibilityDenial(app, visibility) : null;
}

/** Fail-closed check for a config that is about to be persisted. */
export async function assertConnectionConfigAvailableInCompany(
  db: VisibilityReader,
  companyId: string,
  config: Record<string, unknown>,
): Promise<void> {
  if (!appForConnectionConfig(config)?.companyVisibility) return;
  const denial = connectionCompanyVisibilityDenial(
    config,
    await loadCompanyVisibility(db, companyId),
  );
  if (denial) {
    throw forbidden(denial, { code: APP_UNAVAILABLE_FOR_COMPANY_VISIBILITY_CODE });
  }
}

/**
 * Fail-closed check for connection rows. It applies to every row status,
 * including existing non-draft connections.
 */
export async function assertConnectionAvailableInCompany(
  db: VisibilityReader,
  connection: { companyId: string; config: Record<string, unknown> },
): Promise<void> {
  await assertConnectionConfigAvailableInCompany(db, connection.companyId, connection.config);
}

export function assertAppAvailableInCompany(
  app: Pick<AppDefinition, "name" | "companyVisibility">,
  visibility: CompanyVisibility | null,
): void {
  const denial = appCompanyVisibilityDenial(app, visibility);
  if (denial) {
    throw forbidden(denial, { code: APP_UNAVAILABLE_FOR_COMPANY_VISIBILITY_CODE });
  }
}

/** Gallery/discovery projection: keep the row, mark it unavailable. */
export function withCompanyVisibilityAvailability<T extends AppDefinition>(
  app: T,
  visibility: CompanyVisibility | null,
): T {
  if (app.availability?.available === false) return app;
  const denial = appCompanyVisibilityDenial(app, visibility);
  if (!denial) return app;
  return { ...app, availability: { ...app.availability, available: false, reason: denial } };
}

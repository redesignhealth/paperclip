/**
 * Boot-time capture of the default-MCP company-template rollout scope (TECH-7271).
 *
 * The scope decides which companies the default-MCP provisioning feature acts on: the managed comms-board
 * template AND every per-agent claim, register and mint (default-mcp-setup.ts applies the same predicate). It is an
 * operator rollout control, so it is captured ONCE from the deployment process environment at the
 * first bootstrap import (before dotenv files, config parsing or child spawns) and frozen. A later
 * environment or `.env` change cannot widen or narrow it, and the CLI `.env` preload reserves the key.
 *
 * Semantics (closed, fail-closed):
 * - unset                       -> every company (the final rollout state)
 * - empty / whitespace string   -> no company (staged)
 * - comma-separated UUID list   -> exactly those companies
 * - anything else (wildcard, non-UUID, empty list entry, ...) -> NO company. Malformed input never widens.
 *
 * Before any capture the live value is `none`: this never falls back to reading `process.env`.
 * Nothing here logs the raw value.
 */
import { DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV } from "@paperclipai/shared/default-mcp-template-env";

export { DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV };

export type DefaultMcpTemplateScope =
  | { readonly mode: "all" }
  | { readonly mode: "none" }
  | { readonly mode: "allowlist"; readonly companyIds: readonly string[] };

const ALL: DefaultMcpTemplateScope = Object.freeze({ mode: "all" });
const NONE: DefaultMcpTemplateScope = Object.freeze({ mode: "none" });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pure parse of the raw environment value. `undefined` (unset) means every company. */
export function parseDefaultMcpTemplateScope(raw: string | null | undefined): DefaultMcpTemplateScope {
  if (raw === undefined || raw === null) return ALL;
  const trimmed = raw.trim();
  if (trimmed === "") return NONE;
  const items = trimmed.split(",").map((item) => item.trim().toLowerCase());
  if (items.some((item) => !UUID_PATTERN.test(item))) return NONE;
  return Object.freeze({ mode: "allowlist", companyIds: Object.freeze([...new Set(items)]) });
}

export function isCompanyInDefaultMcpTemplateScope(scope: DefaultMcpTemplateScope, companyId: string): boolean {
  if (scope.mode === "all") return true;
  if (scope.mode === "none") return false;
  return scope.companyIds.includes(companyId.toLowerCase());
}

let captured: DefaultMcpTemplateScope = NONE;
let didCapture = false;

/** First call only: parse and freeze the scope from `env`. Later calls never adopt a new value. */
export function captureDefaultMcpTemplateScope(env: NodeJS.ProcessEnv = process.env): DefaultMcpTemplateScope {
  if (!didCapture) {
    didCapture = true;
    captured = parseDefaultMcpTemplateScope(env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]);
  }
  return captured;
}

/** The frozen boot scope (`none` if the bootstrap never ran). Never reads `process.env`. */
export function readDefaultMcpTemplateScope(): DefaultMcpTemplateScope {
  return captured;
}

/** Resets the captured state. Strictly for targeted tests. */
export function __resetDefaultMcpTemplateScopeForTests(): void {
  captured = NONE;
  didCapture = false;
}

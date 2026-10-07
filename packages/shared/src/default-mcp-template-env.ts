/**
 * Canonical name of the default-MCP company-template rollout scope setting (TECH-7271).
 *
 * Shared so the server boot capture and the CLI's `.env` preload agree that this key is reserved for
 * the deployment environment: a project `.env` must never narrow (or silently widen) an operator's
 * rollout scope. Names only: this module holds no values and no logic.
 *
 * Semantics (parsed server-side): unset = every company, empty string = no company (staged), a
 * comma-separated UUID list = only those companies, anything malformed = no company (fail closed).
 */
export const DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV = "PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS";

export const DEFAULT_MCP_TEMPLATE_ENV_KEYS: readonly string[] = Object.freeze([
  DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
]);

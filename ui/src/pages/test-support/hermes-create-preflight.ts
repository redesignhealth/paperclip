/**
 * TECH-7895 test support: a stand-in for the server's create-purpose environment test. For a Hermes
 * create-purpose request it returns the safe createDefaults projection the server would forecast
 * (credential-free intent with no provider/model -> Ramp Router default; explicit Router -> Router,
 * filling the default model; anything else -> the caller's own choice), plus the Router readiness
 * check an effective Router config reports. Every other request gets `base` unchanged.
 *
 * TECH-7959: with `organizationRouterKey`, the stub forecasts the server binding the organization's
 * platform-default Ramp Router key (the server's needsPlatformDefaultRouterKey predicate): explicit
 * Router, or an unchosen provider/model with no credential, and no RAMP_ROUTER_API_KEY of its own.
 * A bound org key makes Router the default and reports `create_defaults_platform_router`.
 */
import type { AgentCreateDefaultsProjection } from "@paperclipai/shared";

type Payload = {
  adapterConfig?: Record<string, unknown>;
  testCredentials?: Record<string, string>;
  purpose?: string;
};

export type HermesCreatePreflightOptions = {
  /** The deployment captured a platform Router key and the org secret would bind. */
  organizationRouterKey?: boolean;
};

export function forecastHermesCreateDefaults(
  payload: Payload,
  options: HermesCreatePreflightOptions = {},
): AgentCreateDefaultsProjection {
  const config = payload.adapterConfig ?? {};
  const provider = typeof config.provider === "string" ? config.provider.trim().toLowerCase() : "";
  const rawModel = typeof config.model === "string" ? config.model.trim() : "";
  const model = rawModel && rawModel.toLowerCase() !== "auto" ? (config.model as string) : null;
  const env = (config.env as Record<string, unknown> | undefined) ?? {};
  const credentials = payload.testCredentials ?? {};
  const hasCredential = Object.keys(credentials).length > 0 || Object.keys(env).length > 0;
  const ownsRouterKey = "RAMP_ROUTER_API_KEY" in env || "RAMP_ROUTER_API_KEY" in credentials;
  const unchosen = (provider === "" || provider === "auto") && !model;
  const platformRouterKeyBound =
    options.organizationRouterKey === true && !ownsRouterKey && (provider === "router" || (unchosen && !hasCredential));
  if (provider === "router")
    return { provider: "router", model: model ?? "auto-jev-routing", source: model ? "explicit_or_inferred" : "router_default", requiresRouterReadiness: true, platformRouterKeyBound };
  if (unchosen && !hasCredential)
    return { provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound };
  return { provider: provider || null, model, source: "explicit_or_inferred", requiresRouterReadiness: false, platformRouterKeyBound: false };
}

type TestResultLike = { checks: Array<Record<string, unknown>> } & Record<string, unknown>;

export function withHermesCreatePreflight(base: TestResultLike, options: HermesCreatePreflightOptions = {}) {
  return async (_companyId: string, type: string, payload: Payload): Promise<TestResultLike> => {
    if (type !== "hermes_local" || payload.purpose !== "create") return base;
    const createDefaults = forecastHermesCreateDefaults(payload, options);
    return {
      ...base,
      adapterType: type,
      checks: [
        ...base.checks,
        ...(createDefaults.requiresRouterReadiness
          ? [{ code: "hermes_router_supported", level: "info", message: "Router supported" }]
          : []),
        ...(createDefaults.platformRouterKeyBound
          ? [{ code: "create_defaults_platform_router", level: "info", message: "Uses the organization's Ramp Router key; key not tested." }]
          : []),
      ],
      createDefaults,
    };
  };
}

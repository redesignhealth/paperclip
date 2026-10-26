/**
 * TECH-7895 test support: a stand-in for the server's create-purpose environment test. For a Hermes
 * create-purpose request it returns the safe createDefaults projection the server would forecast
 * (credential-free intent with no provider/model -> Ramp Router default; explicit Router -> Router,
 * filling the default model; anything else -> the caller's own choice), plus the Router readiness
 * check an effective Router config reports. Every other request gets `base` unchanged.
 */
import type { AgentCreateDefaultsProjection } from "@paperclipai/shared";

type Payload = {
  adapterConfig?: Record<string, unknown>;
  testCredentials?: Record<string, string>;
  purpose?: string;
};

export function forecastHermesCreateDefaults(payload: Payload): AgentCreateDefaultsProjection {
  const config = payload.adapterConfig ?? {};
  const provider = typeof config.provider === "string" ? config.provider.trim().toLowerCase() : "";
  const rawModel = typeof config.model === "string" ? config.model.trim() : "";
  const model = rawModel && rawModel.toLowerCase() !== "auto" ? (config.model as string) : null;
  const hasCredential =
    Object.keys(payload.testCredentials ?? {}).length > 0 ||
    Object.keys((config.env as Record<string, unknown> | undefined) ?? {}).length > 0;
  if (provider === "router")
    return { provider: "router", model: model ?? "auto-jev-routing", source: model ? "explicit_or_inferred" : "router_default", requiresRouterReadiness: true, platformRouterKeyBound: false };
  if ((provider === "" || provider === "auto") && !model && !hasCredential)
    return { provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: false };
  return { provider: provider || null, model, source: "explicit_or_inferred", requiresRouterReadiness: false, platformRouterKeyBound: false };
}

type TestResultLike = { checks: Array<Record<string, unknown>> } & Record<string, unknown>;

export function withHermesCreatePreflight(base: TestResultLike) {
  return async (_companyId: string, type: string, payload: Payload): Promise<TestResultLike> => {
    if (type !== "hermes_local" || payload.purpose !== "create") return base;
    const createDefaults = forecastHermesCreateDefaults(payload);
    return {
      ...base,
      adapterType: type,
      checks: [
        ...base.checks,
        ...(createDefaults.requiresRouterReadiness
          ? [{ code: "hermes_router_supported", level: "info", message: "Router supported" }]
          : []),
      ],
      createDefaults,
    };
  };
}

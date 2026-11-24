/**
 * Model relay for sandbox pods (TECH-10174).
 *
 * A sandbox pod must not hold the shared model gateway key (for example the Ramp Router key): the model can read its own
 * environment by writing a script and running it. Instead the adapter registers the key host-side for the run, the pod's
 * model provider points at the sandbox bridge (`${PAPERCLIP_API_URL}/api/model-relay/<provider>`), and the Paperclip server
 * (`server/src/routes/model-relay.ts`) adds the key before forwarding to the provider's upstream.
 *
 * The adapter runs in the server process, and the bridge forwards to the server's own listen address, so a process-local
 * registry keyed by run id is enough. An entry exists only while the run does: the adapter disposes it when the run ends,
 * so a key never outlives the run.
 */
import type { SandboxCallbackBridgeRoutePolicy } from "./sandbox-callback-bridge.js";

export const MODEL_RELAY_PATH = "/api/model-relay";

/** The provider-relative paths the relay forwards. POST only. Everything else is refused before any upstream call. */
export const MODEL_RELAY_ALLOWED_SUFFIXES = ["chat/completions", "completions", "responses", "messages"] as const;

/** Give-up deadline for one relayed model request (a long streamed turn is buffered by the bridge). */
export const MODEL_RELAY_DEADLINE_MS = 480_000;
/** In-pod response deadline: a margin above the server's give-up deadline. */
export const MODEL_RELAY_POLICY_MARGIN_MS = 10_000;

/**
 * Bridge route policy: its own lane and a long in-pod deadline. Without it a model call would share the single
 * sequential lane and the 30 s default deadline. The duplex (HTTP/2) transport ignores policies.
 */
export const MODEL_RELAY_ROUTE_POLICIES: readonly SandboxCallbackBridgeRoutePolicy[] = [
  {
    path: /^\/api\/model-relay\/[a-z0-9][a-z0-9_-]{0,63}\/(?:chat\/completions|completions|responses|messages)$/,
    deadlineMs: MODEL_RELAY_DEADLINE_MS + MODEL_RELAY_POLICY_MARGIN_MS,
    maxConcurrent: 4,
  },
];

export interface ModelRelayEntry {
  /** The provider's real upstream base URL (for example `https://api.router.com/v1`). Never reaches the pod. */
  upstreamBaseUrl: string;
  /** The credential the server adds. Held host-side only. */
  apiKey: string;
}

const REGISTRY_KEY = Symbol.for("paperclip.modelRelay.registry");
type Registry = Map<string, Map<string, ModelRelayEntry>>;

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (holder[REGISTRY_KEY] ??= new Map());
}

export function modelRelayProviderNameOk(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

/** Registers the relayed providers for one run. Returns a disposer; call it when the run ends. */
export function registerModelRelay(runId: string, providers: Readonly<Record<string, ModelRelayEntry>>): () => void {
  const entries = new Map<string, ModelRelayEntry>();
  for (const [name, entry] of Object.entries(providers)) {
    if (!modelRelayProviderNameOk(name)) throw new Error("Invalid model relay provider name");
    entries.set(name, { ...entry });
  }
  registry().set(runId, entries);
  return () => {
    if (registry().get(runId) === entries) registry().delete(runId);
  };
}

export function lookupModelRelay(runId: string, provider: string): ModelRelayEntry | null {
  return registry().get(runId)?.get(provider) ?? null;
}

/** The in-pod base URL a relayed provider is pointed at. */
export function modelRelayBaseUrl(apiUrl: string, provider: string): string {
  return `${apiUrl.trim().replace(/\/+$/, "")}${MODEL_RELAY_PATH}/${provider}`;
}

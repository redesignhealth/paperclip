/**
 * Self-resolution of the paperclip-server image digest (TECH-9856).
 *
 * When an adapter registry entry leaves `runtimeImage` unset, sandbox pods run
 * the SAME image as the server that is currently deployed, so environments
 * follow deploys instead of drifting on a stale hand-pinned digest. An explicit
 * `runtimeImage` is an override and never reaches this module.
 *
 * Sources, in order:
 *   1. PAPERCLIP_SERVER_IMAGE_REF (explicit `repo@sha256:<digest>`; tests and
 *      hosts without ECS metadata).
 *   2. ECS task metadata v4 (`ECS_CONTAINER_METADATA_URI_V4`), whose container
 *      document carries `ImageID` as either `repo@sha256:<digest>` or a bare
 *      `sha256:<digest>`; in the bare case the repository is taken from `Image`.
 *
 * There is deliberately NO fallback to a default/tag image: if neither source
 * yields a digest reference this throws.
 */

export const SERVER_IMAGE_REF_ENV = "PAPERCLIP_SERVER_IMAGE_REF";
export const ECS_METADATA_URI_ENV = "ECS_CONTAINER_METADATA_URI_V4";

const DIGEST_REF = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/;
const BARE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const METADATA_TIMEOUT_MS = 5000;

export interface ServerImageRefDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** Validate a `repo@sha256:<64 hex>` reference and return it normalised. */
export function parseDigestRef(value: string, source: string): string {
  // ECS/Docker sometimes report ImageID with a transport prefix.
  const cleaned = value.trim().replace(/^docker-pullable:\/\//, "");
  if (!DIGEST_REF.test(cleaned)) {
    throw new Error(
      `${source} is not a digest-pinned image reference (expected "<repo>@sha256:<64 hex>"): ${JSON.stringify(value)}`,
    );
  }
  return cleaned;
}

/** `repo[:tag][@digest]` -> `repo` (empty when unusable). */
function repoOf(image: string): string {
  const noDigest = image.trim().split("@")[0] ?? "";
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  const repo = colon > lastSlash ? noDigest.slice(0, colon) : noDigest;
  return /^[^\s@]+$/.test(repo) ? repo : "";
}

async function fetchEcsImageRef(baseUri: string, fetchImpl: typeof fetch): Promise<string> {
  let body: unknown;
  try {
    const res = await fetchImpl(baseUri, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new Error(
      `failed to read ECS task metadata from ${ECS_METADATA_URI_ENV}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const { ImageID: imageId, Image: image } = (body ?? {}) as { ImageID?: unknown; Image?: unknown };
  if (typeof imageId !== "string" || imageId.length === 0) {
    throw new Error("ECS task metadata has no ImageID; cannot determine the server image digest");
  }
  const bare = imageId.trim();
  if (BARE_DIGEST.test(bare)) {
    // Bare digest: rebuild `<registry>/<repo>@<digest>` from the `Image` name.
    const repo = typeof image === "string" ? repoOf(image) : "";
    if (!repo) {
      throw new Error("ECS task metadata ImageID is a bare digest and Image has no repository; cannot build a digest reference");
    }
    return `${repo}@${bare}`;
  }
  return parseDigestRef(imageId, "ECS task metadata ImageID");
}

let cached: Promise<string> | undefined;

/** Test seam: drop the memoised result. */
export function resetServerImageRefCache(): void {
  cached = undefined;
}

async function resolveUncached(deps: ServerImageRefDeps): Promise<string> {
  const env = deps.env ?? process.env;
  const explicit = env[SERVER_IMAGE_REF_ENV]?.trim();
  if (explicit) return parseDigestRef(explicit, SERVER_IMAGE_REF_ENV);
  const metadataUri = env[ECS_METADATA_URI_ENV]?.trim();
  if (metadataUri) return fetchEcsImageRef(metadataUri, deps.fetchImpl ?? fetch);
  throw new Error(
    `cannot determine the paperclip-server image: neither ${SERVER_IMAGE_REF_ENV} nor ${ECS_METADATA_URI_ENV} is set`,
  );
}

/**
 * Resolve the server's own image as `<repo>@sha256:<digest>`. Memoised on
 * success (the first caller's deps win); failures are not cached so a
 * transient metadata error is retried on the next call.
 */
export function resolveServerImageRef(deps: ServerImageRefDeps = {}): Promise<string> {
  if (!cached) {
    const p = resolveUncached(deps);
    cached = p;
    p.catch(() => {
      if (cached === p) cached = undefined;
    });
  }
  return cached;
}

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { ashbyRelayOptedIn, ASHBY_RELAY_OPT_IN_ENV_KEY } from "@paperclipai/adapter-utils/ashby-relay-env";
import { logger } from "../middleware/logger.js";
import { guardedRemoteHttpFetch } from "../services/remote-http-fetch.js";
import { secretService } from "../services/secrets.js";

/**
 * TECH-9966: fixed-destination Ashby API relay for sandboxed agents.
 *
 * A sandbox pod cannot reach api.ashbyhq.com directly under default-deny network egress policy and holds no API key.
 * The pod points its Ashby client at the sandbox bridge (`ASHBY_API_BASE=${PAPERCLIP_API_URL}/api/ashby-relay`), which
 * forwards here with the run JWT. This server validates the operation against an allowlist, resolves the Ashby API key
 * (first from company secret `ashby_relay.api_key`, falling back to server env `PAPERCLIP_ASHBY_RELAY_API_KEY` injected
 * by ECS from SSM), and adds HTTP Basic auth before forwarding to the pinned upstream `https://api.ashbyhq.com`.
 * The key never enters the pod.
 *
 * Upstream is pinned to `https://api.ashbyhq.com` from `PAPERCLIP_ASHBY_RELAY_BASE_URL` (HTTPS only, root path only).
 * Operations are restricted to a closed allowlist: read-only operations intersected with KNOWN_ASHBY_RELAY_READ_OPERATIONS
 * (`candidate.search`, `candidate.info`, `application.list`, `job.list`). Writes require explicit opt-in via
 * `PAPERCLIP_ASHBY_RELAY_WRITE_OPERATIONS` and are intersected with KNOWN_ASHBY_RELAY_WRITE_OPERATIONS.
 * Auth requires a run-JWT (`actor.type === "agent" && actor.source === "agent_jwt"` with active run in database) and per-agent
 * opt-in `adapterConfig.env.PAPERCLIP_ASHBY_RELAY=on`.
 * Fails closed 503 when unconfigured or when neither credential source exists. Error bodies never echo upstream content or keys.
 */

export const ASHBY_RELAY_BASE_URL_ENV = "PAPERCLIP_ASHBY_RELAY_BASE_URL";
export const ASHBY_RELAY_OPERATIONS_ENV = "PAPERCLIP_ASHBY_RELAY_OPERATIONS";
export const ASHBY_RELAY_WRITE_OPERATIONS_ENV = "PAPERCLIP_ASHBY_RELAY_WRITE_OPERATIONS";
export const ASHBY_RELAY_SECRET_KEY = "ashby_relay.api_key";
export const ASHBY_RELAY_API_KEY_ENV = "PAPERCLIP_ASHBY_RELAY_API_KEY";
export const ASHBY_RELAY_FALLBACK_COMPANIES_ENV = "PAPERCLIP_ASHBY_RELAY_FALLBACK_COMPANIES";
export const ASHBY_RELAY_FALLBACK_AGENTS_ENV = "PAPERCLIP_ASHBY_RELAY_FALLBACK_AGENTS";
export { ASHBY_RELAY_OPT_IN_ENV_KEY };

export const ASHBY_UPSTREAM_ORIGIN = "https://api.ashbyhq.com";

/**
 * Default authorized tenant IDs for server-wide SSM fallback key.
 * A single production key injected from SSM must never be available to another company or agent.
 */
export const DEFAULT_ASHBY_RELAY_FALLBACK_COMPANIES = [
  "e8c7983e-ee86-46f6-99b1-99fd4ad9cef6",
] as const;

export const DEFAULT_ASHBY_RELAY_FALLBACK_AGENTS = [
  "9c3e3539-a132-4be6-97a3-24cf64090d51",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Host upstream deadline is 25 s, leaving a proven 5,000 ms margin before the bridge's
 * 30 s default timeout (DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS).
 */
export const ASHBY_RELAY_DEADLINE_MS = 25_000;
/** Byte cap under the bridge limit (~10 MB). */
export const ASHBY_RELAY_MAX_BODY_BYTES = 10_000_000;

export const KNOWN_ASHBY_RELAY_READ_OPERATIONS = new Set([
  "candidate.search",
  "candidate.info",
  "application.list",
  "job.list",
]);

export const KNOWN_ASHBY_RELAY_WRITE_OPERATIONS = new Set([
  "candidate.create",
  "candidate.createNote",
  "candidate.addTag",
  "application.create",
  "application.changeStage",
]);

export const DEFAULT_ASHBY_RELAY_READ_OPERATIONS = [
  "candidate.search",
  "candidate.info",
  "application.list",
  "job.list",
] as const;

const OPERATION_RE = /^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)+$/;
const JSON_CONTENT_TYPE_RE = /^application\/json\s*(;|$)/i;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

export interface AshbyRelayDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** True when the agent opted in to the Ashby relay. Replaceable in tests. */
  isOptedIn?: (agentId: string) => Promise<boolean>;
  /** The Ashby API key, or null when none is stored/configured. Replaceable in tests. */
  resolveToken?: (companyId: string, agentId: string) => Promise<string | null>;
  /** Verifies that the run is an actual active, non-terminal run scoped to this agent/company. */
  assertActiveRun?: (input: { companyId: string; agentId: string; runId: string }) => Promise<boolean>;
}

export interface AshbyRelayConfig {
  base: string;
  operations: Set<string>;
  readOperations: Set<string>;
  writeOperations: Set<string>;
}

function fail(res: Response, status: number, detail: string) {
  res.status(status).json({ detail });
}

export function validateApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (!trimmed || CONTROL_CHARS_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function parseIdAllowlist(
  envValue: string | undefined,
  defaultIds: readonly string[] = [],
): Set<string> | null {
  const raw = envValue?.trim();
  if (!raw) {
    return new Set(defaultIds.map((id) => id.toLowerCase()));
  }
  const entries = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0 || !entries.every((id) => UUID_RE.test(id))) {
    return null;
  }
  return new Set(entries);
}

/**
 * Resolves the Ashby API key for an agent run:
 * 1. Looks up company secret `ashby_relay.api_key`. Company secrets are strictly company-scoped.
 * 2. If absent (clear not-found: null, non-active, or empty), falls back to server env `PAPERCLIP_ASHBY_RELAY_API_KEY`
 *    (injected as an ECS container secret from SSM).
 * 3. Tenant isolation: the SSM fallback key is strictly restricted to authorized company and agent allowlists
 *    (default: company `e8c7983e-ee86-46f6-99b1-99fd4ad9cef6` and Talent agent `9c3e3539-a132-4be6-97a3-24cf64090d51`).
 *    Any other company or agent without its own company secret fails closed.
 * 4. A database or secret-store error does NOT fall through to env (it rethrows).
 * 5. Blank/whitespace keys or keys with control characters/CRLF are rejected.
 */
export async function resolveAshbyToken(
  db: Db,
  input: { companyId: string; agentId: string },
  env: NodeJS.ProcessEnv,
  secrets = secretService(db),
): Promise<string | null> {
  const { companyId, agentId } = input;
  let secret;
  try {
    secret = await secrets.getByKey(companyId, ASHBY_RELAY_SECRET_KEY);
  } catch (err) {
    throw err;
  }

  if (secret && secret.status === "active") {
    let value: string | null = null;
    try {
      value = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    } catch (err) {
      throw err;
    }
    const validated = validateApiKey(value);
    if (validated) return validated;
  }

  // Tenant isolation check for SSM fallback key
  const fallbackCompanies = parseIdAllowlist(
    env[ASHBY_RELAY_FALLBACK_COMPANIES_ENV],
    DEFAULT_ASHBY_RELAY_FALLBACK_COMPANIES,
  );
  const fallbackAgents = parseIdAllowlist(
    env[ASHBY_RELAY_FALLBACK_AGENTS_ENV],
    DEFAULT_ASHBY_RELAY_FALLBACK_AGENTS,
  );

  if (!fallbackCompanies || !fallbackAgents) {
    return null;
  }

  const normalizedCompanyId = companyId.trim().toLowerCase();
  const normalizedAgentId = agentId.trim().toLowerCase();

  if (
    !fallbackCompanies.has(normalizedCompanyId) ||
    !fallbackAgents.has(normalizedAgentId)
  ) {
    return null;
  }

  return validateApiKey(env[ASHBY_RELAY_API_KEY_ENV]);
}

export function parseOperations(
  envValue: string | undefined,
  defaultOps: readonly string[] = [],
): Set<string> | null {
  const raw = envValue?.trim();
  if (!raw) {
    return new Set(defaultOps);
  }
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0 || !entries.every((op) => OPERATION_RE.test(op))) {
    return null;
  }
  return new Set(entries);
}

export function parseAshbyRelayConfig(env: NodeJS.ProcessEnv): AshbyRelayConfig | null {
  const url = env[ASHBY_RELAY_BASE_URL_ENV]?.trim().replace(/\/+$/, "");
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Pinned exact origin https://api.ashbyhq.com with root path only:
  // Reject non-https, different host, custom port, path prefix, userinfo, query, fragment.
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "api.ashbyhq.com" ||
    parsed.port !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  // Intersect read operations strictly with known read-only set; no mutation permitted via read config
  const rawReadOps = parseOperations(env[ASHBY_RELAY_OPERATIONS_ENV], DEFAULT_ASHBY_RELAY_READ_OPERATIONS);
  if (!rawReadOps) return null;
  const readOps = new Set([...rawReadOps].filter((op) => KNOWN_ASHBY_RELAY_READ_OPERATIONS.has(op)));
  if (readOps.size === 0) return null;

  // Intersect write operations strictly with known write set
  const rawWriteOps = parseOperations(env[ASHBY_RELAY_WRITE_OPERATIONS_ENV], []);
  if (!rawWriteOps) return null;
  const writeOps = new Set([...rawWriteOps].filter((op) => KNOWN_ASHBY_RELAY_WRITE_OPERATIONS.has(op)));

  return {
    base: ASHBY_UPSTREAM_ORIGIN,
    operations: new Set([...readOps, ...writeOps]),
    readOperations: readOps,
    writeOperations: writeOps,
  };
}

export function ashbyRelayRoutes(db: Db, deps: AshbyRelayDeps = {}) {
  const router = Router();
  let warnedUnconfigured = false;
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? ((url: string | URL, init?: RequestInit) =>
    guardedRemoteHttpFetch(url, init ?? {}, {
      allowPrivateNetwork: false,
      error: (message, code) => new Error(`${code}: ${message}`),
    }));

  const isOptedIn = deps.isOptedIn ?? (async (agentId: string) => {
    const { agentService } = await import("../services/agents.js");
    const agent = await agentService(db).getById(agentId);
    const adapterEnv = (agent?.adapterConfig as { env?: Record<string, unknown> } | null | undefined)?.env;
    return ashbyRelayOptedIn(adapterEnv);
  });

  const resolveToken = deps.resolveToken ?? ((companyId: string, agentId: string) => resolveAshbyToken(db, { companyId, agentId }, env));

  const assertActiveRun = deps.assertActiveRun ?? (async (input: { companyId: string; agentId: string; runId: string }) => {
    const { heartbeatRuns } = await import("@paperclipai/db");
    const { and, eq } = await import("drizzle-orm");
    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .limit(1);
    return run?.status === "running";
  });

  router.post("/ashby-relay/:operation", async (req: Request, res: Response, next) => {
    try {
      // The run JWT only: an agent API key has no run, and a board user has no pod.
      const actor = req.actor;
      if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.agentId || !actor.companyId || !actor.runId) {
        return fail(res, 403, "forbidden");
      }

      // Require actual active run scoped to agent/company in the database, not just token claims.
      const runActive = await assertActiveRun({
        companyId: actor.companyId,
        agentId: actor.agentId,
        runId: actor.runId,
      });
      if (!runActive) {
        return fail(res, 403, "forbidden");
      }

      const config = parseAshbyRelayConfig(env);
      if (!config) {
        if (!warnedUnconfigured) {
          warnedUnconfigured = true;
          logger.warn("ashby relay is not configured or its settings are invalid; answering 503");
        }
        return fail(res, 503, "ashby_relay_unavailable");
      }

      const operation = req.params.operation as string;
      if (!OPERATION_RE.test(operation) || !config.operations.has(operation)) {
        return fail(res, 404, "not_found");
      }

      // Require JSON content-type consistently; reject missing or non-JSON media types.
      const contentType = req.header("content-type") ?? "";
      if (!JSON_CONTENT_TYPE_RE.test(contentType)) {
        return fail(res, 415, "json_required");
      }

      const raw = (req as unknown as { rawBody?: Buffer }).rawBody
        ?? (req.body ? Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body)) : Buffer.alloc(0));

      if (raw.length > ASHBY_RELAY_MAX_BODY_BYTES) {
        return fail(res, 413, "too_large");
      }

      let apiKey: string | null;
      try {
        if (!(await isOptedIn(actor.agentId))) {
          return fail(res, 403, "forbidden");
        }
        apiKey = await resolveToken(actor.companyId, actor.agentId);
      } catch (err) {
        logger.warn(
          { method: req.method, path: req.path, errorClass: err instanceof Error ? err.constructor.name : typeof err },
          "ashby relay lookup failed",
        );
        return fail(res, 503, "ashby_relay_unavailable");
      }

      // Fail closed 503 if neither company secret nor SSM-injected env key exists
      if (!apiKey) {
        return fail(res, 503, "ashby_relay_unavailable");
      }

      let upstream: globalThis.Response;
      try {
        upstream = await fetchImpl(`${config.base}/${encodeURIComponent(operation)}`, {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: raw.length > 0 ? new Uint8Array(raw) : new Uint8Array(Buffer.from("{}")),
          redirect: "manual",
          signal: AbortSignal.timeout(ASHBY_RELAY_DEADLINE_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        logger.warn(
          { method: req.method, path: req.path, errorClass: err instanceof Error ? err.name : typeof err, timedOut },
          "ashby relay upstream call failed",
        );
        return fail(res, timedOut ? 504 : 502, timedOut ? "ashby_relay_timeout" : "ashby_relay_unavailable");
      }

      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        return fail(res, 502, "ashby_relay_unavailable");
      }

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        const status = upstream.status === 404 ? 404 : upstream.status === 429 ? 429 : upstream.status === 400 ? 400 : 502;
        const detail = upstream.status === 404 ? "not_found" : upstream.status === 429 ? "rate_limited" : upstream.status === 400 ? "bad_request" : "ashby_relay_unavailable";
        return fail(res, status, detail);
      }

      const upstreamContentType = upstream.headers.get("content-type") ?? "";
      if (!JSON_CONTENT_TYPE_RE.test(upstreamContentType)) {
        await upstream.body?.cancel().catch(() => undefined);
        return fail(res, 502, "ashby_relay_unavailable");
      }

      const declared = Number(upstream.headers.get("content-length") ?? "0");
      if (declared > ASHBY_RELAY_MAX_BODY_BYTES) {
        await upstream.body?.cancel().catch(() => undefined);
        return fail(res, 502, "ashby_relay_unavailable");
      }

      const chunks: Buffer[] = [];
      let received = 0;
      try {
        const reader = upstream.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > ASHBY_RELAY_MAX_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            return fail(res, 502, "ashby_relay_unavailable");
          }
          chunks.push(Buffer.from(value));
        }
      } catch {
        return fail(res, 502, "ashby_relay_unavailable");
      }

      const body = Buffer.concat(chunks);
      if (apiKey && body.includes(apiKey)) {
        return fail(res, 502, "ashby_relay_unavailable");
      }

      res.status(upstream.status).type("application/json").send(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

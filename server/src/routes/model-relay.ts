import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  lookupModelRelay,
  MODEL_RELAY_ALLOWED_SUFFIXES,
  MODEL_RELAY_DEADLINE_MS,
  modelRelayProviderNameOk,
} from "@paperclipai/adapter-utils/model-relay";
import { logger } from "../middleware/logger.js";
import { guardedRemoteHttpFetch } from "../services/remote-http-fetch.js";

/**
 * TECH-10174: model relay for sandbox pods.
 *
 * A sandbox pod holds no model gateway key (the shared Ramp Router key). Its Pi provider is pointed at the sandbox bridge
 * (`${PAPERCLIP_API_URL}/api/model-relay/<provider>`), which forwards here with the run JWT. The adapter registered the
 * provider's upstream and key host-side for this run (`@paperclipai/adapter-utils/model-relay`), and this route adds the key
 * and forwards the request unchanged to `<upstream>/<suffix>`. Streaming (SSE) responses are passed through as they arrive.
 *
 * Fixed surface: POST only, a closed list of inference paths, HTTPS upstream, no redirects. Run JWT only, and the run must
 * be `running`. The registry entry exists only while the run does. Error bodies never echo upstream content or the key.
 */

/** Byte cap under the bridge limit (~10 MB), for the request and the response. */
export const MODEL_RELAY_MAX_BODY_BYTES = 10_000_000;

const JSON_CONTENT_TYPE_RE = /^application\/json\s*(;|$)/i;
const ANTHROPIC_VERSION = "2023-06-01";
const PASSED_RESPONSE_HEADERS = ["content-type", "retry-after", "cache-control"] as const;

export interface ModelRelayDeps {
  fetchImpl?: typeof fetch;
  /** Verifies that the run is an actual running run scoped to this agent and company. Replaceable in tests. */
  assertActiveRun?: (input: { companyId: string; agentId: string; runId: string }) => Promise<boolean>;
}

function fail(res: Response, status: number, detail: string) {
  res.status(status).json({ detail });
}

/** `https://host[:port]/path` with no credentials, query or fragment; trailing slashes dropped. Otherwise null. */
export function pinnedUpstreamBase(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function modelRelayRoutes(db: Db, deps: ModelRelayDeps = {}) {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? ((url: string | URL, init?: RequestInit) =>
    guardedRemoteHttpFetch(url, init ?? {}, {
      allowPrivateNetwork: false,
      error: (message, code) => new Error(`${code}: ${message}`),
      // The transport default is a 30 s headers/idle limit; a model turn can be silent far longer.
      responseTimeoutMs: MODEL_RELAY_DEADLINE_MS,
    }));
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

  const handler = (suffix: (typeof MODEL_RELAY_ALLOWED_SUFFIXES)[number]) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = req.actor;
        if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.agentId || !actor.companyId || !actor.runId) {
          return fail(res, 403, "forbidden");
        }
        const provider = req.params.provider as string;
        if (!modelRelayProviderNameOk(provider)) return fail(res, 404, "not_found");
        if (!(await assertActiveRun({ companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId }))) {
          return fail(res, 403, "forbidden");
        }
        const entry = lookupModelRelay(actor.runId, provider);
        const base = entry ? pinnedUpstreamBase(entry.upstreamBaseUrl) : null;
        if (!entry || !base) return fail(res, 404, "not_found");
        if (!JSON_CONTENT_TYPE_RE.test(req.header("content-type") ?? "")) return fail(res, 415, "json_required");

        const raw = (req as unknown as { rawBody?: Buffer }).rawBody
          ?? (req.body ? Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body)) : Buffer.alloc(0));
        if (raw.length > MODEL_RELAY_MAX_BODY_BYTES) return fail(res, 413, "too_large");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MODEL_RELAY_DEADLINE_MS);
        res.on("close", () => {
          clearTimeout(timer);
          controller.abort();
        });
        const accept = req.header("accept");
        let upstream: globalThis.Response;
        try {
          upstream = await fetchImpl(`${base}/${suffix}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${entry.apiKey}`,
              "x-api-key": entry.apiKey,
              "content-type": "application/json",
              ...(accept ? { accept } : {}),
              ...(suffix.endsWith("messages") ? { "anthropic-version": ANTHROPIC_VERSION } : {}),
            },
            body: new Uint8Array(raw),
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (err) {
          clearTimeout(timer);
          const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
          logger.warn(
            { agentId: actor.agentId, provider, errorClass: err instanceof Error ? err.name : typeof err, timedOut },
            "model relay upstream call failed",
          );
          return fail(res, timedOut ? 504 : 502, timedOut ? "model_relay_timeout" : "model_relay_unavailable");
        }
        if (upstream.status >= 300 && upstream.status < 400) {
          clearTimeout(timer);
          await upstream.body?.cancel().catch(() => undefined);
          return fail(res, 502, "model_relay_unavailable");
        }
        if (Number(upstream.headers.get("content-length") ?? "0") > MODEL_RELAY_MAX_BODY_BYTES) {
          clearTimeout(timer);
          await upstream.body?.cancel().catch(() => undefined);
          return fail(res, 502, "model_relay_too_large");
        }

        // Provider errors (400, 429, 5xx) pass through with their status so Pi's own retry logic keeps working.
        // Status and headers are applied only once the first body read succeeds, so a failed read can still answer a clean 502.
        const sendHead = () => {
          res.status(upstream.status);
          for (const name of PASSED_RESPONSE_HEADERS) {
            const value = upstream.headers.get(name);
            if (value) res.setHeader(name, value);
          }
          res.flushHeaders();
        };
        const keyBytes = Buffer.from(entry.apiKey);
        const holdBack = keyBytes.length - 1;
        let received = 0;
        // Bytes not yet written: the last `holdBack` bytes stay here until the next chunk proves they are not the start of a key.
        let pending: Buffer = Buffer.alloc(0);
        let headSent = false;
        try {
          const reader = upstream.body?.getReader();
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > MODEL_RELAY_MAX_BODY_BYTES) {
              await reader.cancel().catch(() => undefined);
              throw new Error("model relay response too large");
            }
            const window = Buffer.concat([pending, Buffer.from(value)]);
            if (window.includes(keyBytes)) {
              await reader.cancel().catch(() => undefined);
              throw new Error("model relay response refused");
            }
            if (!headSent) {
              sendHead();
              headSent = true;
            }
            const safe = Math.max(0, window.length - holdBack);
            if (safe > 0) res.write(window.subarray(0, safe));
            pending = window.subarray(safe);
          }
          if (!headSent) sendHead();
          if (pending.length > 0) res.write(pending);
          clearTimeout(timer);
          res.end();
        } catch {
          clearTimeout(timer);
          if (!res.headersSent) {
            res.removeHeader("content-type");
            res.removeHeader("cache-control");
            res.removeHeader("retry-after");
            return fail(res, 502, "model_relay_unavailable");
          }
          res.destroy();
        }
      } catch (err) {
        next(err);
      }
    };

  // Literal paths, one per allowed suffix (MODEL_RELAY_ALLOWED_SUFFIXES).
  router.post("/model-relay/:provider/chat/completions", handler("chat/completions"));
  router.post("/model-relay/:provider/completions", handler("completions"));
  router.post("/model-relay/:provider/responses", handler("responses"));
  router.post("/model-relay/:provider/messages", handler("messages"));
  // Anthropic SDK clients with a host-root baseUrl (Router serves Claude that way) append /v1/messages.
  router.post("/model-relay/:provider/v1/messages", handler("v1/messages"));

  return router;
}

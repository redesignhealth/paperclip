import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { tailnetAwareFetch } from "../services/remote-http-fetch.js";
import { secretService } from "../services/secrets.js";

/**
 * TECH-9786: read-only relay to the private Gitea PyPI registry for sandboxed builder agents.
 *
 * A sandbox pod cannot reach the tailnet and holds no credentials. The pod's package installer (uv or pip) points an
 * extra index at the sandbox bridge, which forwards here with the run JWT. This server adds the Gitea read token, so the
 * credential never enters the pod. Fixed surface, GET only: `simple/:package/` and `files/:package/:version/:filename`.
 * The upstream is ONLY the server's configured `PAPERCLIP_PACKAGE_RELAY_GITEA_URL`, and only for packages named in
 * `PAPERCLIP_PACKAGE_RELAY_GITEA_PACKAGES`; nothing in a request can choose the host, the path or another package.
 * Only agents that opt in (adapterConfig env `PAPERCLIP_PACKAGE_RELAY` lists `gitea`) may use it, so the registry is not
 * opened to every sandbox agent. The token is the company secret `package_relay.gitea`.
 */

export const PACKAGE_RELAY_GITEA_URL_ENV = "PAPERCLIP_PACKAGE_RELAY_GITEA_URL";
export const PACKAGE_RELAY_GITEA_PACKAGES_ENV = "PAPERCLIP_PACKAGE_RELAY_GITEA_PACKAGES";
export const PACKAGE_RELAY_GITEA_USER_ENV = "PAPERCLIP_PACKAGE_RELAY_GITEA_USER";
export const PACKAGE_RELAY_GITEA_SECRET_KEY = "package_relay.gitea";
/** The agent adapterConfig env key that opts an agent in. Comma-separated list of relay names. */
export const PACKAGE_RELAY_OPT_IN_ENV_KEY = "PAPERCLIP_PACKAGE_RELAY";

export const PACKAGE_RELAY_DEADLINE_MS = 60_000;
export const PACKAGE_RELAY_MAX_INDEX_BYTES = 2_000_000;
export const PACKAGE_RELAY_MAX_FILE_BYTES = 200_000_000;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,127}$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,200}\.(?:whl|tar\.gz|zip)$/;

export interface PackageRelayDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** True when the agent opted in to the named relay. Replaceable in tests. */
  isOptedIn?: (agentId: string, relay: string) => Promise<boolean>;
  /** The company's Gitea read token, or null when none is stored. Replaceable in tests. */
  resolveToken?: (companyId: string) => Promise<string | null>;
}

/** PEP 503 name normalization. */
export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function fail(res: Response, status: number, detail: string) {
  res.status(status).json({ detail });
}

function parseOptIn(value: unknown): string[] {
  const raw = value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value;
  return typeof raw === "string" ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
}

export function packageRelayRoutes(db: Db, deps: PackageRelayDeps = {}) {
  const router = Router();
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? tailnetAwareFetch;
  const isOptedIn = deps.isOptedIn ?? (async (agentId: string, relay: string) => {
    // Loaded on first use: the agent service pulls in most of the server.
    const { agentService } = await import("../services/agents.js");
    const agent = await agentService(db).getById(agentId);
    const adapterEnv = (agent?.adapterConfig as { env?: Record<string, unknown> } | null | undefined)?.env;
    return parseOptIn(adapterEnv?.[PACKAGE_RELAY_OPT_IN_ENV_KEY]).includes(relay);
  });
  const resolveToken = deps.resolveToken ?? (async (companyId: string) => {
    const secrets = secretService(db);
    const secret = await secrets.getByKey(companyId, PACKAGE_RELAY_GITEA_SECRET_KEY);
    if (!secret || secret.status !== "active") return null;
    return secrets.resolveSecretValue(companyId, secret.id, "latest");
  });

  function giteaConfig(): { base: string; packages: Set<string>; user: string } | null {
    const url = env[PACKAGE_RELAY_GITEA_URL_ENV]?.trim().replace(/\/+$/, "");
    const packages = (env[PACKAGE_RELAY_GITEA_PACKAGES_ENV] ?? "").split(",").map((p) => normalizePackageName(p.trim())).filter((p) => NAME_RE.test(p));
    if (!url || packages.length === 0) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return { base: url, packages: new Set(packages), user: env[PACKAGE_RELAY_GITEA_USER_ENV]?.trim() || "paperclip-relay" };
  }

  /** Authorize the caller and fetch `path` (under the configured base) with the company's read token. */
  async function upstreamGet(req: Request, res: Response, pkg: string, path: (base: string) => string, maxBytes: number) {
    // The run JWT only: an agent API key has no run, and a board user has no pod.
    const actor = req.actor;
    if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.agentId || !actor.companyId || !actor.runId) {
      fail(res, 403, "forbidden");
      return null;
    }
    const config = giteaConfig();
    if (!config) {
      fail(res, 503, "package_relay_unavailable");
      return null;
    }
    const normalized = normalizePackageName(pkg);
    if (!NAME_RE.test(normalized) || !config.packages.has(normalized)) {
      fail(res, 404, "not_found");
      return null;
    }
    let token: string | null;
    try {
      if (!(await isOptedIn(actor.agentId, "gitea"))) {
        fail(res, 403, "forbidden");
        return null;
      }
      token = await resolveToken(actor.companyId);
    } catch (err) {
      logger.warn({ agentId: actor.agentId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "package relay lookup failed");
      fail(res, 503, "package_relay_unavailable");
      return null;
    }
    if (!token) {
      fail(res, 403, "forbidden");
      return null;
    }
    let upstream: globalThis.Response;
    try {
      upstream = await fetchImpl(path(config.base), {
        method: "GET",
        headers: { authorization: `Basic ${Buffer.from(`${config.user}:${token}`).toString("base64")}` },
        redirect: "manual",
        signal: AbortSignal.timeout(PACKAGE_RELAY_DEADLINE_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logger.warn({ agentId: actor.agentId, errorClass: err instanceof Error ? err.name : typeof err, timedOut }, "package relay upstream call failed");
      fail(res, timedOut ? 504 : 502, timedOut ? "package_relay_timeout" : "package_relay_unavailable");
      return null;
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      fail(res, 502, "package_relay_unavailable");
      return null;
    }
    if (upstream.status === 404) {
      await upstream.body?.cancel().catch(() => undefined);
      fail(res, 404, "not_found");
      return null;
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      fail(res, 502, "package_relay_unavailable");
      return null;
    }
    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await upstream.body?.cancel().catch(() => undefined);
      fail(res, 502, "package_relay_unavailable");
      return null;
    }
    let body: Buffer;
    try {
      body = Buffer.from(await upstream.arrayBuffer());
    } catch {
      fail(res, 502, "package_relay_unavailable");
      return null;
    }
    if (body.length > maxBytes) {
      fail(res, 502, "package_relay_unavailable");
      return null;
    }
    return { body, base: config.base };
  }

  router.get("/package-relay/gitea/simple/:package/", (req, res, next) => {
    const pkg = req.params.package as string;
    upstreamGet(req, res, pkg, (base) => `${base}/simple/${encodeURIComponent(normalizePackageName(pkg))}/`, PACKAGE_RELAY_MAX_INDEX_BYTES)
      .then((result) => {
        if (!result) return;
        // Keep only links to this registry's own files, rewritten to the relay. Any other link is dropped, so the
        // page can never point the installer at another host.
        const filesPrefix = `${result.base}/files/`;
        const html = result.body.toString("utf8").replace(/<a\b[^>]*>[\s\S]*?<\/a>\s*(?:<br\s*\/?>)?/gi, (anchor) => {
          const href = /\bhref="([^"]*)"/i.exec(anchor)?.[1]?.replace(/&amp;/g, "&");
          if (!href) return "";
          const [target, fragment] = href.split("#", 2) as [string, string | undefined];
          if (!target.startsWith(filesPrefix)) return "";
          const parts = target.slice(filesPrefix.length).split("/");
          if (parts.length !== 3 || !parts.every((p) => p === decodeURIComponent(p))) return "";
          const [name, version, filename] = parts as [string, string, string];
          if (normalizePackageName(name) !== normalizePackageName(pkg) || !SEGMENT_RE.test(version) || !FILENAME_RE.test(filename)) return "";
          const rewritten = `../../files/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}${fragment ? `#${fragment}` : ""}`;
          return anchor.replace(/\bhref="[^"]*"/i, `href="${rewritten.replace(/&/g, "&amp;")}"`);
        });
        res.status(200).type("text/html").send(html);
      })
      .catch(next);
  });

  router.get("/package-relay/gitea/files/:package/:version/:filename", (req, res, next) => {
    const { package: pkg, version, filename } = req.params as Record<string, string>;
    if (!SEGMENT_RE.test(version!) || !FILENAME_RE.test(filename!)) return fail(res, 404, "not_found");
    upstreamGet(req, res, pkg!, (base) => `${base}/files/${encodeURIComponent(pkg!)}/${encodeURIComponent(version!)}/${encodeURIComponent(filename!)}`, PACKAGE_RELAY_MAX_FILE_BYTES)
      .then((result) => {
        if (!result) return;
        res.status(200).type("application/octet-stream").send(result.body);
      })
      .catch(next);
  });

  return router;
}

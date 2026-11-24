import express, { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { tailnetAwareFetch } from "../services/remote-http-fetch.js";
import { secretService } from "../services/secrets.js";
import { GITHUB_APP_READ_PERMISSIONS, mintGitHubAppInstallationToken } from "../services/github-app-installation.js";
import { PACKAGE_RELAY_OPT_IN_ENV_KEY } from "./package-relay.js";

/**
 * TECH-9786: read-only git smart-HTTP relay to GitHub for sandboxed builder agents (the `rh-maiea` git pin).
 *
 * A builder pod holds no GitHub credential. Its git client is pointed (insteadOf) at the sandbox bridge, which forwards
 * here with the run JWT, and this server adds the GitHub read token. Fixed surface, fetch only:
 * `GET .../info/refs?service=git-upload-pack` and `POST .../git-upload-pack`. Pushing (`git-receive-pack`) is refused.
 * Only repositories named in `PAPERCLIP_PACKAGE_RELAY_GITHUB_REPOS` (`owner/name,owner/name`) are served, and the upstream
 * is always `https://github.com/<owner>/<name>.git`. Only agents that opt in (`PAPERCLIP_PACKAGE_RELAY` lists `github`)
 * may use it. The token is the company secret `package_relay.github` when one is stored. Without it, the server mints a
 * GitHub App installation token scoped to exactly the requested repository with `contents: read` (TECH-9792), so no
 * long-lived read token has to be stored. It fails closed (503) when not configured.
 * Same auth and opt-in model as the Gitea package relay (`package-relay.ts`).
 */

export const PACKAGE_RELAY_GITHUB_REPOS_ENV = "PAPERCLIP_PACKAGE_RELAY_GITHUB_REPOS";
export const PACKAGE_RELAY_GITHUB_SECRET_KEY = "package_relay.github";
const GITHUB_ORIGIN = "https://github.com";

export const GIT_RELAY_DEADLINE_MS = 60_000;
export const GIT_RELAY_MAX_REQUEST_BYTES = 1_000_000;
/** The sandbox bridge refuses a response body above its limit (about 10 MB), so a larger pack could never reach the pod. */
export const GIT_RELAY_MAX_RESPONSE_BYTES = 10_000_000;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ADVERTISEMENT_TYPE = "application/x-git-upload-pack-advertisement";
const RESULT_TYPE = "application/x-git-upload-pack-result";
const REQUEST_TYPE = "application/x-git-upload-pack-request";

export interface PackageRelayGitDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  isOptedIn?: (agentId: string, relay: string) => Promise<boolean>;
  resolveToken?: (companyId: string, repository: string) => Promise<string | null>;
}

function fail(res: Response, status: number, detail: string) {
  res.status(status).json({ detail });
}

function parseOptIn(value: unknown): string[] {
  const raw = value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value;
  return typeof raw === "string" ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
}

/** `owner/name` entries, lower-cased. Any invalid entry makes the whole configuration invalid (null). */
export function parseGithubRepoAllowlist(value: string | undefined): Set<string> | null {
  const entries = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const repos = new Set<string>();
  for (const entry of entries) {
    const [owner, name, ...rest] = entry.split("/");
    if (rest.length > 0 || !owner || !name || !OWNER_RE.test(owner) || !REPO_RE.test(name) || name.endsWith(".git") || name === "." || name === "..") return null;
    repos.add(`${owner}/${name}`.toLowerCase());
  }
  return repos;
}

export function packageRelayGitRoutes(db: Db, deps: PackageRelayGitDeps = {}) {
  const router = Router();
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? tailnetAwareFetch;
  let warnedUnconfigured = false;
  const isOptedIn = deps.isOptedIn ?? (async (agentId: string, relay: string) => {
    // Loaded on first use: the agent service pulls in most of the server.
    const { agentService } = await import("../services/agents.js");
    const agent = await agentService(db).getById(agentId);
    const adapterEnv = (agent?.adapterConfig as { env?: Record<string, unknown> } | null | undefined)?.env;
    return parseOptIn(adapterEnv?.[PACKAGE_RELAY_OPT_IN_ENV_KEY]).includes(relay);
  });
  const resolveToken = deps.resolveToken ?? (async (companyId: string, repository: string) => {
    const secrets = secretService(db);
    const secret = await secrets.getByKey(companyId, PACKAGE_RELAY_GITHUB_SECRET_KEY);
    if (secret && secret.status === "active") return secrets.resolveSecretValue(companyId, secret.id, "latest");
    // No stored token: a read-only App installation token for this one allowlisted repository.
    const minted = await mintGitHubAppInstallationToken({ repositories: [repository], permissions: GITHUB_APP_READ_PERMISSIONS, env });
    return minted.ok ? minted.value.token : null;
  });

  async function relay(req: Request, res: Response, input: { method: "GET" | "POST"; suffix: string; accept: string; expectType: string; body?: Buffer; contentType?: string }) {
    // The run JWT only: an agent API key has no run, and a board user has no pod.
    const actor = req.actor;
    if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.agentId || !actor.companyId || !actor.runId) return fail(res, 403, "forbidden");
    const allowlist = parseGithubRepoAllowlist(env[PACKAGE_RELAY_GITHUB_REPOS_ENV]);
    if (!allowlist) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        logger.warn("git relay is not configured or its repository list is invalid; answering 503");
      }
      return fail(res, 503, "git_relay_unavailable");
    }
    const owner = req.params.owner as string;
    const repoParam = req.params.repo as string;
    const repo = repoParam.endsWith(".git") ? repoParam.slice(0, -4) : repoParam;
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || !allowlist.has(`${owner}/${repo}`.toLowerCase())) return fail(res, 404, "not_found");

    let token: string | null;
    try {
      if (!(await isOptedIn(actor.agentId, "github"))) return fail(res, 403, "forbidden");
      token = await resolveToken(actor.companyId, `${owner}/${repo}`);
    } catch (err) {
      logger.warn({ agentId: actor.agentId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "git relay lookup failed");
      return fail(res, 503, "git_relay_unavailable");
    }
    if (!token) return fail(res, 403, "forbidden");

    let upstream: globalThis.Response;
    try {
      upstream = await fetchImpl(`${GITHUB_ORIGIN}/${owner}/${repo}.git/${input.suffix}`, {
        method: input.method,
        headers: {
          authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          accept: input.accept,
          "user-agent": "git/2.0 (paperclip-package-relay)",
          ...(input.contentType ? { "content-type": input.contentType } : {}),
        },
        ...(input.body ? { body: new Uint8Array(input.body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(GIT_RELAY_DEADLINE_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logger.warn({ agentId: actor.agentId, errorClass: err instanceof Error ? err.name : typeof err, timedOut }, "git relay upstream call failed");
      return fail(res, timedOut ? 504 : 502, timedOut ? "git_relay_timeout" : "git_relay_unavailable");
    }
    if (upstream.status === 404 || upstream.status === 401 || upstream.status === 403) {
      // A repository the token cannot read looks like a missing one; never pass GitHub's body through.
      await upstream.body?.cancel().catch(() => undefined);
      return fail(res, 404, "not_found");
    }
    const contentType = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (upstream.status !== 200 || contentType !== input.expectType) {
      await upstream.body?.cancel().catch(() => undefined);
      return fail(res, 502, "git_relay_unavailable");
    }
    // Read with a hard cap so a missing or wrong content-length cannot make the server buffer a huge body.
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      const reader = upstream.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > GIT_RELAY_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return fail(res, 502, "git_relay_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    } catch {
      return fail(res, 502, "git_relay_unavailable");
    }
    res.status(200).set("cache-control", "no-cache").type(input.expectType).send(Buffer.concat(chunks));
  }

  router.get("/package-relay/github/:owner/:repo/info/refs", (req, res, next) => {
    // Fetch only. `git-receive-pack` (push) and anything else is refused.
    if (req.query.service !== "git-upload-pack") return fail(res, 403, "forbidden");
    relay(req, res, { method: "GET", suffix: "info/refs?service=git-upload-pack", accept: "*/*", expectType: ADVERTISEMENT_TYPE }).catch(next);
  });

  router.post(
    "/package-relay/github/:owner/:repo/git-upload-pack",
    express.raw({ type: REQUEST_TYPE, limit: GIT_RELAY_MAX_REQUEST_BYTES }),
    (req, res, next) => {
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.length === 0) return fail(res, 415, "git_request_required");
      relay(req, res, { method: "POST", suffix: "git-upload-pack", accept: RESULT_TYPE, expectType: RESULT_TYPE, body, contentType: REQUEST_TYPE }).catch(next);
    },
  );

  return router;
}

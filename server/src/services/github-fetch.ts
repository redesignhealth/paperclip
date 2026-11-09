import { HttpError, unprocessable } from "../errors.js";
import { guardedRemoteHttpFetch, type GuardedRemoteHttpFetchOptions } from "./remote-http-fetch.js";

export function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches a user-supplied GitHub/GHE URL. The egress guard runs on the first URL and on every
 * redirect hop, and credentials are dropped when a hop leaves the original origin.
 */
export async function ghFetch(
  url: string,
  init?: RequestInit,
  guard: Partial<GuardedRemoteHttpFetchOptions> = {},
): Promise<Response> {
  let current = new URL(url);
  let headers = new Headers(init?.headers);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await guardedRemoteHttpFetch(current, { ...init, headers }, {
        allowPrivateNetwork: false,
        error: (message, code) => unprocessable(message, { code }),
        ...guard,
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unprocessable(`Could not connect to ${current.hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (!location) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw unprocessable("GitHub URL redirected too many times", { code: "github_redirect_limit" });
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw unprocessable("GitHub URL redirected to an invalid location", { code: "github_redirect_invalid" });
    }
    if (next.origin !== current.origin) {
      headers = new Headers(headers);
      headers.delete("authorization");
      headers.delete("cookie");
    }
    current = next;
  }
}

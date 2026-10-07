import type { ChatProvider } from "@paperclipai/shared";

export interface ChatProviderResourceInventoryItem {
  providerResourceId: string;
  parentProviderResourceId?: string;
  type: string;
  label: string;
  providerUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatProviderInventoryResult {
  provider: ChatProvider;
  resources: ChatProviderResourceInventoryItem[];
}

export interface GitHubAppInstallationIdentity {
  installationId: string;
  accountId?: string;
  accountLabel?: string;
  accountType?: string;
  permissions: Record<string, string>;
}

const REQUIRED_GITHUB_INSTALLATION_PERMISSIONS = {
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;
const SLACK_API_TIMEOUT_MS = 25_000;
const GITHUB_API_TIMEOUT_MS = 25_000;
/**
 * Slack answers a rate-limited call with HTTP 429 and a `Retry-After` header
 * in seconds. Wait that long and retry, within a budget that is shared by every
 * page of one inventory call so a paginated listing cannot stall for minutes.
 * A `Retry-After` beyond the cap is not waited out: the caller is an HTTP
 * request handler, and a retry after a shorter wait would only burn budget.
 * The budget and cap keep the worst-case sleep (2 × 20 s) under the 60 s idle
 * timeout of the proxies in front of the server, so a rate-limited connect
 * still returns Paperclip's own error rather than a proxy 504.
 */
const SLACK_RATE_LIMIT_MAX_RETRIES = 2;
const SLACK_RATE_LIMIT_MAX_WAIT_MS = 20_000;
const SLACK_RATE_LIMIT_DEFAULT_WAIT_MS = 1_000;

interface SlackRetryBudget {
  retriesLeft: number;
}

function slackRequestSignal(): AbortSignal {
  return AbortSignal.timeout(SLACK_API_TIMEOUT_MS);
}

/** Wait to honour, or `null` when Slack asks for longer than the cap. */
function slackRetryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return SLACK_RATE_LIMIT_DEFAULT_WAIT_MS;
  }
  const ms = seconds * 1_000;
  return ms > SLACK_RATE_LIMIT_MAX_WAIT_MS ? null : ms;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Never keep the process alive for a rate-limit wait during shutdown.
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Issue one Slack Web API GET. On 429, drain the response, wait out
 * `Retry-After` and retry while the budget lasts; otherwise fail closed with
 * a message that names the rate limit rather than a bare status.
 */
async function slackGet(input: {
  url: URL;
  botToken: string;
  fetch: typeof globalThis.fetch;
  signal: () => AbortSignal;
  budget: SlackRetryBudget;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Response> {
  const sleep = input.sleep ?? defaultSleep;
  for (;;) {
    const response = await input.fetch(input.url, {
      headers: { authorization: `Bearer ${input.botToken}` },
      signal: input.signal(),
    });
    if (response.status !== 429) return response;
    const waitMs = slackRetryAfterMs(response);
    // The 429 body is never read; release its socket before waiting or failing.
    // Best effort: a cancel failure must not replace the rate-limit message.
    await response.body?.cancel().catch(() => {});
    if (input.budget.retriesLeft <= 0) {
      throw new Error(
        "Slack inventory failed: rate limited (HTTP 429); retries exhausted, " +
          "try again later",
      );
    }
    if (waitMs === null) {
      throw new Error(
        "Slack inventory failed: rate limited (HTTP 429) and Slack asked to " +
          `wait longer than ${SLACK_RATE_LIMIT_MAX_WAIT_MS / 1_000}s; try again later`,
      );
    }
    input.budget.retriesLeft -= 1;
    await sleep(waitMs);
  }
}

function githubRequestSignal(): AbortSignal {
  return AbortSignal.timeout(GITHUB_API_TIMEOUT_MS);
}

async function jsonResponse<T>(
  response: Response,
  provider: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${provider} returned an unreadable inventory response`);
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : String(response.status);
    throw new Error(`${provider} inventory failed: ${message}`);
  }
  return body as T;
}

/**
 * List only Slack conversations where the installed bot is a member.
 *
 * Uses `users.conversations`, which returns the calling bot's own memberships
 * (one page for a freshly installed bot), rather than sweeping every channel
 * in the workspace with `conversations.list` and filtering on `is_member`
 * afterwards: that sweep exceeds Slack's per-minute budget for the method in
 * large workspaces, and each retry starts over from the first page.
 */
export async function listSlackBotChannels(input: {
  botToken: string;
  fetch: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ChatProviderInventoryResult> {
  const resources: ChatProviderResourceInventoryItem[] = [];
  const budget: SlackRetryBudget = { retriesLeft: SLACK_RATE_LIMIT_MAX_RETRIES };
  let cursor = "";
  do {
    const url = new URL("https://slack.com/api/users.conversations");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await slackGet({
      url,
      botToken: input.botToken,
      fetch: input.fetch,
      signal: slackRequestSignal,
      budget,
      sleep: input.sleep,
    });
    const body = await jsonResponse<{
      ok?: boolean;
      error?: string;
      channels?: Array<{
        id?: string;
        name?: string;
        is_member?: boolean;
        is_private?: boolean;
        is_archived?: boolean;
        context_team_id?: string;
      }>;
      response_metadata?: { next_cursor?: string };
    }>(response, "Slack");
    if (!body.ok)
      throw new Error(
        `Slack inventory failed: ${body.error ?? "unknown error"}`,
      );
    for (const channel of body.channels ?? []) {
      // Every row is a membership of the calling bot, whether or not Slack
      // echoes `is_member`; drop a row only when it says false. Archived rows
      // are already excluded by `exclude_archived` above; the guard is a safety net.
      if (!channel.id || channel.is_member === false || channel.is_archived)
        continue;
      resources.push({
        providerResourceId: channel.id,
        type: "channel",
        label: channel.name ? `#${channel.name}` : channel.id,
        metadata: {
          private: channel.is_private === true,
          ...(channel.context_team_id
            ? { contextTeamId: channel.context_team_id }
            : {}),
          source: "provider_inventory",
        },
      });
    }
    cursor = body.response_metadata?.next_cursor?.trim() ?? "";
  } while (cursor);
  return { provider: "slack", resources };
}

/** Resolve one newly joined Slack channel to its provider-authoritative label. */
export async function getSlackBotChannel(input: {
  botToken: string;
  channelId: string;
  fetch: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ChatProviderResourceInventoryItem | null> {
  const url = new URL("https://slack.com/api/conversations.info");
  url.searchParams.set("channel", input.channelId);
  const response = await slackGet({
    url,
    botToken: input.botToken,
    fetch: input.fetch,
    signal: () => AbortSignal.timeout(5_000),
    // One retry only, fewer than the paginated listing: this runs inside
    // message processing, which shutdown awaits, so a single label lookup must
    // not wait out several rate-limit windows. The caller falls back to the id.
    budget: { retriesLeft: 1 },
    sleep: input.sleep,
  });
  const body = await jsonResponse<{
    ok?: boolean;
    error?: string;
    channel?: {
      id?: string;
      name?: string;
      is_member?: boolean;
      is_private?: boolean;
      is_archived?: boolean;
      context_team_id?: string;
    };
  }>(response, "Slack");
  if (!body.ok) {
    throw new Error(`Slack inventory failed: ${body.error ?? "unknown error"}`);
  }
  const channel = body.channel;
  if (
    !channel?.id ||
    channel.id !== input.channelId ||
    channel.is_member === false ||
    channel.is_archived
  ) {
    return null;
  }
  return {
    providerResourceId: channel.id,
    type: "channel",
    label: channel.name ? `#${channel.name}` : channel.id,
    metadata: {
      private: channel.is_private === true,
      ...(channel.context_team_id
        ? { contextTeamId: channel.context_team_id }
        : {}),
      source: "provider_inventory",
    },
  };
}

/**
 * Exchange a GitHub App JWT for a short-lived installation token and list the
 * repositories selected for that installation. The token never leaves this
 * function and is never persisted in Paperclip.
 */
export async function listGitHubInstallationRepositories(input: {
  appJwt: string;
  installationId: string;
  fetch: typeof globalThis.fetch;
}): Promise<ChatProviderInventoryResult> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.appJwt}`,
    "x-github-api-version": "2022-11-28",
  };
  const tokenResponse = await input.fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    { method: "POST", headers, signal: githubRequestSignal() },
  );
  const tokenBody = await jsonResponse<{ token?: string; message?: string }>(
    tokenResponse,
    "GitHub",
  );
  if (!tokenBody.token)
    throw new Error("GitHub inventory failed: installation token was missing");

  const resources: ChatProviderResourceInventoryItem[] = [];
  let page = 1;
  try {
    while (true) {
      const url = new URL("https://api.github.com/installation/repositories");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const response = await input.fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${tokenBody.token}`,
          "x-github-api-version": "2022-11-28",
        },
        signal: githubRequestSignal(),
      });
      const body = await jsonResponse<{
        repositories?: Array<{
          id?: number;
          name?: string;
          full_name?: string;
          html_url?: string;
          owner?: { id?: number; login?: string };
          private?: boolean;
        }>;
      }>(response, "GitHub");
      const repositories = body.repositories ?? [];
      for (const repository of repositories) {
        if (!Number.isFinite(repository.id)) continue;
        const id = String(repository.id);
        resources.push({
          providerResourceId: id,
          parentProviderResourceId: repository.owner?.id
            ? String(repository.owner.id)
            : undefined,
          type: "repository",
          label: repository.full_name ?? repository.name ?? id,
          providerUrl:
            repository.html_url ??
            (repository.full_name
              ? `https://github.com/${repository.full_name}`
              : undefined),
          metadata: {
            private: repository.private === true,
            ...(repository.owner?.login
              ? { owner: repository.owner.login }
              : {}),
            source: "provider_inventory",
          },
        });
      }
      if (repositories.length < 100) break;
      page += 1;
    }
  } finally {
    // Avoid keeping the installation token reachable longer than the request
    // scope. JavaScript strings cannot be reliably zeroed, but this prevents
    // accidental return/persistence through the inventory result.
    tokenBody.token = undefined;
  }
  return { provider: "github", resources };
}

/**
 * Resolve the one installation belonging to a dedicated per-agent GitHub App.
 * Keeping one app identity per endpoint is the same invariant used for Slack
 * and Teams bots; it also avoids exposing an installation-id field to users.
 */
export async function discoverDedicatedGitHubAppInstallation(input: {
  appJwt: string;
  fetch: typeof globalThis.fetch;
}): Promise<GitHubAppInstallationIdentity> {
  const installations: Array<{
    id?: number;
    account?: { id?: number; login?: string; name?: string; type?: string };
    permissions?: Record<string, string>;
    suspended_at?: string | null;
  }> = [];
  for (let page = 1; ; page += 1) {
    const response = await input.fetch(
      page === 1
        ? "https://api.github.com/app/installations?per_page=100"
        : `https://api.github.com/app/installations?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.appJwt}`,
          "x-github-api-version": "2022-11-28",
        },
        signal: githubRequestSignal(),
      },
    );
    const pageInstallations = await jsonResponse<
      Array<{
        id?: number;
        account?: { id?: number; login?: string; name?: string; type?: string };
        permissions?: Record<string, string>;
        suspended_at?: string | null;
      }>
    >(response, "GitHub");
    installations.push(...pageInstallations);
    if (pageInstallations.length < 100) break;
  }
  const active = installations.filter(
    (installation) =>
      Number.isFinite(installation.id) && !installation.suspended_at,
  );
  if (active.length === 0) {
    throw new Error(
      "GitHub inventory failed: install this GitHub App on the selected repositories first",
    );
  }
  if (active.length !== 1) {
    throw new Error(
      "GitHub inventory failed: this chat connection requires a dedicated GitHub App with exactly one active installation",
    );
  }
  const installation = active[0]!;
  const missingPermissions = Object.entries(
    REQUIRED_GITHUB_INSTALLATION_PERMISSIONS,
  )
    .filter(
      ([permission, access]) =>
        installation.permissions?.[permission] !== access,
    )
    .map(([permission]) => permission);
  if (missingPermissions.length > 0) {
    throw new Error(
      `GitHub inventory failed: the active installation has not granted the required access for: ${missingPermissions.join(", ")}. Approve the GitHub App permission update, then retry`,
    );
  }
  return {
    installationId: String(installation.id),
    accountId: Number.isFinite(installation.account?.id)
      ? String(installation.account?.id)
      : undefined,
    accountLabel:
      installation.account?.login ?? installation.account?.name ?? undefined,
    accountType: installation.account?.type,
    permissions: installation.permissions ?? {},
  };
}

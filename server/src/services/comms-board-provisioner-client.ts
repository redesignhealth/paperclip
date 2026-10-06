/**
 * Thin clients for the two EXISTING downstream calls Redesign AI's `POST /admin/bots` makes to
 * give a bot a comms-board presence (TECH-7204). Paperclip calls them directly instead of the
 * whole admin route, which would also create an unrelated Redesign AI user + `api_key` and needs
 * broad `redesign-ai:rh:admin` authority. No new token service or registry is introduced.
 *
 * 1. Board identity: agent-comms-mcp `comms_admin_register` (JSON-RPC `tools/call` over
 *    Streamable HTTP, POST to the full MCP endpoint, Bearer = a `comms:admin` credential).
 *    Returns the board `agent_id` UUID, which Redesign AI discards and Paperclip persists.
 *    Never upserts (`already_registered`).
 * 2. Board credential: agent-comms-approvals `ownership_api` `POST {base}/agents`
 *    (Bearer = `ownership:write`). Body `{sub, owner_email, scopes, expires_in_days}`.
 *    201 `{sub, owner_email, active, token, token_expires_at}`. Insert-only: 409 when `sub`
 *    exists. A lost response leaves a valid token until it expires.
 *
 * Both credentials are SERVER control-plane config (env). They are never granted to the agent:
 * the agent's own token carries only `comms:read` + `comms:write`. Without all four values the
 * caller records a visible pending state and nothing is called. Neither call is retried.
 *
 * Identity recipe: the token `sub` is the base (`paperclip-agent-<agentId>`, never contains
 * "::"); fresh registration uses the bare base sub (`agentKey: null`), while legacy registered
 * agents preserve their existing keyed bindings.
 */
import { randomUUID } from "node:crypto";
import type { DefaultMcpSetupReason } from "./default-mcp-spec.js";
import {
  buildMcpToolCallRequest,
  extractMcpToolCallResult,
  findJsonRpcResponse,
  initializeMcpHttpSession,
  McpHttpInitializationError,
  readMcpHttpResponseText,
  terminateMcpHttpSession,
} from "./mcp-http.js";

export const COMMS_BOARD_MCP_URL_ENV = "PAPERCLIP_COMMS_BOARD_MCP_URL";
export const COMMS_BOARD_ADMIN_TOKEN_ENV = "PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN";
export const COMMS_BOARD_OWNERSHIP_API_URL_ENV = "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL";
export const COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV = "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN";

export const COMMS_BOARD_REQUEST_TIMEOUT_MS = 10_000;
/** ownership_api's own default; Redesign AI's route passes 180 explicitly. Paperclip uses the shorter default. */
export const COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS = 30;
/** Never `comms:admin` or `ownership:*`. Matches Redesign AI's `_BOARD_CREDENTIAL_SCOPES`. */
export const COMMS_BOARD_TOKEN_SCOPES = ["comms:read", "comms:write"] as const;

const BASE_SUB_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommsBoardProvisionerConfig {
  boardMcpUrl: string;
  boardAdminToken: string;
  ownershipApiUrl: string;
  ownershipApiToken: string;
}

/** Loopback names that may be reached over plain HTTP (local development only). */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A usable endpoint is an absolute `https:` URL (any host: the board and ownership APIs may sit on a
 * private tailnet), or `http:` for a loopback hostname only. Userinfo, a query string or a fragment
 * are refused so a credential can never ride in the URL. The full path is preserved as written.
 */
function validEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

export type CommsBoardProvisionerConfigResult =
  | { ok: true; config: CommsBoardProvisionerConfig }
  | { ok: false; reason: "provisioner_not_configured" | "provisioner_config_invalid" };

/** Closed-enum outcome: missing settings and invalid URLs are both a waiting state, decided before any fetch. */
export function resolveCommsBoardProvisionerConfig(
  env: NodeJS.ProcessEnv = process.env,
): CommsBoardProvisionerConfigResult {
  const boardMcpUrl = env[COMMS_BOARD_MCP_URL_ENV]?.trim();
  const boardAdminToken = env[COMMS_BOARD_ADMIN_TOKEN_ENV]?.trim();
  const ownershipApiUrl = env[COMMS_BOARD_OWNERSHIP_API_URL_ENV]?.trim();
  const ownershipApiToken = env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]?.trim();
  if (!boardMcpUrl || !boardAdminToken || !ownershipApiUrl || !ownershipApiToken) {
    return { ok: false, reason: "provisioner_not_configured" };
  }
  if (!validEndpoint(boardMcpUrl) || !validEndpoint(ownershipApiUrl)) {
    return { ok: false, reason: "provisioner_config_invalid" };
  }
  return {
    ok: true,
    config: {
      boardMcpUrl,
      boardAdminToken,
      ownershipApiUrl: ownershipApiUrl.replace(/\/+$/, ""),
      ownershipApiToken,
    },
  };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Stable identity values derived once from immutable inputs, then persisted. */
export function composeCommsBoardIdentity(agentId: string) {
  const baseSub = `paperclip-agent-${agentId.toLowerCase()}`;
  if (!BASE_SUB_PATTERN.test(baseSub) || baseSub.includes("::")) return null;
  return { baseSub, agentKey: null, boardSub: baseSub };
}

// ---------------------------------------------------------------------------
// Board identity registration
// ---------------------------------------------------------------------------

export type BoardRegisterOutcome =
  | { ok: true; boardAgentId: string; boardSub: string }
  | { ok: false; reason: DefaultMcpSetupReason; retryable?: boolean };

/** Upper bound on response bytes scanned for the JSON-RPC reply. */
export const MAX_RESPONSE_BYTES = 1_000_000;

export interface RegisterCommsBoardAgentOptions {
  timeoutMs?: number;
  beforeToolCall?: () => Promise<void>;
}

export async function registerCommsBoardAgent(
  config: CommsBoardProvisionerConfig,
  request: { boardSub: string; displayName: string; ownerEmail: string },
  fetchImpl: FetchLike = fetch,
  opts: RegisterCommsBoardAgentOptions = {},
): Promise<BoardRegisterOutcome> {
  const timeoutMs = opts.timeoutMs ?? COMMS_BOARD_REQUEST_TIMEOUT_MS;

  const adminHeaders: Record<string, string> = {
    authorization: `Bearer ${config.boardAdminToken}`,
  };

  const send = (init: RequestInit) => {
    const signal = init.signal
      ? (typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : init.signal)
      : AbortSignal.timeout(timeoutMs);
    return fetchImpl(config.boardMcpUrl, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...adminHeaders,
      },
      redirect: "error",
      signal,
    });
  };

  // Step 1: Handshake (strict 1MB)
  let sessionHeaders: Record<string, string>;
  const requestId = randomUUID();
  try {
    sessionHeaders = await initializeMcpHttpSession({
      send,
      headers: adminHeaders,
      requestId,
      strict: true,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      supportedVersions: ["2025-06-18", "2025-03-26"],
    });
  } catch (error) {
    if (error instanceof McpHttpInitializationError) {
      if (error.status === 401 || error.status === 403) {
        return { ok: false, reason: "board_rejected" };
      }
    }
    return { ok: false, reason: "provisioner_failed", retryable: true };
  }

  // Step 2: Checkpoint callback before non-idempotent tool call
  if (opts.beforeToolCall) {
    try {
      await opts.beforeToolCall();
    } catch (err) {
      await terminateMcpHttpSession({ send, headers: sessionHeaders, timeoutMs: 3000 });
      throw err;
    }
  }

  // Step 3: Exactly ONE tools/call
  try {
    const callId = 1;
    const toolCallBody = buildMcpToolCallRequest(callId, "comms_admin_register", {
      sub: request.boardSub,
      owner_sub: request.ownerEmail,
      owner_email: request.ownerEmail,
      display_name: request.displayName,
      is_shared: false,
    });

    let response: Response;
    try {
      response = await fetchImpl(config.boardMcpUrl, {
        method: "POST",
        headers: {
          ...sessionHeaders,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(toolCallBody),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: "board_unknown" };
    }

    if (response.status === 401 || response.status === 403) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {}
      }
      return { ok: false, reason: "board_rejected" };
    }
    if (response.status >= 400 && response.status < 500) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {}
      }
      return { ok: false, reason: "board_failed" };
    }
    if (response.status !== 200) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {}
      }
      return { ok: false, reason: "board_unknown" };
    }

    let responseText: string | null;
    try {
      responseText = await readMcpHttpResponseText(response, MAX_RESPONSE_BYTES);
    } catch {
      return { ok: false, reason: "board_unknown" };
    }
    if (responseText === null) {
      return { ok: false, reason: "board_unknown" };
    }

    const envelope = findJsonRpcResponse(
      response.headers.get("content-type"),
      responseText,
      callId,
    );
    if (!envelope) {
      return { ok: false, reason: "board_unknown" };
    }

    if ("error" in envelope) {
      return { ok: false, reason: "board_unknown" };
    }

    const toolResult = extractMcpToolCallResult(envelope.result);
    if (!toolResult) {
      return { ok: false, reason: "board_unknown" };
    }

    // Check tool error BEFORE JSON parse
    if (toolResult.isError) {
      const errorContent = toolResult.content.slice(0, 256).trim();
      const match = errorContent.match(/^([a-z_]{1,48})(?::|\s|$)/);
      const code = match ? match[1] : "";
      if (
        code === "already_registered" ||
        code === "identity_fork_detected" ||
        code === "display_name_collision"
      ) {
        return { ok: false, reason: "board_conflict" };
      }
      if (code === "access_denied" || code === "insufficient_scope") {
        return { ok: false, reason: "board_rejected" };
      }
      if (code === "invalid_request") {
        return { ok: false, reason: "board_failed" };
      }
      return { ok: false, reason: "board_unknown" };
    }

    // Success path: prefer structuredContent object, else parse content text as JSON
    let payloadRecord: Record<string, unknown> | null = null;
    if (
      toolResult.structuredContent &&
      typeof toolResult.structuredContent === "object" &&
      !Array.isArray(toolResult.structuredContent)
    ) {
      payloadRecord = toolResult.structuredContent as Record<string, unknown>;
    } else {
      try {
        const parsed = JSON.parse(toolResult.content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payloadRecord = parsed as Record<string, unknown>;
        }
      } catch {
        return { ok: false, reason: "board_unknown" };
      }
    }

    if (!payloadRecord) {
      return { ok: false, reason: "board_unknown" };
    }

    const rawId =
      payloadRecord.agent_id ??
      payloadRecord.board_agent_id ??
      payloadRecord.boardAgentId ??
      payloadRecord.id;
    if (typeof rawId !== "string" || !UUID_PATTERN.test(rawId)) {
      return { ok: false, reason: "board_unknown" };
    }

    const returnedSub = typeof payloadRecord.sub === "string" ? payloadRecord.sub : "";
    if (returnedSub !== request.boardSub) {
      return { ok: false, reason: "board_unknown" };
    }

    return { ok: true, boardAgentId: rawId.toLowerCase(), boardSub: request.boardSub };
  } finally {
    await terminateMcpHttpSession({ send, headers: sessionHeaders, timeoutMs: 3000 });
  }
}

// ---------------------------------------------------------------------------
// Board credential mint
// ---------------------------------------------------------------------------

export type MintOutcome =
  | { ok: true; boardToken: string; tokenExpiresAt: string | null }
  | { ok: false; reason: DefaultMcpSetupReason };

export async function mintCommsBoardCredential(
  config: CommsBoardProvisionerConfig,
  request: { baseSub: string; ownerEmail: string },
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<MintOutcome> {
  // The token base must never contain "::": the board composes `<base>::<agent_key>` itself.
  if (!BASE_SUB_PATTERN.test(request.baseSub)) return { ok: false, reason: "invalid_subject" };
  let response: Response;
  try {
    response = await fetchImpl(`${config.ownershipApiUrl}/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.ownershipApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sub: request.baseSub,
        owner_email: request.ownerEmail,
        scopes: [...COMMS_BOARD_TOKEN_SCOPES],
        expires_in_days: COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    // The request may have landed and the token would be valid until it expires: never retry.
    return { ok: false, reason: "mint_unknown" };
  }
  if (response.status === 409) return { ok: false, reason: "ownership_conflict" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "ownership_rejected" };
  if (response.status === 400 || response.status === 422) return { ok: false, reason: "ownership_failed" };
  if (response.status !== 201) return { ok: false, reason: "mint_unknown" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "mint_unknown" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "mint_unknown" };
  const { token, token_expires_at: expiresAt, sub, active, owner_email: ownerEmail } = body as Record<string, unknown>;
  // The issuer's response contract, all required: the registry row is for exactly the requested
  // token base, is active, and is owned by the verified owner we asked for. Anything else may still
  // have created a registry row, so it is an unknown outcome (never a grant, never retried).
  if (sub !== request.baseSub) return { ok: false, reason: "mint_unknown" };
  if (active !== true) return { ok: false, reason: "mint_unknown" };
  if (typeof ownerEmail !== "string" || ownerEmail.trim().toLowerCase() !== request.ownerEmail.trim().toLowerCase()) {
    return { ok: false, reason: "mint_unknown" };
  }
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "mint_unknown" };
  return {
    ok: true,
    boardToken: token,
    tokenExpiresAt: typeof expiresAt === "string" && expiresAt.length > 0 ? expiresAt : null,
  };
}

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
 * "::"); the board row is registered as `<base>::<agentKey>` with a fixed, persisted agent key.
 */
import type { DefaultMcpSetupReason } from "./default-mcp-spec.js";

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
const AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommsBoardProvisionerConfig {
  boardMcpUrl: string;
  boardAdminToken: string;
  ownershipApiUrl: string;
  ownershipApiToken: string;
}

export function readCommsBoardProvisionerConfig(
  env: NodeJS.ProcessEnv = process.env,
): CommsBoardProvisionerConfig | null {
  const boardMcpUrl = env[COMMS_BOARD_MCP_URL_ENV]?.trim();
  const boardAdminToken = env[COMMS_BOARD_ADMIN_TOKEN_ENV]?.trim();
  const ownershipApiUrl = env[COMMS_BOARD_OWNERSHIP_API_URL_ENV]?.trim();
  const ownershipApiToken = env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]?.trim();
  if (!boardMcpUrl || !boardAdminToken || !ownershipApiUrl || !ownershipApiToken) return null;
  return {
    boardMcpUrl,
    boardAdminToken,
    ownershipApiUrl: ownershipApiUrl.replace(/\/+$/, ""),
    ownershipApiToken,
  };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Stable identity values derived once from immutable inputs, then persisted. */
export function composeCommsBoardIdentity(agentId: string, agentUrlKey: string) {
  const baseSub = `paperclip-agent-${agentId.toLowerCase()}`;
  // The key starts from the agent's slug at creation but is frozen afterwards; a later rename never changes it.
  const agentKey = AGENT_KEY_PATTERN.test(agentUrlKey) && !agentUrlKey.includes("::")
    ? agentUrlKey
    : `agent-${agentId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
  if (!BASE_SUB_PATTERN.test(baseSub) || baseSub.includes("::")) return null;
  return { baseSub, agentKey, boardSub: `${baseSub}::${agentKey}` };
}

// ---------------------------------------------------------------------------
// Board identity registration
// ---------------------------------------------------------------------------

export type BoardRegisterOutcome =
  | { ok: true; boardAgentId: string; boardSub: string }
  | { ok: false; reason: DefaultMcpSetupReason };

/** Upper bound on the response text scanned for the JSON-RPC reply. */
const MAX_RESPONSE_CHARS = 1_000_000;

/**
 * Finds the JSON-RPC message with the EXPECTED request id. A plain JSON body is parsed directly. An
 * SSE body is scanned event by event (CRLF/CR line ends, several `data:` lines joined with a
 * newline, at most one leading space removed per the SSE spec); comments, keep-alives,
 * notifications and replies to other ids are ignored. No matching message means `null`, which the
 * caller treats as an unknown outcome. The id is never guessed.
 */
export function parseJsonRpcEnvelope(contentType: string, text: string, expectedId: number): Record<string, unknown> | null {
  if (text.length > MAX_RESPONSE_CHARS) return null;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  try {
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) && parsed.id === expectedId ? parsed : null;
    }
    for (const event of text.replace(/\r\n?/g, "\n").split(/\n\n+/)) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.join("\n"));
      } catch {
        continue; // not JSON: keep scanning for the real reply
      }
      if (isRecord(parsed) && parsed.id === expectedId && ("result" in parsed || "error" in parsed)) return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function registerCommsBoardAgent(
  config: CommsBoardProvisionerConfig,
  request: { boardSub: string; displayName: string; ownerEmail: string },
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<BoardRegisterOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(config.boardMcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.boardAdminToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "comms_admin_register",
          arguments: {
            sub: request.boardSub,
            owner_sub: request.ownerEmail,
            owner_email: request.ownerEmail,
            display_name: request.displayName,
            is_shared: false,
            // `accepted_types` omitted: the board's default accepts every message type.
            // `confirm_new_identity` stays false: the base is new, so a fork means a real conflict.
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Timeout or network error: the registration may have landed.
    return { ok: false, reason: "board_unknown" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "board_rejected" };
  // A client error before the tool ran created nothing; anything else is an unknown outcome.
  if (response.status >= 400 && response.status < 500) return { ok: false, reason: "board_failed" };
  if (response.status !== 200) return { ok: false, reason: "board_unknown" };

  const envelope = parseJsonRpcEnvelope(response.headers.get("content-type") ?? "", await response.text().catch(() => ""), 1);
  if (!envelope) return { ok: false, reason: "board_unknown" };
  if ("error" in envelope) return { ok: false, reason: "board_failed" };
  if (envelope.id !== 1) return { ok: false, reason: "board_unknown" };
  const result = envelope.result as { content?: Array<{ text?: unknown }>; isError?: unknown } | undefined;
  const text = result?.content?.[0]?.text;
  if (!result || typeof text !== "string") return { ok: false, reason: "board_unknown" };
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "board_unknown" };
  }
  if (result.isError) {
    const code = String(payload.error_code ?? payload.code ?? payload.error ?? "");
    if (code === "already_registered") return { ok: false, reason: "board_conflict" };
    if (code === "access_denied") return { ok: false, reason: "board_rejected" };
    return { ok: false, reason: "board_failed" };
  }
  // A 200 success without a usable UUID may still have registered: unknown, never guessed from the token.
  const agentId = payload.agent_id;
  if (typeof agentId !== "string" || !UUID_PATTERN.test(agentId) || payload.sub !== request.boardSub) {
    return { ok: false, reason: "board_unknown" };
  }
  return { ok: true, boardAgentId: agentId.toLowerCase(), boardSub: request.boardSub };
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
  const { token, token_expires_at: expiresAt, sub } = body as Record<string, unknown>;
  // A 201 without a usable token still created the registry row: unknown, never rotated automatically.
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "mint_unknown" };
  if (sub !== undefined && sub !== request.baseSub) return { ok: false, reason: "mint_unknown" };
  return {
    ok: true,
    boardToken: token,
    tokenExpiresAt: typeof expiresAt === "string" && expiresAt.length > 0 ? expiresAt : null,
  };
}

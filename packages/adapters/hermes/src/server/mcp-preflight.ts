import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

export const HERMES_MCP_PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_TOOL_PAGES = 20;
const MAX_LISTED_TOOLS = 2000;
const MAX_REPORTED_TOOLS = 10;

export type HermesMcpPreflightFailureCode =
  | "timeout"
  | "unauthorized"
  | "connect_failed"
  | "list_failed"
  | "missing_tools"
  | "unexpected_tools";

export interface HermesMcpPreflightFailure {
  serverKey: string;
  code: HermesMcpPreflightFailureCode;
  /** Redaction-safe: built only from the server key, fixed text, HTTP status and configured tool names. */
  message: string;
  missingTools?: string[];
  unexpectedTools?: string[];
}

export interface HermesMcpPreflightServerSummary {
  serverKey: string;
  /** Number of tools the server listed; equals the allowlist size on a passing server. */
  listedToolCount: number;
}

export interface HermesMcpPreflightResult {
  ok: boolean;
  failures: HermesMcpPreflightFailure[];
  servers: HermesMcpPreflightServerSummary[];
}

export interface HermesMcpPreflightOptions {
  timeoutMs?: number;
}

class PreflightDeadlineError extends Error {}

/**
 * Never follow a redirect: the bearer token must only ever be sent to the exact configured
 * origin. A redirect surfaces as a fetch TypeError and is classified as connect_failed.
 */
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreflightDeadlineError("deadline")), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Only transport-level HTTP errors count; JSON-RPC `McpError.code` is server-controlled payload. */
function httpStatusOf(err: unknown): number | undefined {
  if (!(err instanceof StreamableHTTPError)) return undefined;
  const code = err.code;
  return typeof code === "number" && code >= 100 && code <= 599 ? code : undefined;
}

function isTimeout(err: unknown): boolean {
  if (err instanceof PreflightDeadlineError) return true;
  // MCP SDK ErrorCode.RequestTimeout
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === -32001);
}

/**
 * Classifies a failure without ever reading `err.message`: SDK/transport errors can embed
 * the request URL (which may carry query credentials) or upstream response bodies.
 */
function classifyFailure(
  serverKey: string,
  phase: "connect" | "list",
  err: unknown,
): HermesMcpPreflightFailure {
  if (isTimeout(err)) {
    return {
      serverKey,
      code: "timeout",
      message: `MCP server '${serverKey}' did not respond to ${phase === "connect" ? "initialize" : "tools/list"} in time`,
    };
  }
  const status = httpStatusOf(err);
  if (status === 401 || status === 403 || (err instanceof Error && err.name === "UnauthorizedError")) {
    return {
      serverKey,
      code: "unauthorized",
      message: `MCP server '${serverKey}' rejected the run credential (HTTP ${status ?? 401})`,
    };
  }
  const suffix = status ? ` (HTTP ${status})` : "";
  return phase === "connect"
    ? { serverKey, code: "connect_failed", message: `MCP server '${serverKey}' failed initialize${suffix}` }
    : { serverKey, code: "list_failed", message: `MCP server '${serverKey}' failed tools/list${suffix}` };
}

async function preflightOne(
  server: AdapterRuntimeMcpServer,
  serverKey: string,
  timeoutMs: number,
): Promise<{ failure?: HermesMcpPreflightFailure; summary?: HermesMcpPreflightServerSummary }> {
  let client: Client | undefined;
  let phase: "connect" | "list" = "connect";
  try {
    // Everything that can throw on malformed input (new URL embeds the raw input string,
    // including any query credential, in its error text) stays inside this try so it is
    // classified below instead of escaping as an unclassified exception.
    client = new Client({ name: "paperclip-hermes-preflight", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
      fetch: noRedirectFetch,
    });
    const activeClient = client;

    const listed = new Set<string>();
    // One overall per-server budget (connect + every tools/list page), not per phase.
    await withDeadline(
      (async () => {
        await activeClient.connect(transport);
        phase = "list";
        let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
          const res = await activeClient.listTools(cursor ? { cursor } : undefined);
          for (const tool of res.tools) listed.add(tool.name);
          if (listed.size > MAX_LISTED_TOOLS) throw new Error("too many tools");
          if (!res.nextCursor) return;
          cursor = res.nextCursor;
        }
        throw new Error("too many pages");
      })(),
      timeoutMs,
    );

    // Exact set equality. The allowlist is the dispatch-time grant; the gateway's live
    // tools/list additionally applies policy at call time.
    // - A granted tool that is no longer listed (revoked/denied between dispatch and spawn)
    //   aborts the run rather than starting the model with a silently smaller tool set.
    // - Any extra callable tool is policy drift and aborts too: Hermes `tools.include` is a
    //   client-side filter, not a security boundary, because the child process holds the
    //   bearer token and can call the gateway directly.
    const allowed = new Set(server.allowedTools);
    const missing = [...allowed].filter((name) => !listed.has(name));
    if (missing.length > 0) {
      const shown = missing.slice(0, MAX_REPORTED_TOOLS);
      const more = missing.length > shown.length ? ` (+${missing.length - shown.length} more)` : "";
      return {
        failure: {
          serverKey,
          code: "missing_tools",
          missingTools: shown,
          message: `MCP server '${serverKey}' does not list ${missing.length} allowlisted tool(s): ${shown.join(", ")}${more}`,
        },
      };
    }
    const unexpected = [...listed].filter((name) => !allowed.has(name));
    if (unexpected.length > 0) {
      const shown = unexpected.slice(0, MAX_REPORTED_TOOLS);
      const more = unexpected.length > shown.length ? ` (+${unexpected.length - shown.length} more)` : "";
      return {
        failure: {
          serverKey,
          code: "unexpected_tools",
          unexpectedTools: shown,
          message: `MCP server '${serverKey}' exposes ${unexpected.length} callable tool(s) outside the allowlist: ${shown.join(", ")}${more}`,
        },
      };
    }
    return { summary: { serverKey, listedToolCount: listed.size } };
  } catch (err) {
    return { failure: classifyFailure(serverKey, phase, err) };
  } finally {
    if (client) await withDeadline(client.close(), 2_000).catch(() => {});
  }
}

/**
 * Bounded pre-spawn check that every projected runtime MCP server accepts the run credential,
 * completes the MCP handshake, and lists exactly the allowlisted tools (no more, no fewer),
 * never following redirects. Fail-closed: any problem is
 * reported as a failure so the caller can abort before the model runs.
 *
 * `serverKeys` must be index-aligned with `servers` (see `PreparedHermesMcpHome.serverKeys`).
 */
export async function preflightHermesMcpServers(
  servers: AdapterRuntimeMcpServer[],
  serverKeys: string[],
  options: HermesMcpPreflightOptions = {},
): Promise<HermesMcpPreflightResult> {
  if (servers.length !== serverKeys.length) {
    throw new Error("MCP preflight requires one server key per runtime MCP server");
  }
  const timeoutMs = options.timeoutMs ?? HERMES_MCP_PREFLIGHT_TIMEOUT_MS;
  const outcomes = await Promise.all(
    servers.map((server, i) => preflightOne(server, serverKeys[i]!, timeoutMs)),
  );
  const failures = outcomes.flatMap((o) => (o.failure ? [o.failure] : []));
  const summaries = outcomes.flatMap((o) => (o.summary ? [o.summary] : []));
  return { ok: failures.length === 0, failures, servers: summaries };
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

export const HERMES_MCP_PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_TOOL_PAGES = 20;
const MAX_LISTED_TOOLS = 2000;
const MAX_REPORTED_MISSING_TOOLS = 10;

export type HermesMcpPreflightFailureCode =
  | "timeout"
  | "unauthorized"
  | "connect_failed"
  | "list_failed"
  | "missing_tools";

export interface HermesMcpPreflightFailure {
  serverKey: string;
  code: HermesMcpPreflightFailureCode;
  /** Redaction-safe: built only from the server key, fixed text, HTTP status and configured tool names. */
  message: string;
  missingTools?: string[];
}

export interface HermesMcpPreflightServerSummary {
  serverKey: string;
  /** Number of tools the server listed. */
  listedToolCount: number;
  /** Listed tools outside the allowlist; Hermes `tools.include` filters these client-side. */
  unlistedByAllowlistCount: number;
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
  const client = new Client({ name: "paperclip-hermes-preflight", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
  });

  let phase: "connect" | "list" = "connect";
  try {
    await withDeadline(client.connect(transport, { timeout: timeoutMs }), timeoutMs);

    phase = "list";
    const listed = new Set<string>();
    await withDeadline(
      (async () => {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
          const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
          for (const tool of res.tools) listed.add(tool.name);
          if (listed.size > MAX_LISTED_TOOLS) throw new Error("too many tools");
          if (!res.nextCursor) return;
          cursor = res.nextCursor;
        }
        throw new Error("too many pages");
      })(),
      timeoutMs,
    );

    const allowed = new Set(server.allowedTools);
    const missing = [...allowed].filter((name) => !listed.has(name));
    if (missing.length > 0) {
      const shown = missing.slice(0, MAX_REPORTED_MISSING_TOOLS);
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
    return {
      summary: {
        serverKey,
        listedToolCount: listed.size,
        unlistedByAllowlistCount: [...listed].filter((name) => !allowed.has(name)).length,
      },
    };
  } catch (err) {
    return { failure: classifyFailure(serverKey, phase, err) };
  } finally {
    await withDeadline(client.close(), 2_000).catch(() => {});
  }
}

/**
 * Bounded pre-spawn check that every projected runtime MCP server accepts the run credential,
 * completes the MCP handshake, and lists every allowlisted tool. Fail-closed: any problem is
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

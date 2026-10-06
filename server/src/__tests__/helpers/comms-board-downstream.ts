import { vi } from "vitest";
import type { CommsBoardProvisionerConfig } from "../../services/comms-board-provisioner-client.js";

export const BOARD_TOKEN = "board-token-SECRET-value-0123456789";
export const BOARD_ADMIN_TOKEN = "board-admin-SECRET-token";
export const OWNERSHIP_TOKEN = "ownership-write-SECRET-token";
export const BOARD_URL = "https://board.example.test/mcp";
export const OWNERSHIP_URL = "https://ownership.example.test";
export const BOARD_AGENT_ID = "0b2c7c1e-4f0a-4a4e-9b3e-0d6f0a3c9a11";
export const SECRETS = [BOARD_TOKEN, BOARD_ADMIN_TOKEN, OWNERSHIP_TOKEN];

export const clientConfig: CommsBoardProvisionerConfig = {
  boardMcpUrl: BOARD_URL,
  boardAdminToken: BOARD_ADMIN_TOKEN,
  ownershipApiUrl: OWNERSHIP_URL,
  ownershipApiToken: OWNERSHIP_TOKEN,
};

/** `comms_admin_register` JSON-RPC result, as the board returns it. */
export function boardResponse(
  sub: string,
  opts: { payload?: Record<string, unknown>; isError?: boolean; status?: number; sse?: boolean; id?: number } = {},
) {
  const payload = opts.payload ?? { agent_id: BOARD_AGENT_ID, sub, display_name: "x", status: "active", is_shared: false };
  const envelope = {
    jsonrpc: "2.0",
    id: opts.id ?? 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: opts.isError ?? false },
  };
  if (opts.sse) {
    return new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
      status: opts.status ?? 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  return new Response(JSON.stringify(envelope), { status: opts.status ?? 200, headers: { "content-type": "application/json" } });
}

const ECHO_OWNER = "__echo-request-owner__";

/** `ownership_api` `POST /agents` response. */
export function ownershipResponse(sub: string, overrides: Record<string, unknown> = {}, status = 201) {
  return new Response(
    JSON.stringify({
      sub,
      // Echoes the verified owner of the request (see `downstreamFetch`), as the real registry does.
      owner_email: ECHO_OWNER,
      active: true,
      token: BOARD_TOKEN,
      token_expires_at: "2027-03-01T00:00:00+00:00",
      ...overrides,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export type Registered = { sub: string; ownerEmail: string };

/** Routes by URL: board JSON-RPC vs ownership API. Records what each downstream saw. */
export function downstreamFetch(
  opts: {
    register?: (sub: string) => Response | Promise<Response>;
    mint?: (sub: string) => Response | Promise<Response>;
  } = {},
) {
  const calls = { register: [] as Registered[], mint: [] as Array<{ sub: string; scopes: string[]; expires: number }> };
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url === BOARD_URL) {
      const args = body.params.arguments;
      calls.register.push({ sub: args.sub, ownerEmail: args.owner_email });
      return opts.register ? opts.register(args.sub) : boardResponse(args.sub);
    }
    if (url === `${OWNERSHIP_URL}/agents`) {
      calls.mint.push({ sub: body.sub, scopes: body.scopes, expires: body.expires_in_days });
      const response = await (opts.mint ? opts.mint(body.sub) : ownershipResponse(body.sub));
      return echoRequestOwner(response, body.owner_email);
    }
    throw new Error(`unexpected url ${url}`);
  });
  return Object.assign(fn, { calls });
}

/** Fills the registry's `owner_email` with the request's owner when the fixture left the placeholder. */
async function echoRequestOwner(response: Response, ownerEmail: string): Promise<Response> {
  if (response.status !== 201) return response;
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.owner_email === ECHO_OWNER) parsed.owner_email = ownerEmail;
    return new Response(JSON.stringify(parsed), { status: response.status, headers: response.headers });
  } catch {
    return new Response(text, { status: response.status, headers: response.headers });
  }
}

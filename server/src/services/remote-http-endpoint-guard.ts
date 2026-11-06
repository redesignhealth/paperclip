import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyRemoteConnectionError, markRemoteConnectionFailure, readRemoteConnectionFailure } from "./remote-connection-failure.js";

const DEFAULT_DNS_TIMEOUT_MS = 5_000;

type LookupResult = { address: string; family: number };

export type RemoteHttpEndpointLookup = (hostname: string) => Promise<LookupResult[]>;

export type RemoteHttpEndpointGuardOptions = {
  allowPrivateNetwork?: boolean;
  /** Operator-allowlisted origin: skip the tailnet address deny. Never set from user-supplied URLs. */
  allowTailnetAddress?: boolean;
  dnsTimeoutMs?: number;
  lookup?: RemoteHttpEndpointLookup;
};

export type RemoteHttpEndpointErrorFactory = (message: string, code: string) => Error;

export function parseRemoteHttpEndpoint(
  value: unknown,
  error: RemoteHttpEndpointErrorFactory,
): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw error("Remote MCP connection requires config.url", "mcp_remote_url_missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw error("Remote MCP connection URL is invalid", "mcp_remote_url_invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw error("Remote MCP connection URL must use http or https", "mcp_remote_url_invalid");
  }
  return parsed;
}

export async function assertPublicRemoteHttpEndpoint(
  endpoint: URL,
  options: RemoteHttpEndpointGuardOptions,
  error: RemoteHttpEndpointErrorFactory,
): Promise<void> {
  await resolveApprovedRemoteHttpAddresses(endpoint, options, error);
}

/**
 * Validate a remote endpoint and return the exact address set that was approved.
 *
 * Callers must dial one of the returned addresses instead of letting the socket
 * layer resolve the hostname a second time. A second resolution reopens a
 * DNS-rebinding TOCTOU window: an attacker-controlled name server can answer
 * with a public address while this guard is looking, then with a loopback,
 * private or link-local address a moment later when the connection is made
 * (PAP-17098). Returning the resolved set — rather than a bare `void` — is what
 * lets `guardedRemoteHttpFetch` close that window.
 *
 * Hostnames are always resolved and pinned, including in deployments that
 * allow private networking. Link-local addresses remain outside that allowance,
 * so handing an allowed hostname back to platform fetch would reopen a DNS
 * rebinding path to instance metadata.
 */
export async function resolveApprovedRemoteHttpAddresses(
  endpoint: URL,
  options: RemoteHttpEndpointGuardOptions,
  error: RemoteHttpEndpointErrorFactory,
): Promise<string[]> {
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!options.allowPrivateNetwork && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw error("Remote MCP connection URL cannot target private or reserved network addresses", "remote_http_private_endpoint");
  }

  const literalVersion = isIP(hostname);
  if (literalVersion !== 0) {
    if (isAlwaysDeniedLinkLocalIp(hostname) || (!options.allowPrivateNetwork && isPrivateOrReservedIp(hostname))) {
      throw error("Remote MCP connection URL cannot target private or reserved network addresses", "remote_http_private_endpoint");
    }
    if (!options.allowTailnetAddress && isTailnetAddress(hostname)) {
      throw error(
        "Remote MCP connection URL cannot target tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) IP addresses; use the tailnet host name instead",
        "remote_http_tailnet_address_denied",
      );
    }
    return [hostname];
  }

  let results: LookupResult[];
  try {
    results = await lookupWithTimeout(
      hostname,
      options.lookup ?? defaultLookup,
      options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
    );
  } catch (cause) {
    const failure = error("Remote MCP connection hostname could not be resolved", "remote_http_dns_failed");
    const reason = readRemoteConnectionFailure(cause) ?? classifyRemoteConnectionError(cause);
    if (reason === "dns_failure" || reason === "connection_timeout") markRemoteConnectionFailure(failure, reason);
    throw failure;
  }
  if (results.length === 0) {
    throw markRemoteConnectionFailure(error("Remote MCP connection hostname did not resolve", "remote_http_dns_failed"), "dns_failure");
  }
  if (results.some((result) =>
    isAlwaysDeniedLinkLocalIp(result.address)
    || (!options.allowPrivateNetwork && isPrivateOrReservedIp(result.address)))) {
    throw error("Remote MCP connection URL cannot resolve to private or reserved network addresses", "remote_http_private_endpoint");
  }
  if (!options.allowTailnetAddress && results.some((result) => isTailnetAddress(result.address)) && (endpoint.protocol !== "https:" || (endpoint.port !== "" && endpoint.port !== "443"))) {
    throw error(
      "Remote MCP connection host name resolves to a tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) address; use the tailnet host name over https on port 443",
      "remote_http_tailnet_address_denied",
    );
  }
  return results.map((result) => result.address);
}

/**
 * Reduce an address to the form used for comparing an approved address against
 * the peer a socket actually connected to. `socket.remoteAddress` may come back
 * as an IPv4-mapped IPv6 address or carry an IPv6 zone index, neither of which
 * appears in a DNS answer.
 */
export function normalizeIpAddress(address: string): string {
  const lower = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4?.[1]) return mappedIpv4[1];
  const mappedIpv4Hex = parseMappedIpv4Hex(lower);
  if (mappedIpv4Hex) return mappedIpv4Hex;
  return lower;
}

function defaultLookup(hostname: string): Promise<LookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function lookupWithTimeout(hostname: string, lookup: RemoteHttpEndpointLookup, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(hostname),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(markRemoteConnectionFailure(new Error(`DNS lookup timed out for ${hostname}`), "connection_timeout"));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function isPrivateOrReservedIp(address: string): boolean {
  const lower = address.toLowerCase();
  const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4?.[1]) return isPrivateOrReservedIpv4(mappedIpv4[1]);
  const mappedIpv4Hex = parseMappedIpv4Hex(lower);
  if (mappedIpv4Hex) return isPrivateOrReservedIpv4(mappedIpv4Hex);
  if (isIP(address) === 4) return isPrivateOrReservedIpv4(address);
  if (isIP(address) === 6) return isPrivateOrReservedIpv6(lower);
  return true;
}

/** Link-local egress is denied in every deployment mode. */
export function isAlwaysDeniedLinkLocalIp(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  if (isIP(normalized) === 4) {
    const octets = parseIpv4Address(normalized);
    return octets !== null && octets[0] === 169 && octets[1] === 254;
  }
  return isIP(normalized) === 6 && /^fe[89ab]/.test(normalized);
}

/** Tailscale ranges (100.64.0.0/10, fd7a:115c:a1e0::/48, plus NAT64/IPv4-compatible/6to4 embeddings of the IPv4 range): literals are denied in every mode; host names resolving here are limited to https:443. */
function isTailnetAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  if (normalized.startsWith("fd7a:115c:a1e0:")) return true;
  const embedded = normalized.match(/^(?:64:ff9b::|::ffff:0:|::|2002:)([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
  const hi = embedded ? Number.parseInt(embedded[1]!, 16) : null;
  const octets = hi === null ? parseIpv4Address(normalized) : [hi >> 8, hi & 0xff];
  return octets !== null && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = parseIpv4Address(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv4Address(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parsed as [number, number, number, number];
}

function parseMappedIpv4Hex(address: string): string | null {
  const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateOrReservedIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(address)) return true;
  if (address.startsWith("ff")) return true;
  if (address === "100::" || address.startsWith("100:")) return true;
  if (/^2001:(?:0{0,4}:|:)/.test(address)) return true;
  if (address.startsWith("2001:db8:") || address === "2001:db8::") return true;
  if (address.startsWith("2001:2:") || address === "2001:2::") return true;
  if (/^2001:0?2[0-9a-f]:/.test(address)) return true;
  if (address.startsWith("2002:")) return true;
  if (address.startsWith("64:ff9b:")) return true;
  return false;
}

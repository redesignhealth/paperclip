import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  isAlwaysDeniedLinkLocalIp,
  isPrivateOrReservedIp,
} from "./remote-http-endpoint-guard.js";

/** Maximum time (ms) to wait for a DNS lookup before aborting. */
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/** Only these protocols are allowed for plugin HTTP requests. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Check if an IP address is in a private/reserved range (RFC 1918, loopback,
 * link-local, etc.) that plugins should never be able to reach.
 *
 * Handles IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) which Node's
 * dns.lookup may return depending on OS configuration.
 */
export function isPrivateIP(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) and re-check as IPv4
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch && v4MappedMatch[1]) {
    const ipv4 = v4MappedMatch[1];
    // fork(TECH-8283 Finding 7): Strict IPv4 octet validation; reject invalid octets like 999
    if (isIP(ipv4) !== 4) return true;
    return isPrivateIP(ipv4);
  }

  // IPv4 patterns
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("127.")) return true;                   // loopback
  if (ip.startsWith("169.254.")) return true;               // link-local
  if (ip === "0.0.0.0") return true;

  // IPv6 patterns
  if (lower === "::1") return true;                          // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true;                 // link-local
  if (lower === "::") return true;

  return false;
}

export type IpAddressClassifier = (ip: string, options?: { allowPrivateNetwork?: boolean }) => boolean;

/** Default classifier for existing plugin ctx.http.fetch: preserves existing behavior */
export function isFetchPrivateIP(ip: string): boolean {
  return isPrivateIP(ip);
}

// fork(TECH-8283 Finding A, Finding 7): Canonical in-repo guard classifier for WebSocket egress
/**
 * Strict canonical classifier for WebSocket egress (TECH-8283 Finding A).
 * Rejects link-local always (even with allowPrivateNetwork), rejects AWS IPv6 metadata
 * (fd00:ec2::254) always, rejects private/reserved IPs (including CGNAT 100.64.0.0/10),
 * and fails closed on unparseable/invalid IP input.
 */
export function isPrivateOrDeniedWsIP(ip: string, options?: { allowPrivateNetwork?: boolean }): boolean {
  const normalized = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");

  // fork(TECH-8283 Finding 7): AWS IPv6 metadata service (fd00:ec2::254) is denied in all modes
  if (normalized === "fd00:ec2::254") return true;

  // Link-local is denied in every mode, even when allowPrivateNetwork is true
  if (isAlwaysDeniedLinkLocalIp(normalized)) return true;

  // Strict check on IPv4-mapped IPv6 (e.g. ::ffff:999.999.999.999 -> unparseable -> deny)
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4 && mappedIpv4[1]) {
    if (isIP(mappedIpv4[1]) !== 4) return true;
  }

  // Fail-closed on unparseable/invalid IP addresses regardless of allowPrivateNetwork
  if (isIP(normalized) === 0 && !mappedIpv4) return true;

  if (!options?.allowPrivateNetwork && isPrivateOrReservedIp(normalized)) return true;
  return false;
}

// fork(TECH-8283 F1, Finding A, Finding B): Options for guarded egress
export interface GuardedRemoteHttpFetchOptions {
  allowPrivateNetwork?: boolean;
  allowedProtocols?: Set<string>;
  lookup?: typeof dnsLookup;
  isPrivate?: IpAddressClassifier;
  dnsTimeoutMs?: number;
}

/**
 * Validate a URL for plugin fetch: protocol whitelist + private IP blocking.
 *
 * SSRF Prevention Strategy:
 * 1. Parse and validate the URL syntax
 * 2. Enforce protocol whitelist (http/https only)
 * 3. Resolve the hostname to IP(s) via DNS
 * 4. Validate that ALL resolved IPs are non-private
 * 5. Pin the first safe IP into the URL so fetch() does not re-resolve DNS
 *
 * This prevents DNS rebinding attacks where an attacker controls DNS to
 * resolve to a safe IP during validation, then to a private IP when fetch() runs.
 *
 * @returns Request-routing metadata used to connect directly to the resolved IP
 *          while preserving the original hostname for HTTP Host and TLS SNI.
 */
export interface ValidatedFetchTarget {
  parsedUrl: URL;
  resolvedAddress: string;
  hostHeader: string;
  tlsServername?: string;
  useTls: boolean;
}

export async function validateAndResolveFetchUrl(
  urlString: string,
  options?: GuardedRemoteHttpFetchOptions,
): Promise<ValidatedFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  const allowed = options?.allowedProtocols ?? ALLOWED_PROTOCOLS;
  if (!allowed.has(parsed.protocol)) {
    throw new Error(
      `Disallowed protocol "${parsed.protocol}" — only ${Array.from(allowed).join(", ")} are permitted`,
    );
  }

  const originalHostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const hostHeader = parsed.host; // includes port if non-default
  const isPrivateFn = options?.isPrivate ?? ((ip: string) => isPrivateIP(ip));
  const useTls = parsed.protocol === "https:" || parsed.protocol === "wss:";

  // fork(TECH-8283 Finding 7): Classify IP literals directly without DNS lookup
  if (isIP(originalHostname) !== 0) {
    if (isPrivateFn(originalHostname, { allowPrivateNetwork: options?.allowPrivateNetwork })) {
      throw new Error(`All resolved IPs for ${originalHostname} are in private/reserved ranges`);
    }
    return {
      parsedUrl: parsed,
      resolvedAddress: originalHostname,
      hostHeader,
      tlsServername: undefined,
      useTls,
    };
  }

  // Race the DNS lookup against a timeout to prevent indefinite hangs
  const lookupFn = options?.lookup ?? dnsLookup;
  const dnsTimeoutMs = options?.dnsTimeoutMs ?? DNS_LOOKUP_TIMEOUT_MS;
  const dnsPromise = lookupFn(originalHostname, { all: true });

  let dnsTimer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    dnsTimer = setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${dnsTimeoutMs}ms for ${originalHostname}`)),
      dnsTimeoutMs,
    );
    dnsTimer.unref?.();
  });

  try {
    const results = await Promise.race([dnsPromise, timeoutPromise]);
    // fork(TECH-8283 Finding 7): Clear DNS timeout timer on success
    if (dnsTimer) clearTimeout(dnsTimer);

    if (results.length === 0) {
      throw new Error(`DNS resolution returned no results for ${originalHostname}`);
    }

    const safeResults = results.filter((entry) => !isPrivateFn(entry.address, { allowPrivateNetwork: options?.allowPrivateNetwork }));
    if (safeResults.length === 0) {
      throw new Error(
        `All resolved IPs for ${originalHostname} are in private/reserved ranges`,
      );
    }

    const resolved = safeResults[0]!;
    return {
      parsedUrl: parsed,
      resolvedAddress: resolved.address,
      hostHeader,
      tlsServername: useTls && isIP(originalHostname) === 0
        ? originalHostname
        : undefined,
      useTls,
    };
  } catch (err) {
    if (dnsTimer) clearTimeout(dnsTimer);
    if (err instanceof Error && (
      err.message.startsWith("All resolved IPs") ||
      err.message.startsWith("DNS resolution returned") ||
      err.message.startsWith("DNS lookup timed out")
    )) throw err;
    throw new Error(`DNS resolution failed for ${originalHostname}: ${(err as Error).message}`);
  }
}

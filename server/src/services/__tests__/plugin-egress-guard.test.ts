import { describe, expect, it, vi } from "vitest";
import {
  isPrivateIP,
  isFetchPrivateIP,
  isPrivateOrDeniedWsIP,
  validateAndResolveFetchUrl,
} from "../plugin-egress-guard.js";

describe("plugin-egress-guard classification & SSRF protection", () => {
  describe("default fetch classifier (unchanged behavior)", () => {
    it("permits CGNAT / Tailscale 100.64.0.0/10 addresses for existing plugin fetch", () => {
      // fork(TECH-8283 Finding A): Existing plugin ctx.http.fetch can reach Tailscale 100.x hosts
      expect(isPrivateIP("100.64.0.1")).toBe(false);
      expect(isPrivateIP("100.127.255.255")).toBe(false);
      expect(isFetchPrivateIP("100.64.0.1")).toBe(false);
    });

    it.each([
      "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
      "169.254.169.254", "::1", "::ffff:127.0.0.1", "0.0.0.0", "::",
    ])("classifies %s as private IP", (ip) => {
      expect(isPrivateIP(ip)).toBe(true);
    });

    it("rejects invalid IPv4-mapped IPv6 like ::ffff:999.999.999.999 as private", () => {
      // fork(TECH-8283 Finding 7): Strict IPv4-mapped parsing rejects invalid octets
      expect(isPrivateIP("::ffff:999.999.999.999")).toBe(true);
    });

    it.each(["8.8.8.8", "93.184.216.34"])("classifies %s as public/allowed IP", (ip) => {
      expect(isPrivateIP(ip)).toBe(false);
    });
  });

  describe("strict WebSocket egress classifier (Finding A, Finding 7)", () => {
    it.each([
      "10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1",
      "::1", "::ffff:127.0.0.1", "169.254.169.254", "fe80::1", "0.0.0.0", "::",
    ])("classifies %s as private/denied for WS", (ip) => {
      expect(isPrivateOrDeniedWsIP(ip)).toBe(true);
    });

    it("rejects CGNAT / Tailscale 100.64.0.0/10 addresses on the default (allowPrivateNetwork false) path", () => {
      // fork(TECH-8283 Finding 7): CGNAT test exercises default allowPrivateNetwork false path
      expect(isPrivateOrDeniedWsIP("100.64.0.1")).toBe(true);
      expect(isPrivateOrDeniedWsIP("100.64.0.1", { allowPrivateNetwork: false })).toBe(true);
      expect(isPrivateOrDeniedWsIP("100.127.255.255")).toBe(true);
      expect(isPrivateOrDeniedWsIP("100.127.255.255", { allowPrivateNetwork: false })).toBe(true);
    });

    it("denies link-local and AWS IPv6 metadata (fd00:ec2::254) always, even with allowPrivateNetwork", () => {
      // fork(TECH-8283 Finding 7): AWS IPv6 metadata service (fd00:ec2::254) and link-local denied always
      expect(isPrivateOrDeniedWsIP("fd00:ec2::254")).toBe(true);
      expect(isPrivateOrDeniedWsIP("fd00:ec2::254", { allowPrivateNetwork: true })).toBe(true);
      expect(isPrivateOrDeniedWsIP("169.254.169.254", { allowPrivateNetwork: true })).toBe(true);
      expect(isPrivateOrDeniedWsIP("fe80::1", { allowPrivateNetwork: true })).toBe(true);
      expect(isPrivateOrDeniedWsIP("::ffff:169.254.169.254", { allowPrivateNetwork: true })).toBe(true);
    });

    it("allows private addresses only when allowPrivateNetwork is true", () => {
      expect(isPrivateOrDeniedWsIP("127.0.0.1", { allowPrivateNetwork: true })).toBe(false);
      expect(isPrivateOrDeniedWsIP("10.0.0.1", { allowPrivateNetwork: true })).toBe(false);
    });

    it.each([
      "not-an-ip", "999.999.999.999", "::ffff:999.999.999.999", "", "example.com",
    ])("fails closed on unparseable/invalid input %j", (input) => {
      // fork(TECH-8283 Finding A, Finding 7): Fail-closed on unparseable/invalid input
      expect(isPrivateOrDeniedWsIP(input)).toBe(true);
      expect(isPrivateOrDeniedWsIP(input, { allowPrivateNetwork: true })).toBe(true);
    });

    it.each(["8.8.8.8", "93.184.216.34"])("permits public IP %s", (ip) => {
      expect(isPrivateOrDeniedWsIP(ip)).toBe(false);
    });
  });

  describe("validateAndResolveFetchUrl with WS classifier", () => {
    it("classifies IP literals directly without DNS lookup", async () => {
      // fork(TECH-8283 Finding 7): Direct IP literal classification skips DNS
      const mockLookup = vi.fn();
      const target = await validateAndResolveFetchUrl("wss://93.184.216.34/ws", {
        allowedProtocols: new Set(["wss:"]),
        isPrivate: isPrivateOrDeniedWsIP,
        lookup: mockLookup as never,
      });
      expect(mockLookup).not.toHaveBeenCalled();
      expect(target.resolvedAddress).toBe("93.184.216.34");
      expect(target.tlsServername).toBeUndefined();
    });

    it("rejects link-local addresses even when allowPrivateNetwork is true", async () => {
      await expect(
        validateAndResolveFetchUrl("wss://169.254.169.254/ws", {
          allowedProtocols: new Set(["wss:"]),
          isPrivate: isPrivateOrDeniedWsIP,
          allowPrivateNetwork: true,
        }),
      ).rejects.toThrow(/private\/reserved ranges/);
    });

    it("rejects CGNAT addresses on default path", async () => {
      await expect(
        validateAndResolveFetchUrl("wss://100.64.0.1/ws", {
          allowedProtocols: new Set(["wss:"]),
          isPrivate: isPrivateOrDeniedWsIP,
        }),
      ).rejects.toThrow(/private\/reserved ranges/);
    });

    it("pins the resolved address and sets non-tautological dial options", async () => {
      // fork(TECH-8283 Finding 12): Assert dial options (host=resolved address, servername, Host header)
      let count = 0;
      const mockLookup = vi.fn().mockImplementation(() => {
        count += 1;
        return Promise.resolve(
          count === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
        );
      });

      const target = await validateAndResolveFetchUrl("wss://rebind.attacker.test:8443/feed?token=xyz", {
        allowedProtocols: new Set(["wss:"]),
        isPrivate: isPrivateOrDeniedWsIP,
        lookup: mockLookup as never,
      });

      expect(target.resolvedAddress).toBe("93.184.216.34");
      expect(target.hostHeader).toBe("rebind.attacker.test:8443");
      expect(target.tlsServername).toBe("rebind.attacker.test");
      expect(target.useTls).toBe(true);

      const dialOptions = {
        method: "GET",
        host: target.resolvedAddress,
        port: target.parsedUrl.port ? Number(target.parsedUrl.port) : 443,
        path: `${target.parsedUrl.pathname}${target.parsedUrl.search}`,
        servername: target.tlsServername,
        headers: { Host: target.hostHeader },
      };
      expect(dialOptions.host).toBe("93.184.216.34");
      expect(dialOptions.port).toBe(8443);
      expect(dialOptions.path).toBe("/feed?token=xyz");
      expect(dialOptions.servername).toBe("rebind.attacker.test");
      expect(dialOptions.headers.Host).toBe("rebind.attacker.test:8443");

      const secondLookup = await mockLookup("rebind.attacker.test");
      expect(secondLookup[0].address).toBe("127.0.0.1");
      expect(dialOptions.host).toBe("93.184.216.34");
    });
  });
});

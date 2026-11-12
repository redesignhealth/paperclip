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
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
      "::",
    ])("classifies %s as private IP", (ip) => {
      expect(isPrivateIP(ip)).toBe(true);
    });

    it.each([
      "8.8.8.8",
      "93.184.216.34",
    ])("classifies %s as public/allowed IP", (ip) => {
      expect(isPrivateIP(ip)).toBe(false);
    });
  });

  describe("strict WebSocket egress classifier (Finding A)", () => {
    it.each([
      // RFC1918
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      // Loopback
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      // Link-local / metadata
      "169.254.169.254",
      "fe80::1",
      // Broadcast / unspecified
      "0.0.0.0",
      "::",
    ])("classifies %s as private/denied for WS", (ip) => {
      expect(isPrivateOrDeniedWsIP(ip)).toBe(true);
    });

    it("rejects CGNAT / Tailscale 100.64.0.0/10 addresses for WS egress", () => {
      // fork(TECH-8283 Finding A): CGNAT must be rejected on the WS egress path
      expect(isPrivateOrDeniedWsIP("100.64.0.1")).toBe(true);
      expect(isPrivateOrDeniedWsIP("100.127.255.255")).toBe(true);
    });

    it("denies link-local addresses even when allowPrivateNetwork is true", () => {
      // fork(TECH-8283 Finding A): Link-local denied even with allowPrivateNetwork
      expect(isPrivateOrDeniedWsIP("169.254.169.254", { allowPrivateNetwork: true })).toBe(true);
      expect(isPrivateOrDeniedWsIP("fe80::1", { allowPrivateNetwork: true })).toBe(true);
      expect(isPrivateOrDeniedWsIP("::ffff:169.254.169.254", { allowPrivateNetwork: true })).toBe(true);
    });

    it("allows private addresses only when allowPrivateNetwork is true", () => {
      expect(isPrivateOrDeniedWsIP("127.0.0.1", { allowPrivateNetwork: true })).toBe(false);
      expect(isPrivateOrDeniedWsIP("10.0.0.1", { allowPrivateNetwork: true })).toBe(false);
    });

    it.each([
      "not-an-ip",
      "999.999.999.999",
      "",
      "example.com",
    ])("fails closed on unparseable/invalid input %j", (input) => {
      // fork(TECH-8283 Finding A): Fail-closed on unparseable input
      expect(isPrivateOrDeniedWsIP(input)).toBe(true);
      expect(isPrivateOrDeniedWsIP(input, { allowPrivateNetwork: true })).toBe(true);
    });

    it.each([
      "8.8.8.8",
      "93.184.216.34",
    ])("permits public IP %s", (ip) => {
      expect(isPrivateOrDeniedWsIP(ip)).toBe(false);
    });
  });

  describe("validateAndResolveFetchUrl with WS classifier", () => {
    it("rejects link-local addresses even when allowPrivateNetwork is true", async () => {
      await expect(
        validateAndResolveFetchUrl("wss://169.254.169.254/ws", {
          allowedProtocols: new Set(["wss:"]),
          isPrivate: isPrivateOrDeniedWsIP,
          allowPrivateNetwork: true,
        }),
      ).rejects.toThrow(/private\/reserved ranges/);
    });

    it("rejects CGNAT addresses for WS egress", async () => {
      await expect(
        validateAndResolveFetchUrl("wss://100.64.0.1/ws", {
          allowedProtocols: new Set(["wss:"]),
          isPrivate: isPrivateOrDeniedWsIP,
        }),
      ).rejects.toThrow(/private\/reserved ranges/);
    });

    it("pins the resolved address against DNS rebinding", async () => {
      let count = 0;
      const mockLookup = vi.fn().mockImplementation(() => {
        count += 1;
        return Promise.resolve(
          count === 1
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "127.0.0.1", family: 4 }],
        );
      });

      const target = await validateAndResolveFetchUrl("wss://rebind.attacker.test/ws", {
        allowedProtocols: new Set(["wss:"]),
        isPrivate: isPrivateOrDeniedWsIP,
        lookup: mockLookup as never,
      });

      expect(target.resolvedAddress).toBe("93.184.216.34");
      expect(target.hostHeader).toBe("rebind.attacker.test");
      expect(target.tlsServername).toBe("rebind.attacker.test");

      const second = await mockLookup("rebind.attacker.test");
      expect(second[0].address).toBe("127.0.0.1");
      expect(target.resolvedAddress).toBe("93.184.216.34");
    });
  });
});

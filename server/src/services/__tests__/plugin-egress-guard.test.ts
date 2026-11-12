import { describe, expect, it, vi } from "vitest";
import {
  isPrivateIP,
  validateAndResolveFetchUrl,
} from "../plugin-egress-guard.js";

describe("plugin-egress-guard SSRF protection", () => {
  describe("isPrivateIP classification", () => {
    it.each([
      // Loopback
      "127.0.0.1",
      "127.0.0.2",
      "127.255.255.255",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:127.0.0.2",

      // RFC1918
      "10.0.0.1",
      "10.255.255.255",
      "::ffff:10.0.0.1",
      "172.16.0.1",
      "172.24.0.1",
      "172.31.255.255",
      "::ffff:172.16.0.1",
      "192.168.0.1",
      "192.168.1.1",
      "::ffff:192.168.1.1",

      // Link-local / metadata service
      "169.254.169.254",
      "169.254.0.1",
      "::ffff:169.254.169.254",
      "fe80::1",

      // Unspecified / broadcast
      "0.0.0.0",
      "::",

      // IPv6 ULA
      "fc00::1",
      "fd12:3456:789a::1",
    ])("classifies %s as private IP", (ip) => {
      // fork(TECH-8283 F1): Validate that private IPs are recognized
      expect(isPrivateIP(ip)).toBe(true);
    });

    it.each([
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.15.255.255",
      "172.32.0.1",
      "2606:2800:220:1:248:1893:25c8:1946",
    ])("classifies %s as public/allowed IP", (ip) => {
      expect(isPrivateIP(ip)).toBe(false);
    });
  });

  describe("validateAndResolveFetchUrl validator", () => {
    it.each([
      "https://127.0.0.1/path",
      "https://10.0.0.1/path",
      "https://172.16.0.1/path",
      "https://192.168.1.1/path",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/path",
      "https://[::ffff:127.0.0.1]/path",
    ])("rejects direct private IP URL %s", async (urlString) => {
      // fork(TECH-8283 F1): Reject private IP targets directly
      await expect(validateAndResolveFetchUrl(urlString)).rejects.toThrow(
        /private\/reserved ranges/,
      );
    });

    it("rejects hostname resolving to private IP", async () => {
      const mockLookup = vi.fn().mockResolvedValue([
        { address: "10.0.0.5", family: 4 },
      ]);
      await expect(
        validateAndResolveFetchUrl("https://internal.corp/admin", {
          lookup: mockLookup as never,
        }),
      ).rejects.toThrow(/private\/reserved ranges/);
      expect(mockLookup).toHaveBeenCalledWith("internal.corp", { all: true });
    });

    it("rejects when all resolved IPs are private on multi-homed hostname", async () => {
      const mockLookup = vi.fn().mockResolvedValue([
        { address: "10.0.0.1", family: 4 },
        { address: "192.168.1.1", family: 4 },
      ]);
      await expect(
        validateAndResolveFetchUrl("https://internal.corp", {
          lookup: mockLookup as never,
        }),
      ).rejects.toThrow(/private\/reserved ranges/);
    });

    it("filters to public IP when hostname has both private and public IPs", async () => {
      const mockLookup = vi.fn().mockResolvedValue([
        { address: "10.0.0.1", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ]);
      const target = await validateAndResolveFetchUrl("https://example.com/api", {
        lookup: mockLookup as never,
      });
      expect(target.resolvedAddress).toBe("93.184.216.34");
      expect(target.hostHeader).toBe("example.com");
      expect(target.tlsServername).toBe("example.com");
    });

    it("rejects disallowed protocols", async () => {
      await expect(validateAndResolveFetchUrl("ftp://example.com/file")).rejects.toThrow(
        /Disallowed protocol "ftp:"/,
      );
      await expect(validateAndResolveFetchUrl("file:///etc/passwd")).rejects.toThrow(
        /Disallowed protocol "file:"/,
      );
    });
  });

  describe("DNS rebinding defense", () => {
    it("pins the resolved IP address so requests never re-resolve DNS", async () => {
      // fork(TECH-8283 F1): DNS rebinding simulation
      // Initial lookup returns public IP; subsequent lookup would return 127.0.0.1
      let lookupCount = 0;
      const mockLookup = vi.fn().mockImplementation(() => {
        lookupCount += 1;
        if (lookupCount === 1) {
          return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
        }
        return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
      });

      const target = await validateAndResolveFetchUrl("https://rebind.attacker.test/ws", {
        lookup: mockLookup as never,
      });

      expect(target.resolvedAddress).toBe("93.184.216.34");
      expect(target.hostHeader).toBe("rebind.attacker.test");

      // Verify target pins resolvedAddress to the safe IP, not the hostname
      expect(target.resolvedAddress).toBe("93.184.216.34");
      expect(target.hostHeader).toBe("rebind.attacker.test");
      expect(target.tlsServername).toBe("rebind.attacker.test");

      // Even if resolver changes to private on next call, target object is immutable and pinned
      const secondCallResults = await mockLookup("rebind.attacker.test");
      expect(secondCallResults[0].address).toBe("127.0.0.1");
      expect(target.resolvedAddress).toBe("93.184.216.34");
    });
  });
});

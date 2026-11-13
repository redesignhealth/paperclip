import { describe, expect, it, beforeEach } from "vitest";
import {
  isAllowedWorkerUpstreamHeader,
  acquireWebSocketSlot,
  resetWebSocketSlotsForTest,
  MAX_WS_CONCURRENT_PER_ACTOR_PLUGIN,
  MAX_WS_CONCURRENT_PER_COMPANY,
} from "../plugin-api-ws.js";

describe("plugin-api-ws unit tests (P2a unwired module)", () => {
  beforeEach(() => {
    resetWebSocketSlotsForTest();
  });

  describe("isAllowedWorkerUpstreamHeader allowlist (F4)", () => {
    it.each([
      "authorization",
      "Authorization",
      "AUTHORIZATION",
      "user-agent",
      "User-Agent",
      "x-custom-header",
      "X-Trace-Id",
      "x-paperclip-key",
    ])("allows permitted upstream header %s", (name) => {
      // fork(TECH-8283 F4): Allow authorization, user-agent, and x-* (excluding x-forwarded-*)
      expect(isAllowedWorkerUpstreamHeader(name)).toBe(true);
    });

    it.each([
      "x-forwarded-for",
      "X-Forwarded-For",
      "x-forwarded-proto",
      "x-forwarded-host",
      "cookie",
      "Cookie",
      "set-cookie",
      "host",
      "Host",
      "origin",
      "upgrade",
      "connection",
      "content-length",
      "transfer-encoding",
      "proxy-authorization",
      "sec-websocket-key",
    ])("rejects non-allowlisted upstream header %s", (name) => {
      // fork(TECH-8283 F4): Strictly reject headers outside allowlist
      expect(isAllowedWorkerUpstreamHeader(name)).toBe(false);
    });
  });

  describe("acquireWebSocketSlot concurrency caps (F3)", () => {
    const companyId = "company-1";
    const actorId = "user-1";
    const pluginId = "plugin-1";

    it("enforces concurrency cap per (actor, plugin) = 4", () => {
      const releases: Array<() => void> = [];
      for (let i = 0; i < MAX_WS_CONCURRENT_PER_ACTOR_PLUGIN; i += 1) {
        const release = acquireWebSocketSlot(companyId, actorId, pluginId);
        expect(release).not.toBeNull();
        releases.push(release!);
      }

      // 5th attempt must fail
      const overflow = acquireWebSocketSlot(companyId, actorId, pluginId);
      expect(overflow).toBeNull();

      // After releasing one, acquire succeeds again
      releases.pop()!();
      const retry = acquireWebSocketSlot(companyId, actorId, pluginId);
      expect(retry).not.toBeNull();
    });

    it("enforces concurrency cap per company = 32", () => {
      const releases: Array<() => void> = [];
      // Use different actors to test company limit across actors
      for (let i = 0; i < MAX_WS_CONCURRENT_PER_COMPANY; i += 1) {
        const release = acquireWebSocketSlot(companyId, `user-${i}`, `plugin-${i % 2}`);
        expect(release).not.toBeNull();
        releases.push(release!);
      }

      // 33rd attempt for this company must fail
      const overflow = acquireWebSocketSlot(companyId, "user-new", "plugin-new");
      expect(overflow).toBeNull();

      // Another company is not affected
      const otherCompanyRelease = acquireWebSocketSlot("company-2", "user-1", "plugin-1");
      expect(otherCompanyRelease).not.toBeNull();

      // Releasing one opens slot in company-1
      releases.pop()!();
      const retry = acquireWebSocketSlot(companyId, "user-new", "plugin-new");
      expect(retry).not.toBeNull();
    });

    it("release is idempotent and decrements only once", () => {
      const release1 = acquireWebSocketSlot(companyId, actorId, pluginId)!;
      const release2 = acquireWebSocketSlot(companyId, actorId, pluginId)!;

      // Double-invoking release1 should not decrement twice
      release1();
      release1();

      // Acquire two more to reach 4 (if double decrement happened, 5 would be allowed)
      const r3 = acquireWebSocketSlot(companyId, actorId, pluginId)!;
      const r4 = acquireWebSocketSlot(companyId, actorId, pluginId)!;
      const r5 = acquireWebSocketSlot(companyId, actorId, pluginId)!;
      expect(acquireWebSocketSlot(companyId, actorId, pluginId)).toBeNull();

      r3(); r4(); r5(); release2();
    });
  });
});

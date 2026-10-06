import { describe, expect, it } from "vitest";
import {
  effectiveToolProfileBindings,
  narrowestScopeBindings,
} from "./tool-profile-binding-precedence.js";

const createdAt = new Date("2026-08-11T00:00:00.000Z");

describe("tool profile binding precedence", () => {
  it("keeps ordinary profiles at the narrowest matching scope", () => {
    const companyBinding = {
      profileId: "company-profile",
      targetType: "company" as const,
      targetId: "company-1",
      priority: 100,
      createdAt,
    };
    const agentBinding = {
      profileId: "agent-profile",
      targetType: "agent" as const,
      targetId: "agent-1",
      priority: 100,
      createdAt,
    };

    expect(narrowestScopeBindings([companyBinding, agentBinding])).toEqual([agentBinding]);
    expect(effectiveToolProfileBindings(
      [companyBinding, agentBinding],
      [
        { id: "company-profile", profileKey: "company-default", metadata: {} },
        { id: "agent-profile", profileKey: "agent-default", metadata: {} },
      ],
      "connection-1",
    )).toEqual([agentBinding]);
  });

  it("carries the wizard-managed app assignment alongside a narrower profile", () => {
    const appBinding = {
      profileId: "app-profile",
      targetType: "company" as const,
      targetId: "company-1",
      priority: 100,
      createdAt,
    };
    const agentBinding = {
      profileId: "agent-profile",
      targetType: "agent" as const,
      targetId: "agent-1",
      priority: 100,
      createdAt,
    };

    expect(effectiveToolProfileBindings(
      [appBinding, agentBinding],
      [
        {
          id: "app-profile",
          profileKey: "app:connection-1",
          metadata: { source: "app_gallery_finish", connectionId: "connection-1" },
        },
        { id: "agent-profile", profileKey: "agent-default", metadata: {} },
      ],
      "connection-1",
    )).toEqual([agentBinding, appBinding]);
  });

  it("does not carry wizard-managed app assignments into a gateway-only profile", () => {
    const appBinding = {
      profileId: "app-profile",
      targetType: "company" as const,
      targetId: "company-1",
      priority: 100,
      createdAt,
    };
    const gatewayBinding = {
      profileId: "gateway-profile",
      targetType: "gateway" as const,
      targetId: "gateway-1",
      priority: 10,
      createdAt,
    };

    expect(effectiveToolProfileBindings(
      [appBinding, gatewayBinding],
      [
        {
          id: "app-profile",
          profileKey: "app:connection-1",
          metadata: { source: "app_gallery_finish", connectionId: "connection-1" },
        },
        { id: "gateway-profile", profileKey: "runtime-gateway", metadata: {} },
      ],
      "connection-1",
      { includeAdditiveAppProfiles: false },
    )).toEqual([gatewayBinding]);
  });

  it("does not overlay a wizard profile onto another connection", () => {
    const appBinding = {
      profileId: "app-profile",
      targetType: "company" as const,
      targetId: "company-1",
      priority: 100,
      createdAt,
    };
    const agentBinding = {
      profileId: "agent-profile",
      targetType: "agent" as const,
      targetId: "agent-1",
      priority: 100,
      createdAt,
    };

    expect(effectiveToolProfileBindings(
      [appBinding, agentBinding],
      [{
        id: "app-profile",
        profileKey: "app:connection-1",
        metadata: { source: "app_gallery_finish", connectionId: "connection-1" },
      }],
      "connection-2",
    )).toEqual([agentBinding]);
  });

  describe("server-tagged default app offerings", () => {
    const binding = (over: Record<string, unknown>) => ({
      profileId: "p", targetType: "agent" as const, targetId: "agent-1", priority: 100, createdAt, ...over,
    });
    const offering = binding({ profileId: "app-profile", metadata: { source: "default_mcp_spec", connectionId: "conn-1" } });
    const companyGeneral = binding({ profileId: "company-general", targetType: "company" as const, targetId: "company-1" });
    const wizardProfile = { id: "app-profile", profileKey: "app:conn-1", metadata: { source: "app_gallery_finish", connectionId: "conn-1" } };
    const general = { id: "company-general", profileKey: "company-default", metadata: {} };

    it("is carried alongside the company profile instead of narrowing it away", () => {
      expect(effectiveToolProfileBindings([companyGeneral, offering], [general, wizardProfile], "conn-1")).toEqual([companyGeneral, offering]);
      expect(effectiveToolProfileBindings([companyGeneral, offering], [general, wizardProfile])).toEqual([companyGeneral, offering]);
    });

    it("never overlays another connection or a gateway-only profile", () => {
      expect(effectiveToolProfileBindings([companyGeneral, offering], [general, wizardProfile], "conn-2")).toEqual([companyGeneral]);
      expect(effectiveToolProfileBindings([companyGeneral, offering], [general, wizardProfile], "conn-1", { includeAdditiveAppProfiles: false })).toEqual([companyGeneral]);
    });

    it("an explicit agent-scope profile keeps today's priority: it still narrows the company profile, and the offering rides along", () => {
      const explicit = binding({ profileId: "explicit" });
      expect(effectiveToolProfileBindings(
        [companyGeneral, explicit, offering],
        [general, wizardProfile, { id: "explicit", profileKey: "explicit", metadata: {} }],
      )).toEqual([explicit, offering]);
    });

    it("a look-alike (wrong source, no connection id, non-wizard profile, or not agent-scoped) keeps ordinary narrowing", () => {
      const lookAlikes = [
        binding({ profileId: "app-profile", metadata: { source: "tool_connection_install", connectionId: "conn-1" } }),
        binding({ profileId: "app-profile", metadata: { source: "default_mcp_spec" } }),
        binding({ profileId: "plain", metadata: { source: "default_mcp_spec", connectionId: "conn-1" } }),
        binding({ profileId: "app-profile", targetType: "project" as const, targetId: "p-1", metadata: { source: "default_mcp_spec", connectionId: "conn-1" } }),
      ];
      const profiles = [general, wizardProfile, { id: "plain", profileKey: "app:conn-1", metadata: { source: "default_mcp_spec", connectionId: "conn-1" } }];
      for (const lookAlike of lookAlikes.slice(0, 3)) {
        expect(narrowestScopeBindings([companyGeneral, lookAlike])).toEqual([lookAlike]);
        const result = effectiveToolProfileBindings([companyGeneral, lookAlike], profiles, "conn-1");
        expect(result).not.toContain(companyGeneral); // the company profile is narrowed away exactly as before
      }
      expect(effectiveToolProfileBindings([companyGeneral, lookAlikes[3]!], profiles, "conn-1")).not.toContain(companyGeneral);
    });
  });
});

import { describe, expect, it, beforeEach } from "vitest";
import {
  parseAgentKnowledgeConfig,
  getAgentKnowledgeConfig,
  isAgentKnowledgeEnabledForCompany,
  setAgentKnowledgeConfigForTests,
  resetAgentKnowledgeConfigForTests,
  validateAgentKnowledgeConfigAtBoot,
  AgentKnowledgeConfigurationError,
} from "./agent-knowledge-config.js";

describe("agent-knowledge-config", () => {
  beforeEach(() => {
    resetAgentKnowledgeConfigForTests();
  });

  const validCompanyA = "11111111-1111-4111-8111-111111111111";
  const validCompanyB = "22222222-2222-4222-8222-222222222222";

  describe("flag parsing", () => {
    it("defaults to disabled when env var is unset or empty", () => {
      expect(parseAgentKnowledgeConfig({})).toEqual({
        enabled: false,
        pilotCompanyIds: [],
      });
      expect(parseAgentKnowledgeConfig({ PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "" })).toEqual({
        enabled: false,
        pilotCompanyIds: [],
      });
      expect(parseAgentKnowledgeConfig({ PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "   " })).toEqual({
        enabled: false,
        pilotCompanyIds: [],
      });
    });

    it("parses explicit false correctly", () => {
      expect(parseAgentKnowledgeConfig({ PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "false" })).toEqual({
        enabled: false,
        pilotCompanyIds: [],
      });
    });

    it("rejects non-exact boolean representations (strict case-sensitive)", () => {
      for (const badValue of ["TRUE", "True", "1", "yes", "on", "FALSE", "False", "0", "no"]) {
        expect(
          () => parseAgentKnowledgeConfig({ PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: badValue }),
          `Expected ${badValue} to fail validation`,
        ).toThrow(AgentKnowledgeConfigurationError);
      }
    });

    it("requires pilot company allowlist when enabled", () => {
      expect(() => parseAgentKnowledgeConfig({ PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true" })).toThrow(
        AgentKnowledgeConfigurationError,
      );
      expect(() =>
        parseAgentKnowledgeConfig({
          PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true",
          PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES: "",
        }),
      ).toThrow(AgentKnowledgeConfigurationError);
    });

    it("rejects wildcard '*' in pilot companies allowlist", () => {
      expect(() =>
        parseAgentKnowledgeConfig({
          PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true",
          PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES: "*",
        }),
      ).toThrow(AgentKnowledgeConfigurationError);

      expect(() =>
        parseAgentKnowledgeConfig({
          PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true",
          PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES: `${validCompanyA},*`,
        }),
      ).toThrow(AgentKnowledgeConfigurationError);
    });

    it("rejects non-UUID strings in pilot companies allowlist", () => {
      expect(() =>
        parseAgentKnowledgeConfig({
          PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true",
          PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES: "not-a-uuid",
        }),
      ).toThrow(AgentKnowledgeConfigurationError);
    });

    it("parses valid pilot UUID allowlist with trim, lowercase, and deduplication", () => {
      const config = parseAgentKnowledgeConfig({
        PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true",
        PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES: ` ${validCompanyA.toUpperCase()} , ${validCompanyB} , ${validCompanyA} `,
      });

      expect(config.enabled).toBe(true);
      expect(config.pilotCompanyIds).toEqual([validCompanyA.toLowerCase(), validCompanyB.toLowerCase()]);
    });
  });

  describe("production boot-time validation", () => {
    it("fails with clear missing-adapter diagnostic when enabled at boot", () => {
      expect(() =>
        validateAgentKnowledgeConfigAtBoot({
          PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true",
          PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES: validCompanyA,
        }),
      ).toThrow(
        "PAPERCLIP_AGENT_KNOWLEDGE_ENABLED is true, but no authority adapter is available in this build (deferred to future milestone). Live agent knowledge cannot be enabled at boot without a registered authority adapter.",
      );
    });

    it("succeeds when disabled at boot", () => {
      expect(() =>
        validateAgentKnowledgeConfigAtBoot({
          PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "false",
        }),
      ).not.toThrow();
    });
  });

  describe("test DI override", () => {
    it("allows explicit programmatic in-memory DI for tests without env fake provider", () => {
      expect(isAgentKnowledgeEnabledForCompany(validCompanyA)).toBe(false);

      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [validCompanyA],
      });

      expect(getAgentKnowledgeConfig().enabled).toBe(true);
      expect(isAgentKnowledgeEnabledForCompany(validCompanyA)).toBe(true);
      expect(isAgentKnowledgeEnabledForCompany(validCompanyB)).toBe(false);

      resetAgentKnowledgeConfigForTests();
      expect(isAgentKnowledgeEnabledForCompany(validCompanyA)).toBe(false);
    });

    it("falls back to the cached env config once the override is cleared, not to a fresh re-parse", () => {
      // The override only masks the cached env config; clearing it must not
      // discard the cache and force an accidental re-parse mid-process.
      const cached = getAgentKnowledgeConfig();
      setAgentKnowledgeConfigForTests({ enabled: true, pilotCompanyIds: [validCompanyA] });
      setAgentKnowledgeConfigForTests(null);
      expect(getAgentKnowledgeConfig()).toBe(cached);
    });
  });

  describe("no env key can select a fake provider or force enablement", () => {
    it("ignores every non-contract env key: only the two documented variables are read", () => {
      // There is deliberately no adapter/provider/test-mode env contract in
      // this slice. A production deployment cannot fake an authority adapter
      // or force enablement through an unrelated variable -- the only ways to
      // enable are the exact boolean flag plus the UUID allowlist, and the
      // only way to make tests use a non-default config is the exported DI
      // hook above.
      const config = parseAgentKnowledgeConfig({
        PAPERCLIP_AGENT_KNOWLEDGE_ADAPTER: "fake",
        PAPERCLIP_AGENT_KNOWLEDGE_PROVIDER: "mock",
        PAPERCLIP_AGENT_KNOWLEDGE_TEST_MODE: "1",
        PAPERCLIP_AGENT_KNOWLEDGE_FORCE: "true",
        PAPERCLIP_AGENT_KNOWLEDGE_PILOT: validCompanyA,
        NODE_ENV: "test",
      } as unknown as NodeJS.ProcessEnv);
      expect(config).toEqual({ enabled: false, pilotCompanyIds: [] });
    });
  });

  describe("boot guard isolation from the test DI hook", () => {
    it("boot validation reads env only: a disabled DI override cannot silence an env-enabled boot", () => {
      // A test that left a disabled override in module state must not be able
      // to suppress the production boot failure for an enabled env.
      setAgentKnowledgeConfigForTests({ enabled: false, pilotCompanyIds: [] });
      expect(() =>
        validateAgentKnowledgeConfigAtBoot({
          PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true",
          PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES: validCompanyA,
        }),
      ).toThrow(AgentKnowledgeConfigurationError);
    });

    it("boot validation reads env only: an enabled DI override cannot trip the boot guard for a disabled env", () => {
      // The inverse direction: the override is invisible at boot, so it can
      // never take a disabled production boot down with it.
      setAgentKnowledgeConfigForTests({ enabled: true, pilotCompanyIds: [validCompanyA] });
      expect(() => validateAgentKnowledgeConfigAtBoot({})).not.toThrow();
    });

    it("boot validation rejects enabled env regardless of the pilot allowlist shape", () => {
      // Even a well-formed enabled config fails at boot in this slice: no
      // authority adapter exists to back it.
      expect(() =>
        validateAgentKnowledgeConfigAtBoot({
          PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "true",
          PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES: `${validCompanyA},${validCompanyB}`,
        }),
      ).toThrow(/no authority adapter is available in this build/);
    });
  });

  describe("module cache and process.env mutation (config state containment)", () => {
    it("caches the parsed env config: later process.env mutations cannot flip a running instance", () => {
      resetAgentKnowledgeConfigForTests();
      expect(getAgentKnowledgeConfig().enabled).toBe(false);

      const previousEnabled = process.env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED;
      const previousPilot = process.env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES;
      process.env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED = "true";
      process.env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES = validCompanyA;
      try {
        // Still disabled: the boot-time parse is sticky for the process.
        expect(getAgentKnowledgeConfig().enabled).toBe(false);
        expect(isAgentKnowledgeEnabledForCompany(validCompanyA)).toBe(false);

        // Reset is the only documented way to force a re-parse -- which is
        // exactly why the lifecycle suites reset in beforeEach: a test that
        // mutates process.env without resetting leaks nothing once it
        // restores the variables, and a test that forgets to restore plus
        // forgets to reset would poison sibling tests in the same worker.
        resetAgentKnowledgeConfigForTests();
        expect(getAgentKnowledgeConfig().enabled).toBe(true);
        expect(isAgentKnowledgeEnabledForCompany(validCompanyA)).toBe(true);
      } finally {
        if (previousEnabled === undefined) delete process.env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED;
        else process.env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED = previousEnabled;
        if (previousPilot === undefined) delete process.env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES;
        else process.env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES = previousPilot;
        resetAgentKnowledgeConfigForTests();
      }
    });

    it("boot validation seeds the module cache: getAgentKnowledgeConfig serves the boot env until reset", () => {
      resetAgentKnowledgeConfigForTests();
      // Simulate a production boot against a disabled env.
      validateAgentKnowledgeConfigAtBoot({ PAPERCLIP_AGENT_KNOWLEDGE_ENABLED: "false" });

      const previousEnabled = process.env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED;
      const previousPilot = process.env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES;
      process.env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED = "true";
      process.env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES = validCompanyA;
      try {
        // The boot-parsed (disabled) config is what the process keeps
        // serving; the later env mutation does not leak into the cache.
        expect(getAgentKnowledgeConfig().enabled).toBe(false);
        resetAgentKnowledgeConfigForTests();
        expect(getAgentKnowledgeConfig().enabled).toBe(true);
      } finally {
        if (previousEnabled === undefined) delete process.env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED;
        else process.env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED = previousEnabled;
        if (previousPilot === undefined) delete process.env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES;
        else process.env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES = previousPilot;
        resetAgentKnowledgeConfigForTests();
      }
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  MEMORY_AGENT_GUIDANCE,
  buildMemoryAgentGuidance,
  parseMemoryAgentGuidanceContext,
  parseMemoryAgentGuidanceContextResult,
  type MemoryAgentCapabilities,
  type MemoryAgentGuidanceContext,
} from "./memory-agent-guidance.js";

const PRE_CHANGE_LEGACY_LITERAL = [
  "Memory:",
  "- Task progress and handoffs go in issue comments, not memory.",
  "- Arcana is your knowledge layer: the documents and source material you work from (docs, research, specs, finished write-ups). Check it before relying on your own assumptions, and open the source before relying on a result. Propose new documents only after reading `skills/paperclip/references/arcana-brain-proposals.md`.",
  "- Mem0 is your learned memory: owner preferences, decisions (with reason and date), lessons, environment facts, procedures that worked. Mark inferences \"(inferred)\". It also saves conversation automatically, so treat recalled memories as hints: Arcana, the issue, or a source you just read wins. Preferences, decisions and lessons go to Mem0, not Arcana, even if older instructions say otherwise.",
  "- Hermes MEMORY.md/USER.md are wiped after each run; don't use them.",
  "- Never save secrets, credentials, PHI or PII.",
].join("\n");

const ALWAYS_ON_PROGRESS = "Task progress belongs in issue comments, not memory.";
const ALWAYS_ON_SAFETY = "Never save secrets, credentials, personal data, PHI, or patient/customer identifiers.";
const ARCANA_SNIPPET = "Arcana brain tools exist";
const MEM0_SNIPPET = "Mem0:";
const HERMES_SNIPPET = "Hermes built-in stores";

describe("buildMemoryAgentGuidance", () => {
  describe("variant: legacy", () => {
    it("preserves legacy byte identity against pre-change literal", () => {
      expect(MEMORY_AGENT_GUIDANCE).toBe(PRE_CHANGE_LEGACY_LITERAL);
    });

    it("returns pre-change literal byte-identical regardless of capabilities", () => {
      const cases: MemoryAgentCapabilities[] = [
        { mem0: false, arcana: false, hermesBuiltInStores: false },
        { mem0: true, arcana: false, hermesBuiltInStores: false },
        { mem0: true, arcana: true, hermesBuiltInStores: false },
        { mem0: true, arcana: false, hermesBuiltInStores: true },
        { mem0: true, arcana: true, hermesBuiltInStores: true },
        { mem0: false, arcana: true, hermesBuiltInStores: false },
        { mem0: false, arcana: false, hermesBuiltInStores: true },
        { mem0: false, arcana: true, hermesBuiltInStores: true },
      ];

      for (const capabilities of cases) {
        const result = buildMemoryAgentGuidance({
          capabilities,
          variant: "legacy",
        });
        expect(result).toBe(PRE_CHANGE_LEGACY_LITERAL);
      }
    });
  });

  describe("variant: write-rules", () => {
    const testCases: Array<{
      name: string;
      capabilities: MemoryAgentCapabilities;
    }> = [
      {
        name: "none (empty capabilities)",
        capabilities: { mem0: false, arcana: false, hermesBuiltInStores: false },
      },
      {
        name: "mem0 only",
        capabilities: { mem0: true, arcana: false, hermesBuiltInStores: false },
      },
      {
        name: "mem0 + arcana",
        capabilities: { mem0: true, arcana: true, hermesBuiltInStores: false },
      },
      {
        name: "mem0 + hermesBuiltInStores",
        capabilities: { mem0: true, arcana: false, hermesBuiltInStores: true },
      },
      {
        name: "all 3 capabilities",
        capabilities: { mem0: true, arcana: true, hermesBuiltInStores: true },
      },
      {
        name: "arcana only",
        capabilities: { mem0: false, arcana: true, hermesBuiltInStores: false },
      },
      {
        name: "hermesBuiltInStores only",
        capabilities: { mem0: false, arcana: false, hermesBuiltInStores: true },
      },
      {
        name: "arcana + hermesBuiltInStores",
        capabilities: { mem0: false, arcana: true, hermesBuiltInStores: true },
      },
    ];

    it("empty capabilities yields exactly the Memory header and two always-on lines plus nothing else", () => {
      const output = buildMemoryAgentGuidance({
        capabilities: { mem0: false, arcana: false, hermesBuiltInStores: false },
        variant: "write-rules",
      });

      expect(output).toBe(
        `Memory:\n- ${ALWAYS_ON_PROGRESS}\n- ${ALWAYS_ON_SAFETY}`,
      );
      expect(output.split("\n")).toHaveLength(3);
      expect(output.startsWith("Memory:\n")).toBe(true);
      expect(output.endsWith("\n")).toBe(false);
      expect(output).not.toContain("Mem0");
      expect(output).not.toContain("Arcana");
      expect(output).not.toContain("Hermes");
    });

    it("hermes-only guidance does not mention Mem0 or Arcana", () => {
      const output = buildMemoryAgentGuidance({
        capabilities: { mem0: false, arcana: false, hermesBuiltInStores: true },
        variant: "write-rules",
      });

      expect(output).toContain("- Hermes built-in stores handle session continuity.");
      expect(output.endsWith("\n")).toBe(false);
      expect(output).not.toContain("Mem0");
      expect(output).not.toContain("Arcana");
      expect(output).not.toContain("duplicate");
    });

    it("mem0-only guidance does not mention Hermes or Arcana", () => {
      const output = buildMemoryAgentGuidance({
        capabilities: { mem0: true, arcana: false, hermesBuiltInStores: false },
        variant: "write-rules",
      });

      expect(output).toContain(MEM0_SNIPPET);
      expect(output.endsWith("\n")).toBe(false);
      expect(output).not.toContain("Hermes");
      expect(output).not.toContain("Arcana");
    });

    it("both hermes and mem0 enabled includes the Mem0-specific duplication warning", () => {
      const output = buildMemoryAgentGuidance({
        capabilities: { mem0: true, arcana: false, hermesBuiltInStores: true },
        variant: "write-rules",
      });

      expect(output).toContain(
        "- Hermes built-in stores handle session continuity; do not duplicate that in Mem0.",
      );
      expect(output).toContain(MEM0_SNIPPET);
      expect(output.endsWith("\n")).toBe(false);
    });

    it.each(testCases)(
      "formats correctly for $name",
      ({ capabilities }) => {
        const output = buildMemoryAgentGuidance({
          capabilities,
          variant: "write-rules",
        });

        // Starts with Memory: header
        expect(output.startsWith("Memory:\n")).toBe(true);

        // Always-on rules appear in every output
        expect(output).toContain(ALWAYS_ON_PROGRESS);
        expect(output).toContain(ALWAYS_ON_SAFETY);

        // Unavailable tools must not be mentioned anywhere
        if (!capabilities.arcana) {
          expect(output).not.toContain("Arcana");
        } else {
          expect(output).toContain(ARCANA_SNIPPET);
        }

        if (!capabilities.mem0) {
          expect(output).not.toContain("Mem0");
        } else {
          expect(output).toContain(MEM0_SNIPPET);
        }

        if (!capabilities.hermesBuiltInStores) {
          expect(output).not.toContain("Hermes");
        } else {
          expect(output).toContain(HERMES_SNIPPET);
        }

        // No trailing newline, no double blank lines
        expect(output.endsWith("\n")).toBe(false);
        expect(output).not.toContain("\n\n");
      },
    );
  });
});

describe("parseMemoryAgentGuidanceContext", () => {
  it("parses valid guidance contexts", () => {
    const validLegacy = {
      capabilities: { mem0: true, arcana: false, hermesBuiltInStores: true },
      variant: "legacy" as const,
    };
    expect(parseMemoryAgentGuidanceContext(validLegacy)).toEqual(validLegacy);

    const validWriteRules = {
      capabilities: { mem0: false, arcana: true, hermesBuiltInStores: false },
      variant: "write-rules" as const,
    };
    expect(parseMemoryAgentGuidanceContext(validWriteRules)).toEqual(validWriteRules);
  });

  it("returns undefined for null, undefined, primitives, and malformed structures", () => {
    expect(parseMemoryAgentGuidanceContext(null)).toBeUndefined();
    expect(parseMemoryAgentGuidanceContext(undefined)).toBeUndefined();
    expect(parseMemoryAgentGuidanceContext("string")).toBeUndefined();
    expect(parseMemoryAgentGuidanceContext(42)).toBeUndefined();
    expect(parseMemoryAgentGuidanceContext({})).toBeUndefined();
    expect(
      parseMemoryAgentGuidanceContext({
        capabilities: { mem0: true, arcana: false, hermesBuiltInStores: true },
        variant: "unknown-variant",
      }),
    ).toBeUndefined();
    expect(
      parseMemoryAgentGuidanceContext({
        capabilities: { mem0: "true", arcana: false, hermesBuiltInStores: true },
        variant: "write-rules",
      }),
    ).toBeUndefined();
    expect(
      parseMemoryAgentGuidanceContext({
        capabilities: null,
        variant: "write-rules",
      }),
    ).toBeUndefined();
  });
});

describe("parseMemoryAgentGuidanceContextResult", () => {
  it("returns { status: 'absent' } when input is undefined", () => {
    expect(parseMemoryAgentGuidanceContextResult(undefined)).toEqual({ status: "absent" });
  });

  it("returns { status: 'valid', data } for valid guidance contexts", () => {
    const validLegacy = {
      capabilities: { mem0: true, arcana: false, hermesBuiltInStores: true },
      variant: "legacy" as const,
    };
    expect(parseMemoryAgentGuidanceContextResult(validLegacy)).toEqual({
      status: "valid",
      data: validLegacy,
    });

    const validWriteRules = {
      capabilities: { mem0: false, arcana: true, hermesBuiltInStores: false },
      variant: "write-rules" as const,
    };
    expect(parseMemoryAgentGuidanceContextResult(validWriteRules)).toEqual({
      status: "valid",
      data: validWriteRules,
    });
  });

  it("returns { status: 'malformed', error } for non-undefined invalid input", () => {
    const malformedCases = [
      null,
      "string",
      42,
      {},
      { capabilities: { mem0: true, arcana: false, hermesBuiltInStores: true }, variant: "unknown-variant" },
      { capabilities: { mem0: "true", arcana: false, hermesBuiltInStores: true }, variant: "write-rules" },
      { capabilities: null, variant: "write-rules" },
    ];
    for (const val of malformedCases) {
      const res = parseMemoryAgentGuidanceContextResult(val);
      expect(res.status).toBe("malformed");
      if (res.status === "malformed") {
        expect(res.error).toBeDefined();
      }
    }
  });
});

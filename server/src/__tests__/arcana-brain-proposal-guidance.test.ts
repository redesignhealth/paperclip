import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const REFERENCE = "skills/paperclip/references/arcana-brain-proposals.md";

describe("agent guidance for proposing into the agent's own Arcana brain", () => {
  it("is delivered through the paperclip skill and the default agent instructions", () => {
    expect(read("skills/paperclip/SKILL.md")).toContain("references/arcana-brain-proposals.md");
    expect(read("server/src/onboarding-assets/default/AGENTS.md")).toContain("references/arcana-brain-proposals.md");
  });

  it("covers the required points and stays short", () => {
    const guide = read(REFERENCE);
    expect(guide.split("\n").length).toBeLessThan(80);
    for (const needle of [
      "proposals_submit",
      "proposals_get",
      "PHI",
      "PII",
      "never auto-approve",
      "never auto-approved",
      "agent-profile",
      "not enabled yet",
      "both owners",
      "Only full documents",
      "arcana_source_add",
      "arcana_source_revise",
      "supersedes_revision",
      "arcana-source:",
      "sha256",
      "citations",
      "apply_failed",
    ]) {
      expect(guide, needle).toContain(needle);
    }
  });
});

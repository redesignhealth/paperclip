import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const REFERENCE = "skills/paperclip/references/arcana-brain-proposals.md";

/** Full text of the `## ` section whose header (without the `## ` prefix) matches, or null when absent. */
const sectionOf = (markdown: string, header: RegExp): string | null => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^##\s/.test(line) && header.test(line.replace(/^##\s/, "")));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
};

describe("agent guidance for proposing into the agent's own Arcana brain", () => {
  it("is delivered through the paperclip skill and the default agent instructions", () => {
    expect(read("skills/paperclip/SKILL.md")).toContain("references/arcana-brain-proposals.md");
    expect(read("server/src/onboarding-assets/default/AGENTS.md")).toContain("references/arcana-brain-proposals.md");
  });

  it("is pointed at early in the paperclip skill, before the Terminology header, not merely anywhere", () => {
    const skill = read("skills/paperclip/SKILL.md");
    const pointer = skill.indexOf("references/arcana-brain-proposals.md");
    const terminology = skill.indexOf("## Terminology");
    expect(pointer).toBeGreaterThanOrEqual(0);
    expect(terminology).toBeGreaterThanOrEqual(0);
    expect(pointer).toBeLessThan(terminology);
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

  it("documents the complete top-level proposals_submit envelope for arcana_source_add", () => {
    const add = sectionOf(read(REFERENCE), /arcana_source_add/);
    expect(add, "## How: arcana_source_add section").toBeTruthy();
    const addSection = add ?? "";
    expect(addSection).toMatch(/kind[^\n]{0,40}arcana_source_add/);
    for (const field of ["rationale", "confidence", "importance", "impact"]) {
      expect(addSection, `top-level ${field}`).toContain(field);
    }
    expect(addSection).toMatch(/top[- ]level/i);
    expect(addSection).toMatch(/low[^\n]{0,30}medium[^\n]{0,30}high/);
  });

  it("keeps every fenced action example in the add section a pure source_add: required fields, derived target_id, no revise fields", () => {
    const addSection = sectionOf(read(REFERENCE), /arcana_source_add/) ?? "";
    const fragments = [...addSection.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .map((m) => m[1]!.trim())
      .filter((block) => block.startsWith('"action"'));
    expect(fragments.length, 'fenced "action" example in the add section').toBeGreaterThan(0);
    for (const fragment of fragments) {
      const action = JSON.parse(`{${fragment}}`).action as Record<string, unknown>;
      expect(action.action_type).toBe("source_add");
      expect(typeof action.logical_id).toBe("string");
      expect(typeof action.filename).toBe("string");
      expect(String(action.filename)).not.toMatch(/[/\\]|\.\./);
      expect(typeof action.content).toBe("string");
      expect(String(action.content)).not.toMatch(/^Source document:/m);
      expect(typeof action.sha256).toBe("string");
      expect(action.target_id).toBe(`arcana-source:${action.logical_id}`);
      expect(typeof action.audience).toBe("string");
      expect(Array.isArray(action.citations)).toBe(true);
      // The add example must not mix revise-only fields into the action.
      expect("supersedes_revision" in action).toBe(false);
      // Envelope fields stay top-level, outside action.
      for (const field of ["rationale", "confidence", "importance", "impact"]) {
        expect(field in action, `${field} must stay top-level, not inside action`).toBe(false);
      }
      // Every field the example shows is still named as required in the section.
      for (const key of Object.keys(action)) expect(addSection, `required field \`${key}\``).toContain(`\`${key}\``);
    }
  });

  it("documents the new-logical-id workaround while revise is unverified, without promising the old document goes away", () => {
    const addSection = sectionOf(read(REFERENCE), /arcana_source_add/) ?? "";
    expect(addSection).toMatch(/(?:new|fresh|another|second)\s+`?logical_id/i);
    expect(addSection).toMatch(/rationale[^\n]{0,120}(identif|current|version)/i);
    expect(addSection).toMatch(/omit[^\n]{0,60}`?supersedes_revision/i);
    expect(addSection).toMatch(/(?:never|do not|don't)\s+mix/i);
    expect(addSection).toMatch(
      /\b(?:not|never|no longer|cannot|won'?t)\s+(?:supersede|remove|replace|update|delete)/i,
    );
    expect(addSection).toMatch(/old\s+(?:document|revision|source|version)/i);
  });

  it("documents the citation contract: length is the quote's character count, exact span match, and empty citations mean a human", () => {
    const addSection = sectionOf(read(REFERENCE), /arcana_source_add/) ?? "";
    for (const key of ["revision_id", "offset", "length", "quote"]) {
      expect(addSection, `citation field ${key}`).toContain(key);
    }
    expect(addSection).toMatch(/length[^\n]{0,120}char/i);
    expect(addSection).toMatch(/quote[^\n]{0,120}exact|exact[^\n]{0,120}quote/);
    expect(addSection).toMatch(/citations[^\n]{0,80}\[\][^\n]{0,120}human|human[^\n]{0,200}citations[^\n]{0,80}\[\]/);
    // Cross-brain proposals cite nothing and go to a human that way.
    expect(addSection).toMatch(
      /cross-brain[^\n]{0,160}citations[^\n]{0,40}\[\]|citations[^\n]{0,40}\[\][^\n]{0,160}cross-brain/i,
    );
  });

  it("gates arcana_source_revise as a future path awaiting verified deployment proof, not a currently-working one", () => {
    const revise = sectionOf(read(REFERENCE), /arcana_source_revise/);
    expect(revise, "## How: arcana_source_revise section").toBeTruthy();
    const reviseSection = revise ?? "";
    expect(reviseSection).toMatch(/future|gated|readiness/i);
    expect(reviseSection).toMatch(/verif/i);
    // Current behavior: accepted at submission time, but fails at apply time until operational.
    expect(reviseSection).toMatch(/accepted[^\n]{0,60}submi|submi[^\n]{0,60}accepted/i);
    expect(reviseSection).toMatch(/fail[^\n]{0,60}apply|apply[^\n]{0,60}fail/i);
    expect(reviseSection).toContain("apply_failed");
    expect(reviseSection).toMatch(/not (?:yet )?operational|until[^\n]{0,60}(?:revision|path|lands)/i);
    // Future path: gated on deployment and verified DEV proof, not a feature gate.
    expect(reviseSection).toMatch(/readiness|deploy/i);
    expect(reviseSection).toMatch(/DEV\s+proof/i);

    // Negative assertions: no removed env flag, no feature gate claim, and no submit refusal / 422.
    expect(read(REFERENCE)).not.toContain("ARCANA_SOURCE_REVISE_ENABLED");
    expect(read(REFERENCE)).not.toMatch(/feature\s+gate/i);
    expect(reviseSection).not.toMatch(/422/);
    expect(reviseSection).not.toMatch(/reject[^\n]{0,40}submi|submi[^\n]{0,40}reject/i);
    expect(reviseSection).not.toMatch(/refus/i);

    expect(reviseSection).toContain("supersedes_revision");
    expect(reviseSection).toMatch(/supersedes_revision[^\n]{0,120}head|head[^\n]{0,120}supersedes_revision/);
    // Open by the current revision id; open_source with a logical id may only appear as invalid.
    expect(reviseSection).toMatch(/open_source\(\s*`?revision_id/);
    for (const line of reviseSection
      .split("\n")
      .filter((l) => l.includes("open_source") && l.includes("logical_id"))) {
      expect(line, line).toMatch(/\b(?:not valid|invalid|never|do not|isn't|no)\b/i);
    }
    // On stale, re-discover the current head and submit a fresh proposal.
    expect(reviseSection).toMatch(/stale/i);
    expect(reviseSection).toMatch(/re-?read|re-?discover/i);
    expect(reviseSection).toMatch(/current\s+(?:revision|head)/i);
  });

  it("documents cross-brain proposals as conditionally available, never blanket-off, and always both-owner human approved", () => {
    const approval = sectionOf(read(REFERENCE), /After submitting/);
    expect(approval, "## After submitting and approval section").toBeTruthy();
    const approvalSection = approval ?? "";
    const crossBrainClauses = approvalSection
      .split(/[.;]\s+|\n/)
      .filter((clause) => /cross-brain/i.test(clause));
    expect(crossBrainClauses.length, "cross-brain guidance in the approval section").toBeGreaterThan(0);
    const conditional = crossBrainClauses.some((clause) =>
      /\b(?:may|can|might|could)\b[^\n]{0,80}available|depending on|when available|some deployments|configuration/i.test(
        clause,
      ),
    );
    expect(conditional, "cross-brain availability is conditional, not blanket-off").toBe(true);
    expect(approvalSection).toMatch(
      /both owners[^\n]{0,200}never auto-?approved|never auto-?approved[^\n]{0,200}both owners/i,
    );
    expect(approvalSection).toMatch(/proposal_id/);
    expect(approvalSection).toMatch(/(?:poll|check|call)[^\n]{0,120}(?:later|next run|not in a loop)/i);
  });
});

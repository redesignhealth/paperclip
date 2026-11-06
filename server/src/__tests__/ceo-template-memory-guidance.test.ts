import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const assets = path.resolve(import.meta.dirname, "../onboarding-assets/ceo");
const read = (file: string) => fs.readFileSync(path.join(assets, file), "utf8").replace(/\r\n/g, "\n");
const REFERENCE = "skills/paperclip/references/arcana-brain-proposals.md";

describe("CEO onboarding templates route memory to Mem0 and Arcana", () => {
  it("AGENTS.md has a Memory section with conditional tool routing and always-on rules", () => {
    const agents = read("AGENTS.md");
    expect(agents).toContain("## Memory\n");
    expect(agents).toContain("When Mem0 tools are available, Mem0 is your learned memory");
    expect(agents).toContain("Treat recalled memories as hints");
    expect(agents).toContain("When Arcana brain tools are available, Arcana is your knowledge layer");
    expect(agents).toContain(
      "- When running on Hermes, Hermes built-in stores (MEMORY.md/USER.md) are scratch/local session context, not a durable store; use issue comments, and Mem0/Arcana when their tools are available.",
    );
    expect(agents).toContain("Task progress and handoffs go in issue comments, not memory.");
    expect(agents).toContain("When memory tools or stores are available, retain durable facts and preferences with the why");
    expect(agents).toContain("Never save secrets, credentials, personal data, PHI or PII.");
    expect(agents).toContain(REFERENCE);
    expect(agents).toContain("## Planning");
    expect(agents).toContain("Use issue comments for progress and durable outcomes, and Mem0/Arcana when their tools are available");
    expect(agents).not.toContain("para-memory-files");
    expect(agents).not.toContain("for all memory operations");
    expect(agents).not.toMatch(/personal files \(life, memory/);
    expect(agents).not.toContain("extraction checklist");
    expect(agents).not.toContain("handle session continuity");
    expect(agents).not.toContain("When Hermes built-in stores are available");
  });

  it("HEARTBEAT.md makes memory capture conditional on available tools while preserving always-on rules", () => {
    const heartbeat = read("HEARTBEAT.md");
    expect(heartbeat).not.toContain("$AGENT_HOME/life/");
    expect(heartbeat).not.toContain("$AGENT_HOME/memory/");
    expect(heartbeat).not.toContain("Fact Extraction");
    expect(heartbeat).not.toMatch(/daily notes/i);
    expect(heartbeat).not.toContain("Local Planning");
    expect(heartbeat).toContain("## 7. Memory Capture");
    expect(heartbeat).toContain("Task progress and handoffs go in issue comments, not memory.");
    expect(heartbeat).toContain("When memory tools or stores are available, retain durable facts and preferences with the why");
    expect(heartbeat).toContain("When Mem0 tools are available, save durable facts and preferences with the why");
    expect(heartbeat).toContain("Treat recalled memories as hints");
    expect(heartbeat).toContain("When Arcana brain tools are available, documents and source material go to Arcana");
    expect(heartbeat).toContain(
      "6. When running on Hermes, Hermes built-in stores (MEMORY.md/USER.md) are scratch/local session context, not a durable store; use issue comments, and Mem0/Arcana when their tools are available.",
    );
    expect(heartbeat).toContain("Never save secrets, credentials, personal data, PHI or PII.");
    expect(heartbeat).toContain(REFERENCE);
    expect(heartbeat).not.toContain("handle session continuity");
    expect(heartbeat).not.toContain("When Hermes built-in stores are available");
  });
});

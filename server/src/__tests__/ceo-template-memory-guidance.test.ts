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
    expect(agents).toContain("Mem0 is your learned memory");
    expect(agents).toContain("When Mem0 tools are available, Mem0 is your learned memory");
    expect(agents).toContain("Arcana is your knowledge layer");
    expect(agents).toContain("When Arcana brain tools are available, Arcana is your knowledge layer");
    expect(agents).toContain("Task progress and handoffs go in issue comments, not memory.");
    expect(agents).toContain("Always retain durable facts and preferences with the why");
    expect(agents).toContain("Never save secrets, credentials, PHI or PII.");
    expect(agents).toContain(REFERENCE);
    expect(agents).toContain("## Planning");
    expect(agents).toContain("When memory tools are available, memory goes to Mem0 and Arcana");
    expect(agents).not.toContain("para-memory-files");
    expect(agents).not.toContain("for all memory operations");
    expect(agents).not.toMatch(/personal files \(life, memory/);
    expect(agents).not.toContain("extraction checklist");
  });

  it("HEARTBEAT.md makes memory capture conditional on available tools while preserving always-on rules", () => {
    const heartbeat = read("HEARTBEAT.md");
    expect(heartbeat).not.toContain("$AGENT_HOME/life/");
    expect(heartbeat).not.toContain("$AGENT_HOME/memory/");
    expect(heartbeat).not.toContain("Fact Extraction");
    expect(heartbeat).not.toMatch(/daily notes/i);
    expect(heartbeat).not.toContain("Local Planning");
    expect(heartbeat).toContain("## 7. Memory Capture");
    expect(heartbeat).toContain("When Mem0 tools are available, save durable facts and preferences with the why");
    expect(heartbeat).toContain("When Arcana brain tools are available, documents and source material go to Arcana");
    expect(heartbeat).toContain("Retain durable facts and preferences with the why");
    expect(heartbeat).toContain("keep progress in issue comments, not memory");
    expect(heartbeat).toContain("Never save secrets, credentials, PHI or PII.");
    expect(heartbeat).toContain(REFERENCE);
  });
});

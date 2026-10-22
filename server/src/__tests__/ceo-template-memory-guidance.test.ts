import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const assets = path.resolve(import.meta.dirname, "../onboarding-assets/ceo");
const read = (file: string) => fs.readFileSync(path.join(assets, file), "utf8").replace(/\r\n/g, "\n");
const REFERENCE = "skills/paperclip/references/arcana-brain-proposals.md";

describe("CEO onboarding templates route memory to Mem0 and Arcana", () => {
  it("AGENTS.md has a Memory section and no file-based memory wording", () => {
    const agents = read("AGENTS.md");
    expect(agents).toContain("## Memory\n");
    expect(agents).toContain("Mem0 is your learned memory");
    expect(agents).toContain("Arcana is your knowledge layer");
    expect(agents).toContain(REFERENCE);
    expect(agents).toContain("## Planning");
    expect(agents).not.toContain("para-memory-files");
    expect(agents).not.toContain("for all memory operations");
    expect(agents).not.toMatch(/personal files \(life, memory/);
    expect(agents).not.toContain("extraction checklist");
  });

  it("HEARTBEAT.md no longer sends facts or notes to per-run files", () => {
    const heartbeat = read("HEARTBEAT.md");
    expect(heartbeat).not.toContain("$AGENT_HOME/life/");
    expect(heartbeat).not.toContain("$AGENT_HOME/memory/");
    expect(heartbeat).not.toContain("Fact Extraction");
    expect(heartbeat).not.toMatch(/daily notes/i);
    expect(heartbeat).not.toContain("Local Planning");
    expect(heartbeat).toContain("## 7. Memory Capture");
    expect(heartbeat).toContain(REFERENCE);
  });
});

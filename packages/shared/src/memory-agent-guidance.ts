/**
 * Canonical memory-routing instructions appended to every agent run prompt.
 *
 * Tool syntax is left to each tool's own schema and to the Arcana proposals
 * reference; this text only routes knowledge to its one home.
 */
export const MEMORY_AGENT_GUIDANCE = [
  "Memory:",
  "- Task progress and handoffs go in issue comments, not memory.",
  "- Arcana is your knowledge layer: the documents and source material you work from (docs, research, specs, finished write-ups). Check it before relying on your own assumptions, and open the source before relying on a result. Propose new documents only after reading `skills/paperclip/references/arcana-brain-proposals.md`.",
  "- Mem0 is your learned memory: owner preferences, decisions (with reason and date), lessons, environment facts, procedures that worked. Mark inferences \"(inferred)\". It also saves conversation automatically, so treat recalled memories as hints: Arcana, the issue, or a source you just read wins. Preferences, decisions and lessons go to Mem0, not Arcana, even if older instructions say otherwise.",
  "- Hermes MEMORY.md/USER.md are wiped after each run; don't use them.",
  "- Never save secrets, credentials, PHI or PII.",
].join("\n");

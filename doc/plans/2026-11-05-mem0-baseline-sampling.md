# Mem0 Baseline Sampling Procedure

**Date:** 2026-11-05  
**Tickets:** TECH-8188, TECH-8187  
**Scope:** Operator guide for read-only memory sampling and hand-classification rubric.

---

## 1. Executive Summary & Purpose

Paperclip uses Mem0 for agent semantic memory. Under TECH-8187 / TECH-8188, we establish empirical baseline metrics for Mem0 before rolling out memory hardening (cross-agent scoping, noise filtering, and implicit prompt guidance).

This runbook defines:
1. The read-only database sampling procedure using `scripts/sample-mem0-memory-content.ts`.
2. The hand-classification rubric for categorizing sampled memories.

---

## 2. Privacy & Operational Security Notice

> **CRITICAL PRIVACY REQUIREMENT:**
> **Raw memory content must NEVER be pasted into Linear tickets, pull requests, Slack channels, or documentation.**
> Operators may only publish:
> - Aggregate row counts (total memories, count per agent, count per category).
> - Redacted summary statistics and noise ratios.
> - Short, double-redacted excerpts (first $N$ characters masked with `[REDACTED_N_CHARS]`, credentials scrubbed).
>
> Sample export files (`--out`) must be placed in ephemeral or operator-local directories (e.g., `/tmp/` or git-ignored directories). Never commit memory content files.

---

## 3. Operator Procedure: Read-Only Memory Sampling

The script `scripts/sample-mem0-memory-content.ts` inspects existing Mem0 collection tables, prints agent breakdown counts to `stdout`, and exports a redacted sample of memory data to a designated local file.

### 3.1 Safety Invariants
- **Read-Only Session:** The script issues `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` immediately upon opening the connection.
- **Strict Flag Requirements:** Refuses to run without explicit `--out` and `--limit` flags.
- **Content Isolation:** Memory content is **never** written to `stdout`.
- **Redaction Pipeline:** Applies credential scrubbing via `redactSensitiveString` and prefix masking (default 16 chars).

### 3.2 Invocation

Set your target database URL (per-company database or platform database) and run:

```bash
# Option A: using repo tsx launcher
node cli/node_modules/tsx/dist/cli.mjs scripts/sample-mem0-memory-content.ts \
  --out /tmp/mem0-sample-2026-11-05.json \
  --limit 100

# Option B: custom table and company filter
node cli/node_modules/tsx/dist/cli.mjs scripts/sample-mem0-memory-content.ts \
  --out /tmp/mem0-company-sample.json \
  --limit 50 \
  --table mem0_memories \
  --company comp_prod_01 \
  --redact-prefix 20
```

### 3.3 Expected Output

`stdout` displays only high-level metadata and counts:

```text
Connecting to memory database in read-only mode...
Querying memory counts by agent from table "mem0_memories"...
Total memory rows in "mem0_memories": 842
Memory count breakdown by agent:
  - 8a7c2e11-8842-4f3b-b72e-324cfa990012: 512
  - 41f09b55-a012-42bb-90dd-ef0119283311: 290
  - (none): 40
Extracting sample of up to 100 rows (redacted)...
Successfully exported 100 redacted samples to /tmp/mem0-sample-2026-11-05.json
CRITICAL: Raw memory content is never written to stdout and must never be committed.
```

The output file `/tmp/mem0-sample-2026-11-05.json` contains:
```json
{
  "metadata": {
    "exportedAt": "2026-11-05T20:15:00.000Z",
    "table": "mem0_memories",
    "companyFilter": null,
    "totalCount": 842,
    "sampleLimit": 100,
    "sampleCount": 100,
    "redactPrefixChars": 16,
    "agentBreakdown": [
      { "agent_id": "8a7c2e11-8842-4f3b-b72e-324cfa990012", "count": 512 },
      { "agent_id": "41f09b55-a012-42bb-90dd-ef0119283311", "count": 290 },
      { "agent_id": "(none)", "count": 40 }
    ]
  },
  "samples": [
    {
      "id": "mem_01h8a9...",
      "agentId": "8a7c2e11-8842-4f3b-b72e-324cfa990012",
      "userId": null,
      "dataRedacted": "[REDACTED_16_CHARS]prefer JSON output for sprint planning summaries",
      "createdAt": "2026-11-05T19:40:12.000Z"
    }
  ]
}
```

---

## 4. Hand-Classification Rubric

When reviewing sampled memories to assess signal-to-noise ratio, categorize each memory into one of four buckets:

| Category | Definition | Representative Indicators | Target Action |
| :--- | :--- | :--- | :--- |
| **`template_boilerplate`** | Static fragments from system instructions, AGENTS.md, role definitions, tool schemas, or prompt templates. | *"You are an AI assistant"*, *"Available tools: mem0_add"*, *"Follow Paperclip standard instructions"* | Filter out at extraction time |
| **`task_status`** | Transient operational progress, heartbeat acknowledgements, turn numbers, or issue state updates. | *"Heartbeat check 2 complete"*, *"Started working on issue #104"*, *"Task status is in_progress"* | Restrict to run log / discard from semantic memory |
| **`durable_fact`** | High-value, persistent knowledge: user preferences, release codenames, architecture conventions, environment facts. | *"Release codename is aurora-2026"*, *"Format weekly updates with ### WEEKLY UPDATE ### header"*, *"Database pool timeout is 30s"* | Retain and rank highly in recall |
| **`duplicate_conflicting`** | Redundant repeats of already known facts, or statements directly contradicting existing memories without revision. | Exact duplicate strings across runs, conflicting release codenames without superseding metadata | Deduplicate or resolve via upsert |

### Noise Ratio Calculation
$$\text{Noise Ratio} = \frac{\text{Count}(\text{template\_boilerplate}) + \text{Count}(\text{task\_status})}{\text{Total Evaluated Memories}}$$
- **Baseline target:** Unconstrained baseline often shows noise ratios of 60%–85%.
- **Hardened target:** Hardened extraction aims for $\le 30\%$ noise ratio.


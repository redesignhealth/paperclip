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

### Sensitive Near-Raw Content Contract
The script's redaction pipeline:
- Masks the first $N$ characters (default 16) with `[REDACTED_N_CHARS]`, leaving the remainder verbatim.
- Scrubs exact string matches of configured process environment variables matching key/token/secret/password patterns, as well as password components parsed from connection URLs.
- **Does NOT** perform natural-language PII detection or scrub arbitrary unconfigured credentials.
- **The export file contains sensitive near-raw content and is NOT safe for public distribution or version control.**

### Output File Protection
- Sample export files (`--out`) are written exclusively with mode `0600` (owner read/write only) and the `wx` flag (exclusive creation, refusing to overwrite existing files).
- The script actively detects and **refuses** output paths resolving inside the repository worktree to prevent accidental staging.
- Place all output files in ephemeral external storage such as `/tmp/`. Always check `git status` after execution.

---

## 3. Operator Procedure: Read-Only Memory Sampling

The script `scripts/sample-mem0-memory-content.ts` inspects existing Mem0 collection tables, prints agent breakdown counts to `stdout`, and exports a redacted sample of memory data to a designated local file.

### 3.1 Safety Invariants
- **Database Boundary is Company Boundary:** Mem0 collection tables are strictly single-tenant per database (isolated via `company_memory_databases`). Control-plane databases do not contain Mem0 tables. Scoping is enforced by supplying the target company's memory database via `--database-url` (or the `COMPANY_MEMORY_DATABASE_URL` environment variable).
- **Read-Only Transaction:** All queries execute on a single connection inside a transaction starting with `SET TRANSACTION READ ONLY;`.
- **Client Teardown:** The database client pool is always ended in a `finally` block to prevent process hangs or connection leaks.
- **Strict Flag Requirements:** Refuses to run without explicit `--out` and `--limit` flags, and requires `--database-url` (or `COMPANY_MEMORY_DATABASE_URL`).
- **Identifier Validation:** Table identifiers are strictly validated against safe SQL identifier rules and support bare names (e.g. `mem0_memories`) and schema-qualified names (e.g. `public.mem0_memories`).
- **Consistent Agent Scoping:** An optional `--agent <agentId>` filter is applied consistently across all queries (total count, breakdown, and sample).
- **Content Isolation:** Memory content is **never** written to `stdout`.

### 3.2 Invocation

```bash
# Option A: basic sample with explicit database URL
node cli/node_modules/tsx/dist/cli.mjs scripts/sample-mem0-memory-content.ts \
  --database-url "postgres://tenant_user:pass@db.example.com:5432/comp_prod_01_mem" \
  --out /tmp/mem0-sample-2026-11-05.json \
  --limit 100

# Option B: custom table, agent filter, and prefix length
node cli/node_modules/tsx/dist/cli.mjs scripts/sample-mem0-memory-content.ts \
  --database-url "postgres://tenant_user:pass@db.example.com:5432/comp_prod_01_mem" \
  --out /tmp/mem0-agent-sample.json \
  --limit 50 \
  --table mem0_memories \
  --agent 8a7c2e11-8842-4f3b-b72e-324cfa990012 \
  --redact-prefix 20
```

### 3.3 Expected Output

`stdout` displays only high-level metadata and counts:

```text
Connecting to memory database in read-only mode...
Querying memory counts from table "mem0_memories"...
Total memory rows in "mem0_memories": 842
Memory count breakdown by agent:
  - 8a7c2e11-8842-4f3b-b72e-324cfa990012: 512
  - 41f09b55-a012-42bb-90dd-ef0119283311: 290
  - (none): 40
Extracting sample of up to 100 rows (redacted)...
Successfully exported 100 redacted samples to /tmp/mem0-sample-2026-11-05.json
CRITICAL: Output contains sensitive near-raw memory data. It must never be committed or published.
```

The output file `/tmp/mem0-sample-2026-11-05.json` contains:
```json
{
  "metadata": {
    "exportedAt": "2026-11-05T20:15:00.000Z",
    "table": "mem0_memories",
    "agentFilter": null,
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

### 3.4 Key Conventions & Downstream Representation
Downstream consumers and analysis scripts should note:
- `metadata.agentBreakdown` uses `snake_case` keys: `{ agent_id: string, count: number }`. Unassigned memories (null in payload) are labeled with the sentinel string `"(none)"`.
- `metadata.agentFilter` is the agent ID if filtered via `--agent`, or `null` if unscoped across all agents in the company database.
- `samples` uses `camelCase` keys:
  - `id`: Unique record identifier (`id` column).
  - `agentId`: Extracted from `payload->>'agent_id'`, or `null` if unassigned (contrasting with `"(none)"` in aggregation).
  - `userId`: Extracted from `payload->>'user_id'`.
  - `dataRedacted`: Masked and scrubbed memory content from `payload->>'data'`.
  - `createdAt`: Extracted from `payload->>'created_at'` (ISO-8601 string or null). Ordered by `payload->>'created_at' DESC NULLS LAST`.

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

Operators should count all four categories individually. Two complementary ratios are computed:

1. **Strict Noise Ratio (Full Context Pollution):**
   Treats boilerplate, ephemeral task status, and duplicate/conflicting records as noise diluting retrieval:
   $$\text{Noise Ratio}_{\text{strict}} = \frac{\text{Count}(\text{template\_boilerplate}) + \text{Count}(\text{task\_status}) + \text{Count}(\text{duplicate\_conflicting})}{\text{Total Evaluated Memories}}$$

2. **Extraction-Only Noise Ratio (System Prompt & Turn Pollution):**
   Focuses specifically on prompt and progress leakage into extraction:
   $$\text{Noise Ratio}_{\text{extraction}} = \frac{\text{Count}(\text{template\_boilerplate}) + \text{Count}(\text{task\_status})}{\text{Total Evaluated Memories}}$$

- **Baseline:** Pre-hardening noise baseline will be established empirically via this sampling run across active companies.
- **Hardened target:** Hardened extraction (prompt isolation and template filtering) aims for $\le 30\%$ strict noise ratio.

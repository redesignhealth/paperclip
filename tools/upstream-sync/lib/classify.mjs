export const CATEGORIES = ["feature", "fix", "perf", "security", "infra", "breaking"];

const INFRA_FILE_RE = /^(\.github\/|docker\/|Dockerfile|scripts\/|pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|tsconfig|vitest\.config|\.dockerignore|releases\/|tests\/)/;
const TEST_OR_DOC_RE = /(^|\/)(__tests__|tests?)\/|\.test\.|\.spec\.|\.md$|^doc(s)?\//;

// Deterministic fallback. Also used as the safety net when the LLM is unavailable,
// so rows never stay unclassified and feature alerts are not silently skipped.
export function heuristicClassify(c) {
  const t = c.title.toLowerCase();
  const text = `${c.title}\n${c.body || ""}`.toLowerCase();
  const prefix = (t.match(/^([a-z]+)(\([^)]*\))?(!)?:/) || [])[1];
  const bang = /^[a-z]+(\([^)]*\))?!:/.test(t) || /breaking change/.test(text);
  let category;
  if (bang) category = "breaking";
  else if (/\b(cve-\d|vulnerab|security|xss|csrf|ssrf|sql injection|\brce\b|auth bypass|privilege escalation|secret leak|redact)/.test(text) || prefix === "security") category = "security";
  else if (prefix === "perf" || /\b(perf|performance|faster|speed up|reduce latency|optimi[sz])/.test(t)) category = "perf";
  else if (["ci", "build", "chore", "docs", "test", "tests", "refactor", "style", "release", "deps"].includes(prefix)) category = "infra";
  else if (prefix === "feat" || /^(add|introduce|support|implement)\b/.test(t)) category = "feature";
  else if (prefix === "fix" || /^(fix|stop|prevent|avoid|handle|repair|correct)\b/.test(t) || /\bbug\b/.test(t)) category = "fix";
  else if (c.files.length && c.files.every((f) => INFRA_FILE_RE.test(f) || TEST_OR_DOC_RE.test(f))) category = "infra";
  else category = "feature";
  const summary = c.title.replace(/\s*\(#\d+\)\s*$/, "").replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "");
  return { category, summary: summary.charAt(0).toUpperCase() + summary.slice(1), by: "heuristic" };
}

const SYSTEM = `You classify upstream open-source commits for a company that runs a fork.
For each commit return a category and a one-line summary of what it does for a user or operator.
Categories: feature (new user-visible capability), fix (bug fix), perf (performance), security (vulnerability, auth, secrets, access hardening), infra (CI, build, docs, tests, deps, refactor with no behaviour change), breaking (breaking API/config/behaviour/migration change that operators must act on).
If a commit is both a fix and security relevant, choose security. Prefer breaking only when an operator action or incompatibility is evident.
Summary: max 160 chars, plain English, no PR number, no hype.
Respond with JSON only: {"results":[{"sha":"<first 9 chars>","category":"...","summary":"..."}]}`;

export function buildPrompt(batch) {
  return batch
    .map((c) => {
      const files = c.files.slice(0, 25).join(", ") + (c.files.length > 25 ? ` ... (+${c.files.length - 25} more)` : "");
      return `sha: ${c.sha.slice(0, 9)}\ntitle: ${c.title}\nbody: ${(c.body || "").slice(0, 700)}\nfiles(${c.files.length}): ${files}`;
    })
    .join("\n---\n");
}

export function parseLlmResponse(text, batch) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in LLM response");
  const parsed = JSON.parse(m[0]);
  const bySha = new Map();
  for (const r of parsed.results || []) {
    if (!CATEGORIES.includes(r.category) || typeof r.summary !== "string" || !r.summary.trim()) continue;
    bySha.set(String(r.sha).slice(0, 9), { category: r.category, summary: r.summary.trim().slice(0, 240) });
  }
  return batch.map((c) => bySha.get(c.sha.slice(0, 9)) ?? null);
}

export async function llmClassifyBatch(cfg, batch, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.llm.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(batch) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return parseLlmResponse(json.choices?.[0]?.message?.content ?? "", batch);
}

const BATCH = 10;

// Classify every row with category IS NULL. Model failure per batch falls back to the heuristic.
export async function classifyPending(db, cfg, { fetchImpl = fetch, log = console.error } = {}) {
  const { rows } = await db.query(
    `SELECT upstream_sha AS sha, title, body, author, files FROM upstream_sync_log
     WHERE category IS NULL ORDER BY id`,
  );
  if (rows.length === 0) return { classified: 0, llm: 0, heuristic: 0 };
  const stats = { classified: 0, llm: 0, heuristic: 0 };
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

  const apply = async (c, r, by) => {
    await db.query(
      `UPDATE upstream_sync_log SET category=$2, summary=$3, classified_by=$4, classified_at=now(), updated_at=now()
       WHERE upstream_sha=$1 AND category IS NULL`,
      [c.sha, r.category, r.summary, by],
    );
    stats.classified++;
    stats[by.startsWith("llm") ? "llm" : "heuristic"]++;
  };

  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      let results = null;
      if (cfg.llm.apiKey) {
        try {
          results = await llmClassifyBatch(cfg, batch, fetchImpl);
        } catch (e) {
          log(`classifier: LLM batch failed (${e.message}); using heuristic for ${batch.length} rows`);
        }
      }
      if (results && results.some((r) => !r)) {
        const missing = batch.filter((_, i) => !results[i]);
        try {
          const retry = await llmClassifyBatch(cfg, missing, fetchImpl);
          let k = 0;
          results = results.map((r) => r ?? retry[k++]);
        } catch (e) {
          log(`classifier: LLM retry failed (${e.message})`);
        }
      }
      for (let i = 0; i < batch.length; i++) {
        const c = batch[i];
        if (results?.[i]) await apply(c, results[i], `llm:${cfg.llm.model}`);
        else {
          const h = heuristicClassify(c);
          await apply(c, h, "heuristic");
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.llm.concurrency, batches.length) }, worker));
  return stats;
}

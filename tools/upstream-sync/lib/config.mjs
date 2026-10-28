import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const INITIAL_MARKER = "898144f4b3025ecca5ce7907069e19660298bf7b"; // catch-up #191

// Positive-integer env setting. A non-numeric value would become NaN and, for a
// timeout, make `AbortSignal.timeout(NaN)` throw before any request is made; 0
// would abort every request immediately. Both are configuration mistakes, not
// "no limit", so fall back to the documented default and warn instead of failing
// the hourly run on a typo.
function parseIntEnv(env, name, fallback, { min, warn = console.warn }) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = String(raw).trim();
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min) {
    warn(`upstream-sync: ignoring invalid ${name}=${JSON.stringify(raw)} (want an integer >= ${min}); using ${fallback}`);
    return fallback;
  }
  return n;
}

export function loadConfig(env = process.env, warn = console.warn) {
  // Durations/concurrency: 0 is nonsensical (an immediately-aborted timeout, or
  // a worker pool that never makes progress), so require >= 1.
  const int = (name, d) => parseIntEnv(env, name, d, { min: 1, warn });
  // Thresholds and per-run caps: 0 is a meaningful "strictest" setting, so only
  // NaN/negatives are rejected.
  const count = (name, d) => parseIntEnv(env, name, d, { min: 0, warn });
  return {
    databaseUrl: env.UPSTREAM_SYNC_DATABASE_URL || env.DATABASE_URL || "",
    upstreamRepo: env.UPSTREAM_SYNC_UPSTREAM_REPO || "https://github.com/paperclipai/paperclip.git",
    upstreamBranch: env.UPSTREAM_SYNC_BRANCH || "master",
    mirrorDir: env.UPSTREAM_SYNC_MIRROR_DIR || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "upstream-sync", "mirror.git"),
    initialMarker: env.UPSTREAM_SYNC_INITIAL_MARKER || INITIAL_MARKER,
    forkOwnedFile: env.UPSTREAM_SYNC_FORK_OWNED_FILE || path.resolve(here, "../../../FORK_OWNED.md"),
    // Bound every outbound HTTP call (LLM + alert delivery). These run while the
    // advisory run lock is held, so a hung endpoint must not stall later runs.
    httpTimeoutMs: int("UPSTREAM_SYNC_HTTP_TIMEOUT_MS", 30000),
    // Bound the whole run, not just one call: classify + serial alert flush can
    // otherwise hold the advisory lock for tens of minutes. Work not started by
    // the deadline is deferred to the next run.
    runBudgetMs: int("UPSTREAM_SYNC_RUN_BUDGET_MS", 10 * 60 * 1000),
    llm: {
      baseUrl: (env.UPSTREAM_SYNC_LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: env.UPSTREAM_SYNC_LLM_MODEL || "gpt-4o-mini",
      apiKey: env.UPSTREAM_SYNC_LLM_API_KEY || env.OPENAI_API_KEY || "",
      concurrency: int("UPSTREAM_SYNC_LLM_CONCURRENCY", 4),
    },
    alert: {
      // One setting: where feature/breaking/security + ops alerts go.
      channel: env.UPSTREAM_SYNC_ALERT_CHANNEL || "#eng",
      // outbox: only record (an agent or `alerts pending` drains it)
      // paperclip-comment: comment on UPSTREAM_SYNC_ALERT_ISSUE_ID via the Paperclip API
      // slack-webhook: POST to UPSTREAM_SYNC_SLACK_WEBHOOK_URL
      // stdout: print (testing)
      sink: env.UPSTREAM_SYNC_ALERT_SINK || "outbox",
      issueId: env.UPSTREAM_SYNC_ALERT_ISSUE_ID || "",
      slackWebhookUrl: env.UPSTREAM_SYNC_SLACK_WEBHOOK_URL || "",
      paperclipApiUrl: env.PAPERCLIP_API_URL || "",
      paperclipApiKey: env.PAPERCLIP_API_KEY || "",
      paperclipRunId: env.PAPERCLIP_RUN_ID || "",
      maxPerRun: count("UPSTREAM_SYNC_ALERT_MAX_PER_RUN", 10),
    },
    ops: {
      queueDepthMax: count("UPSTREAM_SYNC_QUEUE_DEPTH_MAX", 40),
      oldestPendingHoursMax: count("UPSTREAM_SYNC_OLDEST_PENDING_HOURS_MAX", 48),
    },
  };
}

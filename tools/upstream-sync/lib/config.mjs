import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const INITIAL_MARKER = "898144f4b3025ecca5ce7907069e19660298bf7b"; // catch-up #191

export function loadConfig(env = process.env) {
  const int = (v, d) => (v === undefined || v === "" ? d : Number.parseInt(v, 10));
  return {
    databaseUrl: env.UPSTREAM_SYNC_DATABASE_URL || env.DATABASE_URL || "",
    upstreamRepo: env.UPSTREAM_SYNC_UPSTREAM_REPO || "https://github.com/paperclipai/paperclip.git",
    upstreamBranch: env.UPSTREAM_SYNC_BRANCH || "master",
    mirrorDir: env.UPSTREAM_SYNC_MIRROR_DIR || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "upstream-sync", "mirror.git"),
    initialMarker: env.UPSTREAM_SYNC_INITIAL_MARKER || INITIAL_MARKER,
    forkOwnedFile: env.UPSTREAM_SYNC_FORK_OWNED_FILE || path.resolve(here, "../../../FORK_OWNED.md"),
    llm: {
      baseUrl: (env.UPSTREAM_SYNC_LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: env.UPSTREAM_SYNC_LLM_MODEL || "gpt-4o-mini",
      apiKey: env.UPSTREAM_SYNC_LLM_API_KEY || env.OPENAI_API_KEY || "",
      concurrency: int(env.UPSTREAM_SYNC_LLM_CONCURRENCY, 4),
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
      maxPerRun: int(env.UPSTREAM_SYNC_ALERT_MAX_PER_RUN, 10),
    },
    ops: {
      queueDepthMax: int(env.UPSTREAM_SYNC_QUEUE_DEPTH_MAX, 40),
      oldestPendingHoursMax: int(env.UPSTREAM_SYNC_OLDEST_PENDING_HOURS_MAX, 48),
    },
  };
}

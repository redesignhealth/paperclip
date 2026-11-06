import path from "node:path";
import { Worker } from "node:worker_threads";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";

// Run-local metadata only. Never select prompts, message bodies, tool arguments,
// credentials, or the host's state.db. SQLite work stays off the server event loop.
const READER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { lstatSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
let previous = '';
let unavailable = false;
function sample() {
  let db;
  try {
    if (!lstatSync(workerData.file).isFile()) throw new Error('state unavailable');
    db = new DatabaseSync(workerData.file, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA busy_timeout = 25');
    const row = db.prepare(
      'SELECT COALESCE(SUM(message_count), 0) AS message_count, ' +
      'COALESCE(SUM(tool_call_count), 0) AS tool_call_count, ' +
      'COALESCE(SUM(api_call_count), 0) AS api_call_count FROM sessions'
    ).get();
    if (!row) return;
    const counts = [row.message_count, row.tool_call_count, row.api_call_count];
    if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('counts unavailable');
    const key = JSON.stringify(counts);
    if (unavailable || key !== previous) {
      unavailable = false; previous = key; parentPort.postMessage(counts);
    }
  } catch (error) {
    // A not-yet-created database is expected. Other read failures are distinct
    // from agent inactivity; report no raw SQL, paths, or database contents.
    if ((error.code !== 'ENOENT' || previous !== '') && !unavailable) {
      unavailable = true; parentPort.postMessage({ unavailable: true });
    }
  } finally { if (db) db.close(); }
}
sample();
setInterval(sample, workerData.intervalMs);
`;

/** Observe only a fresh isolated home; callers must stop before deleting that home. */
export function startHermesProgress(
  home: string,
  emit: (event: AdapterRuntimeEvent) => Promise<void>,
  options: { intervalMs?: number; stalledAfterMs?: number } = {},
): { stop: () => Promise<void> } {
  const startedAt = Date.now();
  let lastChangeAt = startedAt;
  let warned = false;
  let stopped = false;
  let failed = false;
  let samplingAvailable = true;
  let previousCounts = "";
  let pending = Promise.resolve();
  const send = (event: AdapterRuntimeEvent) => {
    pending = pending.then(async () => { if (!stopped) await emit(event); }).catch(() => {});
  };
  let worker: Worker;
  try {
    worker = new Worker(READER, {
      eval: true,
      workerData: { file: path.join(home, "state.db"), intervalMs: options.intervalMs ?? 5000 },
      // Do not inherit server credentials, preloads, or database warnings on stdio.
      env: {}, execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 16 },
    });
  } catch {
    send({ eventType: "hermes.progress_unavailable", stream: "system", level: "warn",
      message: "Detailed agent progress is unavailable; execution continues." });
    return { async stop() { stopped = true; } };
  }
  // Discard native SQLite warnings rather than buffering unread output.
  worker.stdout?.resume();
  worker.stderr?.resume();
  worker.on("message", (counts: unknown) => {
    if (stopped || failed) return;
    if (counts && typeof counts === "object" && "unavailable" in counts) {
      samplingAvailable = false;
      send({ eventType: "hermes.progress_unavailable", stream: "system", level: "warn",
        message: "Detailed agent progress is unavailable; execution continues." });
      return;
    }
    if (!Array.isArray(counts) || counts.length !== 3 ||
        !counts.every(n => Number.isSafeInteger(n) && n >= 0)) return;
    samplingAvailable = true;
    const key = JSON.stringify(counts);
    if (key === previousCounts) return; // Read recovery is not new agent work.
    previousCounts = key;
    lastChangeAt = Date.now();
    warned = false;
    const [messages, tools, modelCalls] = counts as number[];
    send({ eventType: "hermes.progress", stream: "system", level: "info",
      message: `Agent activity: ${modelCalls} completed model calls, ${tools} recorded tool calls, ${messages} messages.`,
      payload: { messages, tools, modelCalls, elapsedMs: lastChangeAt - startedAt } });
  });
  const workerFailed = () => {
    if (stopped || failed) return;
    failed = true;
    clearInterval(timer);
    send({ eventType: "hermes.progress_unavailable", stream: "system", level: "warn",
      message: "Detailed agent progress is unavailable; execution continues." });
  };
  worker.on("error", workerFailed);
  worker.on("exit", workerFailed);
  // A warning is not evidence of useful work and never cancels or retries the run.
  const stalledAfterMs = options.stalledAfterMs ?? 120_000;
  const timer = setInterval(() => {
    if (!failed && samplingAvailable && !warned && Date.now() - lastChangeAt >= stalledAfterMs) {
      warned = true;
      send({ eventType: "hermes.activity_stale", stream: "system", level: "warn",
        message: "No new recorded agent activity. The model or a tool may still be working.",
        payload: { inactiveMs: Date.now() - lastChangeAt } });
    }
  }, Math.min(stalledAfterMs, 5000));
  timer.unref();
  worker.unref();
  return { async stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await worker.terminate();
    // A slow diagnostic sink must not delay child settlement or home cleanup.
  } };
}

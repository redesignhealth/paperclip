import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHermesProgress } from "./runtime-progress.js";

const homes: string[] = [];
const monitors: ReturnType<typeof startHermesProgress>[] = [];
afterEach(async () => {
  await Promise.all(monitors.splice(0).map(m => m.stop()));
  await Promise.all(homes.splice(0).map(h => fs.rm(h, { recursive: true, force: true })));
});
async function home() {
  const h = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-progress-test-"));
  homes.push(h); return h;
}
function createDb(h: string) {
  const db = new DatabaseSync(path.join(h, "state.db"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL,
      message_count INTEGER, tool_call_count INTEGER, api_call_count INTEGER, system_prompt TEXT);
    INSERT INTO sessions VALUES ('main', NULL, 1, 2, 1, 1, 'PRIVATE_PROMPT_SECRET');
    INSERT INTO sessions VALUES ('child', 'main', 2, 900, 900, 900, 'CHILD_SECRET');`);
  return db;
}
describe("isolated Hermes progress through a real SQLite worker", () => {
  it("reports this run's sessions including continuations, sees WAL changes, and emits no content", async () => {
    const h = await home(); const db = createDb(h);
    const emit = vi.fn(async (_event: AdapterRuntimeEvent) => {});
    const monitor = startHermesProgress(h, emit, { intervalMs: 20 }); monitors.push(monitor);
    try {
      await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        eventType: "hermes.progress", payload: expect.objectContaining({ messages: 902, tools: 901, modelCalls: 901 }),
      })));
      db.exec("UPDATE sessions SET message_count=4, tool_call_count=2, api_call_count=2 WHERE id='main'");
      await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ messages: 904, tools: 902, modelCalls: 902 }),
      })));
      expect(JSON.stringify(emit.mock.calls)).not.toMatch(/SECRET|system_prompt|child|main/);
      await monitor.stop();
      const count = emit.mock.calls.length;
      db.exec("UPDATE sessions SET message_count=9 WHERE id='main'");
      await new Promise(r => setTimeout(r, 60));
      expect(emit).toHaveBeenCalledTimes(count);
    } finally { db.close(); }
  });
  it("waits for database creation without creating it, warns on silence, then recovers", async () => {
    const h = await home(); const emit = vi.fn(async (_event: AdapterRuntimeEvent) => {});
    const monitor = startHermesProgress(h, emit, { intervalMs: 20, stalledAfterMs: 40 }); monitors.push(monitor);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "hermes.activity_stale" })));
    await expect(fs.stat(path.join(h, "state.db"))).rejects.toThrow();
    const db = createDb(h);
    try { await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "hermes.progress" }))); }
    finally { db.close(); }
  });
  it("reports unreadable state separately from inactivity and recovers after repair", async () => {
    const h = await home();
    await fs.writeFile(path.join(h, "state.db"), "not a SQLite database");
    const emit = vi.fn(async (_event: AdapterRuntimeEvent) => {});
    const monitor = startHermesProgress(h, emit, { intervalMs: 20, stalledAfterMs: 40 }); monitors.push(monitor);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "hermes.progress_unavailable" })));
    emit.mockClear();
    await new Promise(r => setTimeout(r, 100));
    expect(emit.mock.calls.some(([event]) => event.eventType === "hermes.activity_stale")).toBe(false);
    await fs.unlink(path.join(h, "state.db"));
    const db = createDb(h);
    try { await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "hermes.progress" }))); }
    finally { db.close(); }
  });
  it("does not open a symlink to another home's database", async () => {
    const other = await home(); const db = createDb(other); db.close();
    const h = await home(); await fs.symlink(path.join(other, "state.db"), path.join(h, "state.db"));
    const emit = vi.fn(async (_event: AdapterRuntimeEvent) => {});
    const monitor = startHermesProgress(h, emit, { intervalMs: 20, stalledAfterMs: 40 }); monitors.push(monitor);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "hermes.progress_unavailable" })));
    expect(emit.mock.calls.some(([event]) => event.eventType === "hermes.progress")).toBe(false);
  });
  it("stops despite a diagnostic sink that never completes", async () => {
    const h = await home(); const db = createDb(h); db.close();
    const emit = vi.fn((_event: AdapterRuntimeEvent) => new Promise<void>(() => {}));
    const monitor = startHermesProgress(h, emit, { intervalMs: 20 }); monitors.push(monitor);
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    await monitor.stop();
  });
});

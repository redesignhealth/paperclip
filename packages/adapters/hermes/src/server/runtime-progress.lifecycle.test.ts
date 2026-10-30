import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";

const fixture = vi.hoisted(() => ({
  failConstructor: false,
  listeners: new Map<string, (...args: unknown[]) => void>(),
  terminate: vi.fn(async () => 0),
  resume: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({
  Worker: class {
    stdout = { resume: fixture.resume };
    stderr = { resume: fixture.resume };
    constructor() { if (fixture.failConstructor) throw new Error("PRIVATE_ERROR"); }
    on(event: string, callback: (...args: unknown[]) => void) { fixture.listeners.set(event, callback); return this; }
    unref() {}
    terminate = fixture.terminate;
  },
}));
import { startHermesProgress } from "./runtime-progress.js";

afterEach(() => { vi.useRealTimers(); fixture.failConstructor = false; fixture.listeners.clear(); vi.clearAllMocks(); });
describe("progress monitor failure lifecycle", () => {
  it("degrades safely when worker construction fails", async () => {
    vi.useFakeTimers(); fixture.failConstructor = true;
    const emit = vi.fn(async (_event: AdapterRuntimeEvent) => {});
    const monitor = startHermesProgress("/isolated", emit);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0].eventType).toBe("hermes.progress_unavailable");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE_ERROR");
    await monitor.stop();
  });
  it("does not count identical counters after read recovery as new agent activity", async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async (_event: AdapterRuntimeEvent) => {});
    const monitor = startHermesProgress("/isolated", emit);
    try {
      fixture.listeners.get("message")!([1, 2, 3]);
      await vi.advanceTimersByTimeAsync(100_000);
      fixture.listeners.get("message")!({ unavailable: true });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(emit.mock.calls.filter(([event]) => event.eventType === "hermes.activity_stale")).toHaveLength(0);
      fixture.listeners.get("message")!([1, 2, 3]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(emit.mock.calls.filter(([event]) => event.eventType === "hermes.progress")).toHaveLength(1);
      expect(emit.mock.calls.filter(([event]) => event.eventType === "hermes.activity_stale")).toHaveLength(1);
    } finally { await monitor.stop(); }
  });
  it.each(["error", "exit"])("does not label a dead monitor as an inactive agent after %s", async (event) => {
    vi.useFakeTimers();
    const emit = vi.fn(async (_event: AdapterRuntimeEvent) => {});
    const monitor = startHermesProgress("/isolated", emit);
    try {
      fixture.listeners.get(event)!(new Error("PRIVATE_ERROR"));
      fixture.listeners.get("exit")!(1);
      fixture.listeners.get("message")!([1, 2, 3]);
      await vi.advanceTimersByTimeAsync(125_000);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0][0].eventType).toBe("hermes.progress_unavailable");
      expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE_ERROR");
      expect(fixture.resume).toHaveBeenCalledTimes(2);
    } finally { await monitor.stop(); }
    expect(fixture.terminate).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEmfRecord, RUNTIME_METRICS_NAMESPACE, startRuntimeMetrics } from "./runtime-metrics.js";

describe("runtime metrics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds an EMF record whose metric names match their values", () => {
    const record = buildEmfRecord("paperclip-prod", {
      eventLoopUtilizationPercent: 91.5,
      eventLoopDelayP99Ms: 120,
      eventLoopDelayMaxMs: 300,
      sandboxSlotsWaiting: 4,
      sandboxSlotWaitMaxSeconds: 42,
    }, 1700000000000);
    const directive = record._aws.CloudWatchMetrics[0];
    expect(directive.Namespace).toBe(RUNTIME_METRICS_NAMESPACE);
    expect(directive.Dimensions).toEqual([["Service"]]);
    for (const metric of directive.Metrics) expect(record).toHaveProperty(metric.Name);
    expect(record).toMatchObject({
      Service: "paperclip-prod",
      EventLoopUtilization: 91.5,
      EventLoopDelayP99: 120,
      SandboxSlotsWaiting: 4,
      SandboxSlotWaitMax: 42,
    });
  });

  it("emits one JSON line per interval and takes the longer of the live and admitted waits", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const stop = startRuntimeMetrics({
      service: "paperclip-test",
      intervalMs: 1000,
      now: () => 5,
      write: (line) => lines.push(line),
      slotMetrics: () => ({ waiting: 2, oldestWaitMs: 5_000, admittedWaitMaxMs: 90_000 }),
    });
    vi.advanceTimersByTime(2100);
    stop();
    vi.advanceTimersByTime(5000);
    expect(lines).toHaveLength(2);
    const record = JSON.parse(lines[0]);
    expect(record.Service).toBe("paperclip-test");
    expect(record.SandboxSlotsWaiting).toBe(2);
    expect(record.SandboxSlotWaitMax).toBe(90);
    expect(record.EventLoopUtilization).toBeGreaterThanOrEqual(0);
    expect(record.EventLoopUtilization).toBeLessThanOrEqual(100);
  });

  it("does not throw when the slot gate fails", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const stop = startRuntimeMetrics({
      service: "x",
      intervalMs: 1000,
      write: (line) => lines.push(line),
      slotMetrics: () => { throw new Error("boom"); },
    });
    expect(() => vi.advanceTimersByTime(1100)).not.toThrow();
    stop();
    expect(lines).toHaveLength(0);
  });
});

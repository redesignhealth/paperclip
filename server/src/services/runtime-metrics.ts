import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

/**
 * Server runtime metrics in CloudWatch Embedded Metric Format (TECH-9857).
 *
 * The server's single main thread is the limit on concurrent sandbox runs (it
 * saturated at about 20 runs per task in the 2026-11-18 retest), and the ECS
 * CPU metric cannot see it: one saturated core is about 6% of a 16 vCPU task.
 * So the server reports its own event-loop load and sandbox-slot queue
 * pressure once a minute as one JSON line on stdout. The ECS awslogs driver
 * ships that line to CloudWatch Logs, which turns it into custom metrics with
 * no agent or SDK call.
 *
 * Off unless PAPERCLIP_METRICS_SERVICE is set (the ECS module sets it to the
 * service name, which becomes the `Service` dimension, so dev and prod stay
 * apart).
 */

export const RUNTIME_METRICS_NAMESPACE = "Paperclip/Server";
export const RUNTIME_METRICS_SERVICE_ENV = "PAPERCLIP_METRICS_SERVICE";
export const RUNTIME_METRICS_INTERVAL_MS = 60_000;

export interface SandboxSlotMetrics {
  waiting: number;
  oldestWaitMs: number;
  admittedWaitMaxMs: number;
}

export interface RuntimeMetricSample {
  /** Share of the interval the event loop was busy, 0 to 100. */
  eventLoopUtilizationPercent: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs: number;
  sandboxSlotsWaiting: number;
  /** Longest a run has waited, or waited before it started, in the interval. */
  sandboxSlotWaitMaxSeconds: number;
}

/** One EMF record. The metric names here are what the rh-paperclip alarms use. */
export function buildEmfRecord(service: string, sample: RuntimeMetricSample, timestampMs: number) {
  return {
    _aws: {
      Timestamp: timestampMs,
      CloudWatchMetrics: [
        {
          Namespace: RUNTIME_METRICS_NAMESPACE,
          Dimensions: [["Service"]],
          Metrics: [
            { Name: "EventLoopUtilization", Unit: "Percent" },
            { Name: "EventLoopDelayP99", Unit: "Milliseconds" },
            { Name: "EventLoopDelayMax", Unit: "Milliseconds" },
            { Name: "SandboxSlotsWaiting", Unit: "Count" },
            { Name: "SandboxSlotWaitMax", Unit: "Seconds" },
          ],
        },
      ],
    },
    Service: service,
    EventLoopUtilization: sample.eventLoopUtilizationPercent,
    EventLoopDelayP99: sample.eventLoopDelayP99Ms,
    EventLoopDelayMax: sample.eventLoopDelayMaxMs,
    SandboxSlotsWaiting: sample.sandboxSlotsWaiting,
    SandboxSlotWaitMax: sample.sandboxSlotWaitMaxSeconds,
  };
}

const round = (value: number, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export interface RuntimeMetricsOptions {
  service: string;
  slotMetrics: () => SandboxSlotMetrics;
  write?: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
}

/** Starts the sampler. The returned function stops it. */
export function startRuntimeMetrics(options: RuntimeMetricsOptions): () => void {
  const write = options.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const now = options.now ?? Date.now;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastElu: EventLoopUtilization = performance.eventLoopUtilization();

  const emit = () => {
    try {
      const elu = performance.eventLoopUtilization(lastElu);
      lastElu = performance.eventLoopUtilization();
      // The histogram reports nanoseconds. It is NaN-free but empty at 0 until the first tick.
      const p99Ms = histogram.percentile(99) / 1e6;
      const maxMs = histogram.max / 1e6;
      histogram.reset();
      const slots = options.slotMetrics();
      const sample: RuntimeMetricSample = {
        eventLoopUtilizationPercent: round(elu.utilization * 100),
        eventLoopDelayP99Ms: round(p99Ms),
        eventLoopDelayMaxMs: round(maxMs),
        sandboxSlotsWaiting: slots.waiting,
        sandboxSlotWaitMaxSeconds: round(Math.max(slots.oldestWaitMs, slots.admittedWaitMaxMs) / 1000),
      };
      write(JSON.stringify(buildEmfRecord(options.service, sample, now())));
    } catch {
      // Metrics must never take the server down.
    }
  };

  const timer = setInterval(emit, options.intervalMs ?? RUNTIME_METRICS_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}

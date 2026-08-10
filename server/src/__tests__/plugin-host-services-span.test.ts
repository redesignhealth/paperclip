import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import type { WorkerHostCallContext } from "../../../packages/plugins/sdk/src/protocol.js";
import { SANDBOX_STARTUP_SPAN_ATTRS as A } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import {
  buildHostServices,
  clampProviderSpanAttributes,
  parseTraceparent,
} from "../services/plugin-host-services.js";
import { logger } from "../middleware/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Capture every span the host trust boundary hands to the real tracer.
const mockRecordSpan = vi.hoisted(() => vi.fn());

vi.mock("../instrumentation.js", () => ({
  recordProviderPluginSpan: mockRecordSpan,
  traceparentFromContextToken: () => undefined,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function child() {
      return this;
    }),
  },
}));

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn() };
    },
  } as never;
}

// A well-formed W3C traceparent (the host mints it; the handler validates it).
const VALID_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

function servicesFor() {
  return buildHostServices({} as never, "plugin-record-id", "daytona", createEventBusStub());
}

function handlersFor(capabilities: readonly string[]) {
  return createHostClientHandlers({
    pluginId: "daytona",
    capabilities: capabilities as never,
    services: servicesFor(),
  });
}

describe("plugin provider span host handler", () => {
  beforeEach(() => {
    mockRecordSpan.mockReset();
  });

  it("records a span with the clamped name and the allowlisted attributes", async () => {
    const services = servicesFor();
    await services.tracer.record(
      {
        name: "pack",
        attributes: {
          [A.provider]: "daytona",
          [A.packWallMs]: 12,
        },
      },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );

    expect(mockRecordSpan).toHaveBeenCalledTimes(1);
    const call = mockRecordSpan.mock.calls[0]![0] as {
      name: string;
      parent: { traceId: string; spanId: string; traceFlags: number };
      attributes: Record<string, unknown>;
    };
    expect(call.name).toBe("sandbox.daytona.pack");
    expect(call.parent).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    });
    expect(call.attributes[A.provider]).toBe("daytona");
    expect(call.attributes[A.packWallMs]).toBe(12);
  });

  it("drops every forbidden attribute before the span reaches the tracer", async () => {
    const services = servicesFor();
    await services.tracer.record(
      {
        name: "transfer",
        attributes: {
          [A.transferGuardCount]: 2,
          // Forbidden fields that must never ride a span.
          [A.execCommand]: "bash",
          command: "rm -rf /",
          args: "--force",
          stdout: "secret output",
          stderr: "secret error",
          path: "/etc/passwd",
          extra: "leak",
        },
      },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );

    expect(mockRecordSpan).toHaveBeenCalledTimes(1);
    const attributes = (mockRecordSpan.mock.calls[0]![0] as { attributes: Record<string, unknown> })
      .attributes;
    // Only the allowlisted key survives; every forbidden key is dropped.
    expect(attributes).toEqual({ [A.transferGuardCount]: 2 });
    for (const forbidden of [A.execCommand, "command", "args", "stdout", "stderr", "path", "extra"]) {
      expect(attributes).not.toHaveProperty(forbidden);
    }
  });

  it("drops a status message (it could carry standard-stream text)", async () => {
    const services = servicesFor();
    await services.tracer.record(
      { name: "transfer", status: { code: 2, message: "secret error text" } },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    const call = mockRecordSpan.mock.calls[0]![0] as { status?: { code: number; message?: string } };
    expect(call.status).toEqual({ code: 2 });
    expect(call.status).not.toHaveProperty("message");
  });

  it("clamps an unknown span name to sandbox.daytona.other", async () => {
    const services = servicesFor();
    await services.tracer.record(
      { name: "rm -rf / --no-preserve-root" },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    expect((mockRecordSpan.mock.calls[0]![0] as { name: string }).name).toBe(
      "sandbox.daytona.other",
    );
  });

  it("admits each per-round-trip span name to sandbox.daytona.<name>", async () => {
    const services = servicesFor();
    for (const name of [
      "ensureDirectory",
      "checkSymlinkEscape",
      "promote",
      "extractTarball",
      "postUploadCommand",
    ]) {
      await services.tracer.record(
        { name },
        { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
      );
    }
    const recorded = mockRecordSpan.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(recorded).toEqual([
      "sandbox.daytona.ensureDirectory",
      "sandbox.daytona.checkSymlinkEscape",
      "sandbox.daytona.promote",
      "sandbox.daytona.extractTarball",
      "sandbox.daytona.postUploadCommand",
    ]);
  });

  it("admits the session open and close span names", async () => {
    const services = servicesFor();
    for (const name of ["session.open", "session.close"]) {
      await services.tracer.record(
        { name },
        { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
      );
    }
    const recorded = mockRecordSpan.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(recorded).toEqual([
      "sandbox.daytona.session.open",
      "sandbox.daytona.session.close",
    ]);
  });

  it("forwards a valid start-time and end-time pair to the recorder", async () => {
    const services = servicesFor();
    const startTimeMs = Date.now() - 4500;
    const endTimeMs = startTimeMs + 4500;
    await services.tracer.record(
      { name: "ensureDirectory", startTimeMs, endTimeMs },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    const call = mockRecordSpan.mock.calls[0]![0] as {
      startTimeMs?: number;
      endTimeMs?: number;
    };
    expect(call.startTimeMs).toBe(startTimeMs);
    expect(call.endTimeMs).toBe(endTimeMs);
  });

  it("accepts a pair whose end is a small skew ahead of the host clock", async () => {
    const services = servicesFor();
    // The worker clock leads the host clock by a few seconds. This small skew
    // is within the allowed bound, so the host keeps the native width.
    const startTimeMs = Date.now() + 5000;
    const endTimeMs = startTimeMs + 1000;
    await services.tracer.record(
      { name: "ensureDirectory", startTimeMs, endTimeMs },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    const call = mockRecordSpan.mock.calls[0]![0] as {
      startTimeMs?: number;
      endTimeMs?: number;
    };
    expect(call.startTimeMs).toBe(startTimeMs);
    expect(call.endTimeMs).toBe(endTimeMs);
  });

  it("drops an invalid timestamp pair so the synchronous path runs", async () => {
    const services = servicesFor();
    const now = Date.now();
    const invalidPairs: Array<{ startTimeMs?: unknown; endTimeMs?: unknown; why: string }> = [
      { startTimeMs: now, endTimeMs: now - 1000, why: "reversed order" },
      { startTimeMs: Number.NaN, endTimeMs: now, why: "non-finite start" },
      { startTimeMs: now, endTimeMs: Number.POSITIVE_INFINITY, why: "non-finite end" },
      { startTimeMs: now, endTimeMs: now + 11 * 60 * 1000, why: "over-ceiling duration" },
      { startTimeMs: now - 2 * 60 * 60 * 1000, endTimeMs: now - 2 * 60 * 60 * 1000 + 10, why: "over-age start" },
      { startTimeMs: now, endTimeMs: now + 2 * 60 * 1000, why: "end far in the future" },
      { startTimeMs: now + 5 * 60 * 1000, endTimeMs: now + 5 * 60 * 1000 + 10, why: "start and end in the future" },
    ];
    for (const pair of invalidPairs) {
      mockRecordSpan.mockReset();
      await services.tracer.record(
        { name: "ensureDirectory", startTimeMs: pair.startTimeMs, endTimeMs: pair.endTimeMs } as never,
        { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
      );
      // The span still records (the synchronous path), but without a timestamp.
      const call = mockRecordSpan.mock.calls[0]![0] as {
        startTimeMs?: number;
        endTimeMs?: number;
      };
      expect(call.startTimeMs, pair.why).toBeUndefined();
      expect(call.endTimeMs, pair.why).toBeUndefined();
    }
  });

  it("records the synchronous path when the timestamp pair is absent", async () => {
    const services = servicesFor();
    await services.tracer.record(
      { name: "pack" },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    const call = mockRecordSpan.mock.calls[0]![0] as {
      startTimeMs?: number;
      endTimeMs?: number;
    };
    expect(call.startTimeMs).toBeUndefined();
    expect(call.endTimeMs).toBeUndefined();
  });

  it("rejects a malformed traceparent — no span is recorded", async () => {
    const services = servicesFor();
    for (const bad of [
      undefined,
      "not-a-traceparent",
      "00-xyz-b7ad6b7169203331-01",
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331", // missing flags
      "00-00000000000000000000000000000000-b7ad6b7169203331-01", // all-zero trace id
    ]) {
      await services.tracer.record(
        { name: "pack" },
        { traceparent: bad } as WorkerHostCallContext,
      );
    }
    expect(mockRecordSpan).not.toHaveBeenCalled();
  });

  it("rejects a span from a plugin that lacks the environment-driver capability", async () => {
    const handlers = handlersFor([]);
    await expect(
      handlers["span.record"](
        { name: "pack" },
        { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
      ),
    ).rejects.toThrow(/capabilit/i);
    expect(mockRecordSpan).not.toHaveBeenCalled();
  });

  it("admits a span from a plugin that holds the environment-driver capability", async () => {
    const handlers = handlersFor(["environment.drivers.register"]);
    await handlers["span.record"](
      { name: "pack", attributes: { [A.provider]: "daytona" } },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    expect(mockRecordSpan).toHaveBeenCalledTimes(1);
  });
});

describe("parseTraceparent", () => {
  it("accepts a well-formed traceparent and returns the parts", () => {
    expect(parseTraceparent(VALID_TRACEPARENT)).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    });
  });

  it("rejects malformed, all-zero, and forbidden-version traceparents", () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01")).toBeNull();
    expect(parseTraceparent("ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBeNull();
  });
});

describe("clampProviderSpanAttributes", () => {
  beforeEach(() => {
    vi.mocked(logger.debug).mockReset();
  });

  it("keeps only allowlisted keys and normalizes the provider family", () => {
    expect(
      clampProviderSpanAttributes({
        [A.provider]: "some-operator-key",
        [A.packWallMs]: 7,
        [A.transferWallMs]: Number.NaN,
        [A.execCommand]: "bash",
      }),
    ).toEqual({
      // An unknown provider key maps to `plugin`, never the raw key.
      [A.provider]: "plugin",
      [A.packWallMs]: 7,
      // A non-finite number yields no attribute; `exec.command` is not allowed.
    });
  });

  it("logs at debug (not warn/error) when dropping an unknown attribute key", () => {
    clampProviderSpanAttributes({ [A.execCommand]: "bash" });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      { key: A.execCommand },
      expect.stringContaining("dropped unknown attribute key"),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs at debug (not warn/error) when dropping an attribute with an invalid outcome value", () => {
    clampProviderSpanAttributes({ [A.outcome]: "not-a-known-outcome" });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      { key: A.outcome },
      expect.stringContaining("dropped attribute with invalid outcome value"),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs at debug (not warn/error) when dropping an attribute with a non-finite numeric value", () => {
    clampProviderSpanAttributes({ [A.packWallMs]: Number.NaN });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      { key: A.packWallMs },
      expect.stringContaining("dropped attribute with non-finite numeric value"),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("truncates an over-long attribute key before logging it", () => {
    const longKey = "x".repeat(150);
    clampProviderSpanAttributes({ [longKey]: "anything" });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const loggedKey = (logger.debug as ReturnType<typeof vi.fn>).mock.calls[0]![0].key as string;
    expect(loggedKey.length).toBeLessThan(longKey.length);
    expect(loggedKey).toBe(`${"x".repeat(100)}...(truncated)`);
    expect(loggedKey).not.toBe(longKey);
  });

  it("passes through the daytona provider's own pack.wall_ms key", () => {
    // The daytona plugin (packages/plugins/sandbox-providers/daytona/src/file-sync.ts)
    // ships bundled and independently emits the literal
    // `paperclip.sandbox.startup.pack.wall_ms` key as its own provider-side
    // pack-timing measurement. This is a distinct key from `A.packWallMs`
    // (`pack.host_wall_ms`), which is the host-local tar-build wall time. Both
    // must survive the allowlist; regression coverage for a prior incident
    // where the allowlist only carried the host key and silently dropped this
    // one, deleting daytona pack timing from every trace.
    expect(
      clampProviderSpanAttributes({
        "paperclip.sandbox.startup.pack.wall_ms": 42,
      }),
    ).toEqual({
      "paperclip.sandbox.startup.pack.wall_ms": 42,
    });
  });
});

describe("daytona pack-timing literal stays in sync across the package boundary", () => {
  // `packages/plugins/sandbox-providers/**` is intentionally excluded from the
  // pnpm workspace (see the root pnpm-workspace.yaml) so the daytona plugin's
  // third-party deps (e.g. `@daytonaio/sdk`) never leak into the server's
  // install graph. That means the server can't cleanly `import` the plugin's
  // `SPAN_ATTR.packWallMs` constant — importing `file-sync.ts` at runtime would
  // drag in `plugin.ts`'s real (non-type-only) `@daytonaio/sdk` import, which
  // isn't resolvable from the server package.
  //
  // Both sides hand-maintain the same literal instead
  // (`PROVIDER_PACK_WALL_MS_ATTR` here, `SPAN_ATTR.packWallMs` in the plugin).
  // This is a text-based drift detector, not a real import: it greps the
  // sibling package's source for the exact literal so a rename on either side
  // fails CI instead of silently dropping daytona's pack-timing attribute from
  // the allowlist again (the incident `PROVIDER_PACK_WALL_MS_ATTR` was added to
  // fix).
  it("finds the literal `paperclip.sandbox.startup.pack.wall_ms` verbatim in the daytona plugin's file-sync.ts", () => {
    const daytonaFileSyncPath = path.resolve(
      __dirname,
      "../../../packages/plugins/sandbox-providers/daytona/src/file-sync.ts",
    );
    const source = readFileSync(daytonaFileSyncPath, "utf8");
    // The plugin builds the key from a shared prefix constant plus a per-key
    // suffix (`` `${SPAN_ATTR_PREFIX}pack.wall_ms` ``) rather than spelling the
    // full string out, so a plain substring search on the raw source text would
    // miss it. Reconstruct the value from both pieces and compare.
    const prefixMatch = source.match(/const SPAN_ATTR_PREFIX = "([^"]+)"/);
    const suffixMatch = source.match(/packWallMs:\s*`\$\{SPAN_ATTR_PREFIX\}([^`]+)`/);
    expect(prefixMatch, "expected to find the daytona plugin's SPAN_ATTR_PREFIX declaration").not.toBeNull();
    expect(
      suffixMatch,
      "expected to find the daytona plugin's packWallMs key built from SPAN_ATTR_PREFIX",
    ).not.toBeNull();
    const reconstructed = `${prefixMatch![1]}${suffixMatch![1]}`;
    expect(reconstructed).toBe("paperclip.sandbox.startup.pack.wall_ms");
  });
});

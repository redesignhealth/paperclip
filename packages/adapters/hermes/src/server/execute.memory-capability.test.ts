import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HERMES_PRODUCTION_CLOSURE_SENTINEL,
  checkHermesMemoryCapability,
  resetHermesMemoryCapabilityCacheForTests,
  resolveRunMemoryProbeTimeoutMs,
  DEFAULT_MEMORY_PROBE_TIMEOUT_MS,
} from "./execute.js";

/**
 * TECH-7346: the memory preflight probe used to run a fresh Python import check before EVERY
 * run with a hard 5 s budget, and a timeout failed the run. On a 1 vCPU task under load that
 * was ~28% of runs. The run path now (a) caches one successful probe per container, (b) retries
 * a timeout once, (c) with the hash-pinned production closure present proceeds on a persistent
 * timeout with a warning. Direct callers without these options keep the old semantics.
 */

let fixtureDirs: string[] = [];

function makeOptHermes(
  pythonBody: string,
  sentinel: "file" | "unreadable" | "none" = "file",
): { opt: string; counter: string } {
  const opt = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-cap-"));
  fixtureDirs.push(opt);
  if (sentinel === "file") {
    writeFileSync(path.join(opt, HERMES_PRODUCTION_CLOSURE_SENTINEL), "test-digest");
  } else if (sentinel === "unreadable") {
    // exists (existsSync is true) but readFile fails with EISDIR: no cache identity
    mkdirSync(path.join(opt, HERMES_PRODUCTION_CLOSURE_SENTINEL));
  }
  mkdirSync(path.join(opt, "bin"), { recursive: true });
  const counter = path.join(opt, "calls");
  writeFileSync(counter, "0");
  const bin = path.join(opt, "bin", "python3");
  // Every invocation increments the counter file before running the body.
  writeFileSync(
    bin,
    `#!/bin/sh\nn=$(cat "${counter}"); n=$((n+1)); echo "$n" > "${counter}"\n${pythonBody}\n`,
  );
  chmodSync(bin, 0o755);
  return { opt, counter };
}

const calls = (counter: string) => Number(readFileSync(counter, "utf8").trim());
const OK = `echo '{"r":"ok"}'\nexit 0`;
const SLOW_OK = `sleep 1.5\necho '{"r":"ok"}'\nexit 0`;
// Slow on the first call only, fast afterwards.
const SLOW_THEN_OK = `if [ "$n" = "1" ]; then sleep 1.5; fi\necho '{"r":"ok"}'\nexit 0`;
const MISSING = `echo '{"r":"missing","module":"mem0","transitive":false}'\nexit 0`;

beforeEach(() => resetHermesMemoryCapabilityCacheForTests());
afterEach(() => {
  resetHermesMemoryCapabilityCacheForTests();
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checkHermesMemoryCapability: success cache (TECH-7346)", () => {
  it("probes once per interpreter+sentinel when cacheSuccess is on", async () => {
    const { opt, counter } = makeOptHermes(OK);
    const first = await checkHermesMemoryCapability(opt, { cacheSuccess: true });
    const second = await checkHermesMemoryCapability(opt, { cacheSuccess: true });
    expect(first.available).toBe(true);
    expect(first.cached).toBeUndefined();
    expect(second.available).toBe(true);
    expect(second.cached).toBe(true);
    expect(second.probeResult?.ok).toBe(true);
    expect(calls(counter)).toBe(1);
  });

  it("without cacheSuccess every call probes (direct-caller semantics unchanged)", async () => {
    const { opt, counter } = makeOptHermes(OK);
    await checkHermesMemoryCapability(opt);
    await checkHermesMemoryCapability(opt);
    expect(calls(counter)).toBe(2);
  });

  it("concurrent cold-start callers share one in-flight probe", async () => {
    const { opt, counter } = makeOptHermes(SLOW_THEN_OK);
    const [a, b, c] = await Promise.all([
      checkHermesMemoryCapability(opt, { cacheSuccess: true, timeoutMs: 400, timeoutRetries: 1 }),
      checkHermesMemoryCapability(opt, { cacheSuccess: true, timeoutMs: 400, timeoutRetries: 1 }),
      checkHermesMemoryCapability(opt, { cacheSuccess: true, timeoutMs: 400, timeoutRetries: 1 }),
    ]);
    for (const r of [a, b, c]) {
      expect(r.available).toBe(true);
      expect(r.probeResult?.ok).toBe(true);
    }
    // one leader probed (slow attempt + fast retry); the joiners spawned nothing
    expect(calls(counter)).toBe(2);
    const after = await checkHermesMemoryCapability(opt, { cacheSuccess: true });
    expect(after.cached).toBe(true);
    expect(calls(counter)).toBe(2);
  });

  it("an unreadable sentinel disables the cache (every call probes) without failing the check", async () => {
    const { opt, counter } = makeOptHermes(OK, "unreadable");
    const a = await checkHermesMemoryCapability(opt, { cacheSuccess: true });
    const b = await checkHermesMemoryCapability(opt, { cacheSuccess: true });
    expect(a.available).toBe(true);
    expect(b.available).toBe(true);
    expect(b.cached).toBeUndefined();
    expect(calls(counter)).toBe(2);
  });

  it("never caches a failure: a missing module is re-probed and still unavailable", async () => {
    const { opt, counter } = makeOptHermes(MISSING);
    const a = await checkHermesMemoryCapability(opt, { cacheSuccess: true, timeoutRetries: 1, timeoutFailOpen: true });
    const b = await checkHermesMemoryCapability(opt, { cacheSuccess: true, timeoutRetries: 1, timeoutFailOpen: true });
    expect(a.available).toBe(false);
    expect(a.probeResult?.reason).toBe("missing_module");
    expect(b.available).toBe(false);
    expect(calls(counter)).toBe(2);
  });
});

describe("checkHermesMemoryCapability: timeout retry and sentinel fail-open (TECH-7346)", () => {
  it("retries a timeout once and succeeds when the second probe is fast", async () => {
    const { opt, counter } = makeOptHermes(SLOW_THEN_OK);
    const res = await checkHermesMemoryCapability(opt, { timeoutMs: 400, timeoutRetries: 1, cacheSuccess: true });
    expect(res.available).toBe(true);
    expect(res.probeResult?.ok).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(calls(counter)).toBe(2);
    // the retry's success is cached like any success
    const again = await checkHermesMemoryCapability(opt, { timeoutMs: 400, timeoutRetries: 1, cacheSuccess: true });
    expect(again.cached).toBe(true);
    expect(calls(counter)).toBe(2);
  });

  it("without timeoutRetries a single timeout is still a failure", async () => {
    const { opt, counter } = makeOptHermes(SLOW_THEN_OK);
    const res = await checkHermesMemoryCapability(opt, { timeoutMs: 400 });
    expect(res.available).toBe(false);
    expect(res.probeResult?.reason).toBe("timeout");
    expect(calls(counter)).toBe(1);
  });

  it("a persistent timeout with the production sentinel present proceeds with a warning, and is not cached", async () => {
    const { opt, counter } = makeOptHermes(SLOW_OK);
    const res = await checkHermesMemoryCapability(opt, { timeoutMs: 400, timeoutRetries: 1, timeoutFailOpen: true, cacheSuccess: true });
    expect(res.available).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.probeResult?.reason).toBe("timeout");
    expect(res.warning).toContain("timed out 2 time(s) at 400ms");
    expect(res.warning).toContain("CPU starvation");
    expect(calls(counter)).toBe(2);
    const again = await checkHermesMemoryCapability(opt, { timeoutMs: 400, timeoutRetries: 1, timeoutFailOpen: true, cacheSuccess: true });
    expect(again.cached).toBeUndefined();
    expect(calls(counter)).toBe(4);
  });

  it("a persistent timeout without timeoutFailOpen stays a failure (existing contract)", async () => {
    const { opt } = makeOptHermes(SLOW_OK);
    const res = await checkHermesMemoryCapability(opt, { timeoutMs: 400, timeoutRetries: 1 });
    expect(res.available).toBe(false);
    expect(res.probeResult?.reason).toBe("timeout");
    expect(res.error).toContain("timed out after 400ms");
  });
});

describe("checkHermesMemoryCapability: unmarked environment (no sentinel)", () => {
  it("timeoutRetries applies, but cacheSuccess and timeoutFailOpen are sentinel-only", async () => {
    const { opt, counter } = makeOptHermes(SLOW_THEN_OK, "none");
    const retried = await checkHermesMemoryCapability(opt, { timeoutMs: 400, timeoutRetries: 1, cacheSuccess: true });
    expect(retried.available).toBe(true);
    expect(retried.attempts).toBe(2);
    expect(calls(counter)).toBe(2);
    // cacheSuccess is a no-op here: the next call probes again
    const again = await checkHermesMemoryCapability(opt, { timeoutMs: 400, timeoutRetries: 1, cacheSuccess: true });
    expect(again.cached).toBeUndefined();
    expect(calls(counter)).toBe(3);
    // and a persistent timeout is still a failure even with timeoutFailOpen
    const slow = makeOptHermes(SLOW_OK, "none");
    const res = await checkHermesMemoryCapability(slow.opt, { timeoutMs: 400, timeoutRetries: 1, timeoutFailOpen: true });
    expect(res.available).toBe(false);
    expect(res.probeResult?.reason).toBe("timeout");
    expect(calls(slow.counter)).toBe(2);
  });
});

describe("resolveRunMemoryProbeTimeoutMs", () => {
  const T = { NODE_ENV: "test" } as const;
  it("under NODE_ENV=test the env var may shorten the 5 s budget, never extend it", () => {
    expect(resolveRunMemoryProbeTimeoutMs({ ...T })).toBe(DEFAULT_MEMORY_PROBE_TIMEOUT_MS);
    expect(resolveRunMemoryProbeTimeoutMs({ ...T, PAPERCLIP_HERMES_MEMORY_PROBE_TIMEOUT_MS: "250" })).toBe(250);
    expect(resolveRunMemoryProbeTimeoutMs({ ...T, PAPERCLIP_HERMES_MEMORY_PROBE_TIMEOUT_MS: "60000" })).toBe(DEFAULT_MEMORY_PROBE_TIMEOUT_MS);
    expect(resolveRunMemoryProbeTimeoutMs({ ...T, PAPERCLIP_HERMES_MEMORY_PROBE_TIMEOUT_MS: "0" })).toBe(DEFAULT_MEMORY_PROBE_TIMEOUT_MS);
    expect(resolveRunMemoryProbeTimeoutMs({ ...T, PAPERCLIP_HERMES_MEMORY_PROBE_TIMEOUT_MS: "abc" })).toBe(DEFAULT_MEMORY_PROBE_TIMEOUT_MS);
  });

  it("outside NODE_ENV=test the env var is ignored, so it cannot force the fail-open path", () => {
    expect(resolveRunMemoryProbeTimeoutMs({ NODE_ENV: "production", PAPERCLIP_HERMES_MEMORY_PROBE_TIMEOUT_MS: "1" })).toBe(DEFAULT_MEMORY_PROBE_TIMEOUT_MS);
    expect(resolveRunMemoryProbeTimeoutMs({ PAPERCLIP_HERMES_MEMORY_PROBE_TIMEOUT_MS: "1" })).toBe(DEFAULT_MEMORY_PROBE_TIMEOUT_MS);
  });
});

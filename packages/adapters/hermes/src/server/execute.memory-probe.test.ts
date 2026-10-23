/**
 * Independent probe-layer tests for the Hermes memory import probe (TECH-7220).
 *
 * These tests deliberately live in a separate file from execute.memory.test.ts so
 * they can evolve independently while that file's diff is still being read. They
 * target the shared runMemoryImportProbe contract and the embedded
 * HERMES_MEMORY_PYTHON_IMPORT_CHECK script directly (the layer *below*
 * checkHermesMemoryCapability), with no adapter-utils mocks.
 *
 * Covered independently of the implementation tests:
 * - constants and defaults (5s timeout, 4KiB buffer bound, server-entry re-exports)
 * - structured classification (ok / missing_module / missing_transitive /
 *   import_error) with positive exit-code 0 statuses
 * - fail-closed unclassified on non-JSON, non-object JSON, forged payloads, and
 *   nonzero exit codes
 * - own-deadline timeout vs externally killed child (same SIGKILL, different reason)
 * - bounded settle when a killed child's grandchild holds the stdio pipes
 * - normalized spawn codes, signals, and exception classes: only bounded metadata
 *   is ever returned; raw stderr / env / node error codes are never echoed
 * - env handling: explicit opts.env passes through; the default env path drops
 *   non-allowlisted server env vars (no env/DSN leakage to the probe child)
 * - real host Python validation of the actual embedded script using synthetic
 *   packages on PYTHONPATH (fake modules, no DB/API/provider), honestly skipped
 *   via ctx.skip() when a Python 3 interpreter is unavailable
 */

import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";

import {
  runMemoryImportProbe,
  DEFAULT_MEMORY_PROBE_TIMEOUT_MS,
  MEMORY_PROBE_MAX_BUFFER,
  HERMES_MEMORY_PYTHON_IMPORT_CHECK,
  type MemoryProbeResult,
} from "./execute.js";
import * as serverIndex from "./index.js";

/**
 * The complete set of fields a MemoryProbeResult may ever carry. Asserting
 * against this list keeps the probe result a bounded, normalized metadata
 * surface: no raw stdout, stderr, exception text, environment, or DSN material.
 */
const PROBE_RESULT_METADATA_KEYS = [
  "ok",
  "reason",
  "elapsedMs",
  "exitCode",
  "signal",
  "module",
  "transitive",
  "excClass",
  "spawnCode",
] as const;

function expectOnlySafeProbeMetadata(result: MemoryProbeResult) {
  for (const key of Object.keys(result)) {
    expect(PROBE_RESULT_METADATA_KEYS, "probe result must expose only safe metadata fields").toContain(key);
  }
}

let fixtureDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

/** Writes a fake python3 interpreter (shell script) and returns its absolute path. */
function writeFakePythonBin(body: string): string {
  const dir = makeTempDir("paperclip-hermes-probe-bin-");
  const bin = path.join(dir, "python3");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** Creates a synthetic Python package directory containing only mem0/__init__.py. */
function writeSyntheticMem0Package(initPy: string): string {
  const dir = makeTempDir("paperclip-hermes-probe-pypkg-");
  mkdirSync(path.join(dir, "mem0"), { recursive: true });
  writeFileSync(path.join(dir, "mem0", "__init__.py"), initPy);
  return dir;
}

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runMemoryImportProbe contract (TECH-7220)", () => {
  it("keeps the 5s default timeout and 4KiB buffer bound, re-exported from the server entrypoint", () => {
    expect(DEFAULT_MEMORY_PROBE_TIMEOUT_MS).toBe(5000);
    expect(MEMORY_PROBE_MAX_BUFFER).toBe(4096);
    expect(serverIndex.DEFAULT_MEMORY_PROBE_TIMEOUT_MS).toBe(DEFAULT_MEMORY_PROBE_TIMEOUT_MS);
    expect(serverIndex.MEMORY_PROBE_MAX_BUFFER).toBe(MEMORY_PROBE_MAX_BUFFER);
    expect(typeof serverIndex.runMemoryImportProbe).toBe("function");
    expect(HERMES_MEMORY_PYTHON_IMPORT_CHECK).toContain("importlib.import_module");
    expect(HERMES_MEMORY_PYTHON_IMPORT_CHECK).toContain("json.dumps");
  });

  it("resolves ok for a fast structured ok payload and returns only safe metadata", async () => {
    const bin = writeFakePythonBin(`echo '{"r":"ok"}'`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThan(2500);
    expectOnlySafeProbeMetadata(result);
  });

  it("keeps the 5s default deadline: a 1s interpreter startup finishes before the default timeout", async () => {
    const bin = writeFakePythonBin(`sleep 1\necho '{"r":"ok"}'`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.elapsedMs).toBeLessThan(2500);
  });

  it("classifies structured direct-missing with positive exit code 0", async () => {
    const bin = writeFakePythonBin(`echo '{"r":"missing","module":"psycopg2","transitive":false}'`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_module");
    expect(result.module).toBe("psycopg2");
    expect(result.transitive).toBe(false);
    expect(result.exitCode).toBe(0);
    expectOnlySafeProbeMetadata(result);
  });

  it("classifies structured transitive-missing with positive exit code 0", async () => {
    const bin = writeFakePythonBin(`echo '{"r":"missing","module":"psycopg","transitive":true}'`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_transitive");
    expect(result.module).toBe("psycopg");
    expect(result.transitive).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("classifies structured import errors with an allowlisted exception class", async () => {
    const bin = writeFakePythonBin(`echo '{"r":"import_error","module":"mem0","exc":"TypeError"}'`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("import_error");
    expect(result.module).toBe("mem0");
    expect(result.excClass).toBe("TypeError");
    expect(result.exitCode).toBe(0);
  });

  it("fails closed as unclassified on exit 0 with non-JSON stdout", async () => {
    const bin = writeFakePythonBin(`echo 'corrupt non-json stdout'`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unclassified");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("fails closed as unclassified when stdout parses to JSON that is not an object", async () => {
    const bin = writeFakePythonBin(`echo '123'`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unclassified");
    expect(result.exitCode).toBe(0);
  });

  it("rejects forged structured payloads naming modules or reasons outside the contract", async () => {
    const forgedModule = writeFakePythonBin(
      `echo '{"r":"missing","module":"not_a_required_module","transitive":false}'`,
    );
    const forgedModuleResult = await runMemoryImportProbe(forgedModule);
    expect(forgedModuleResult.ok).toBe(false);
    expect(forgedModuleResult.reason).toBe("unclassified");
    expect(forgedModuleResult.exitCode).toBe(0);

    const forgedReason = writeFakePythonBin(`echo '{"r":"totally_unknown","module":"mem0"}'`);
    const forgedReasonResult = await runMemoryImportProbe(forgedReason);
    expect(forgedReasonResult.ok).toBe(false);
    expect(forgedReasonResult.reason).toBe("unclassified");
    expect(forgedReasonResult.exitCode).toBe(0);
  });

  it("reports nonzero exit codes as unclassified with only safe metadata", async () => {
    const bin = writeFakePythonBin(`echo 'traceback: leaked SUPER_SECRET_PROBE_RAW_7220' >&2\nexit 7`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unclassified");
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expectOnlySafeProbeMetadata(result);
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_PROBE_RAW_7220");
    expect(JSON.stringify(result)).not.toContain("traceback");
  });

  it("enforces the default 4KiB stdout bound as unclassified", async () => {
    const bin = writeFakePythonBin(`head -c 6000 /dev/zero | tr "\\0" " "`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unclassified");
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
  });

  it("honors an explicit larger maxBuffer so whitespace-padded valid JSON still parses", async () => {
    const bin = writeFakePythonBin(`head -c 6000 /dev/zero | tr "\\0" " "\necho '{"r":"ok"}'`);
    const result = await runMemoryImportProbe(bin, { maxBuffer: 16384 });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  it("treats its own deadline expiry as timeout with SIGKILL, distinct from external kills", async () => {
    const bin = writeFakePythonBin(`sleep 2\necho '{"r":"ok"}'`);
    const result = await runMemoryImportProbe(bin, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.signal).toBe("SIGKILL");
    expect(result.exitCode).toBeNull();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(90);
    expect(result.elapsedMs).toBeLessThan(2500);
  });

  it("classifies an externally SIGKILLed child as signal, not timeout", async () => {
    const bin = writeFakePythonBin(`kill -9 $$`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signal");
    expect(result.signal).toBe("SIGKILL");
    expect(result.exitCode).toBeNull();
    expect(result.elapsedMs).toBeLessThan(2500);
  });

  it("classifies an externally SIGTERMed child as signal", async () => {
    const bin = writeFakePythonBin(`kill -TERM $$`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signal");
    expect(result.signal).toBe("SIGTERM");
  });

  it("normalizes unrecognized signals to 'other' without echoing the raw signal name", async () => {
    const bin = writeFakePythonBin(`kill -USR1 $$`);
    const result = await runMemoryImportProbe(bin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signal");
    expect(result.signal).toBe("other");
    expect(JSON.stringify(result)).not.toContain("SIGUSR1");
  });

  it("reports spawn errors with normalized spawn codes (ENOENT)", async () => {
    const missingBin = path.join(os.tmpdir(), "paperclip-hermes-probe-missing-python3-7220");
    const result = await runMemoryImportProbe(missingBin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn_error");
    expect(result.spawnCode).toBe("ENOENT");
    expect(result.exitCode).toBeNull();
    expectOnlySafeProbeMetadata(result);
  });

  it("catches synchronous execFile throws as spawn errors without leaking the raw node error code", async () => {
    const result = await runMemoryImportProbe("bad\0python");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn_error");
    expect(result.spawnCode).toBe("other");
    expect(result.exitCode).toBeNull();
    expect(JSON.stringify(result)).not.toContain("ERR_INVALID_ARG_VALUE");
  });

  it("settles bounded when a killed child's grandchild holds the stdio pipes", async () => {
    // The backgrounded sleep keeps the inherited stdout pipe open after the
    // direct child is SIGKILLed, so the execFile callback alone cannot arrive.
    // The probe must still settle bounded (deadline + short grace), not hang
    // until the orphaned 8s grandchild exits.
    const bin = writeFakePythonBin(`sleep 8 &\nsleep 8`);
    const result = await runMemoryImportProbe(bin, { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.elapsedMs).toBeLessThan(2500);
  });

  it("resolves a fast success well before a near-default deadline (no timer gating)", async () => {
    const bin = writeFakePythonBin(`echo '{"r":"ok"}'`);
    const result = await runMemoryImportProbe(bin, { timeoutMs: 4900 });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.elapsedMs).toBeLessThan(2500);
  });

  it("passes the caller-provided env through to the probe child", async () => {
    const bin = writeFakePythonBin(
      `if [ "$PROBE_ENV_MARKER_7220" != "set" ]; then echo 'env marker missing' >&2; exit 5; fi\necho '{"r":"ok"}'`,
    );
    const result = await runMemoryImportProbe(bin, {
      env: { ...process.env, PROBE_ENV_MARKER_7220: "set" },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("drops non-allowlisted server env vars on the default env path (no env/DSN leakage)", async () => {
    const markerName = "PAPERCLIP_PROBE_SECRET_MARKER_7220";
    const markerValue = "leak-value-7220";
    const bin = writeFakePythonBin(
      `if [ "$${markerName}" != "" ]; then echo "$${markerName}"; exit 9; fi\necho '{"r":"ok"}'`,
    );
    const original = process.env[markerName];
    process.env[markerName] = markerValue;
    try {
      // No opts.env: the probe must build the allowlisted base env, so the
      // server-only marker must never reach the probe child.
      const result = await runMemoryImportProbe(bin);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("ok");
      expect(JSON.stringify(result)).not.toContain(markerValue);
    } finally {
      if (original !== undefined) process.env[markerName] = original;
      else delete process.env[markerName];
    }
  });
});

describe("HERMES_MEMORY_PYTHON_IMPORT_CHECK against a real host Python interpreter", () => {
  let pythonAvailable = false;
  // Real host interpreter behind a hermetic wrapper: -S skips site-packages so a
  // host-installed mem0/psycopg can never flip the classification, while
  // PYTHONPATH stays honored so the synthetic packages below drive the outcome.
  let hostPythonBin: string | null = null;
  let wrapperDir: string | null = null;

  beforeAll(async () => {
    try {
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        execFile("python3", ["--version"], (err, out) => {
          if (err) reject(err);
          else resolve({ stdout: out ?? "" });
        });
      });
      pythonAvailable = stdout.includes("Python 3");
    } catch {
      pythonAvailable = false;
    }
    if (pythonAvailable) {
      wrapperDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-probe-pybin-"));
      hostPythonBin = path.join(wrapperDir, "python3");
      writeFileSync(hostPythonBin, '#!/bin/sh\nexec python3 -S "$@"\n');
      chmodSync(hostPythonBin, 0o755);
    }
  });

  afterAll(() => {
    if (wrapperDir) rmSync(wrapperDir, { recursive: true, force: true });
  });

  function requireHostPython(ctx: { skip: (note?: string) => void }): string {
    if (!pythonAvailable || !hostPythonBin) {
      // Honest skip: without a real interpreter the script classification is
      // NOT verified, so this test must not silently read as a pass.
      ctx.skip("host python3 unavailable; real script classification not verified");
      return "";
    }
    return hostPythonBin;
  }

  it("classifies a directly missing required module (ModuleNotFoundError with e.name === module)", async (ctx) => {
    const bin = requireHostPython(ctx);
    if (!bin) return;
    const emptyPath = makeTempDir("paperclip-hermes-probe-pyempty-");
    const result = await runMemoryImportProbe(bin, {
      env: { ...process.env, PYTHONPATH: emptyPath },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_module");
    expect(result.module).toBe("mem0");
    expect(result.transitive).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("classifies a nameless ModuleNotFoundError (e.name is None) as transitive, not direct", async (ctx) => {
    const bin = requireHostPython(ctx);
    if (!bin) return;
    const pkg = writeSyntheticMem0Package(
      'raise ModuleNotFoundError("legacy loader raised without a name kwarg")\n',
    );
    const result = await runMemoryImportProbe(bin, {
      env: { ...process.env, PYTHONPATH: pkg },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_transitive");
    expect(result.module).toBe("mem0");
    expect(result.transitive).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("classifies a missing submodule of the required module itself (e.name known, under mem0.) as direct", async (ctx) => {
    const bin = requireHostPython(ctx);
    if (!bin) return;
    const pkg = writeSyntheticMem0Package("import mem0.definitely_missing_sub_7220\n");
    const result = await runMemoryImportProbe(bin, {
      env: { ...process.env, PYTHONPATH: pkg },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_module");
    expect(result.module).toBe("mem0");
    expect(result.transitive).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("classifies a missing third-party dependency (e.name known, outside mem0) as transitive", async (ctx) => {
    const bin = requireHostPython(ctx);
    if (!bin) return;
    const pkg = writeSyntheticMem0Package("import non_existent_transitive_mod_7220\n");
    const result = await runMemoryImportProbe(bin, {
      env: { ...process.env, PYTHONPATH: pkg },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_transitive");
    expect(result.module).toBe("mem0");
    expect(result.transitive).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("classifies 'from . import missing' (plain ImportError, not ModuleNotFoundError) as import_error", async (ctx) => {
    const bin = requireHostPython(ctx);
    if (!bin) return;
    const pkg = writeSyntheticMem0Package("from . import definitely_missing_sub_7220\n");
    const result = await runMemoryImportProbe(bin, {
      env: { ...process.env, PYTHONPATH: pkg },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("import_error");
    expect(result.module).toBe("mem0");
    expect(result.excClass).toBe("ImportError");
    expect(result.exitCode).toBe(0);
  });

  it("normalizes unknown exception classes to 'other' without echoing the raw class name", async (ctx) => {
    const bin = requireHostPython(ctx);
    if (!bin) return;
    const pkg = writeSyntheticMem0Package(
      "class SecretDbCustomError_7220(Exception):\n    pass\nraise SecretDbCustomError_7220('boom')\n",
    );
    const result = await runMemoryImportProbe(bin, {
      env: { ...process.env, PYTHONPATH: pkg },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("import_error");
    expect(result.module).toBe("mem0");
    expect(result.excClass).toBe("other");
    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result)).not.toContain("SecretDbCustomError_7220");
  });

  it("silences import-time stdout/stderr noise so only strict JSON reaches the probe", async (ctx) => {
    const bin = requireHostPython(ctx);
    if (!bin) return;
    const pkg = writeSyntheticMem0Package(
      'import sys, warnings\nsys.stdout.write("NOISE_STDOUT_7220\\n")\nsys.stderr.write("NOISE_STDERR_7220\\n")\nwarnings.warn("NOISE_WARN_7220")\n',
    );
    const env = { ...process.env, PYTHONPATH: pkg };
    const result = await runMemoryImportProbe(bin, { env });
    // mem0 imports successfully despite its import-time noise; psycopg is directly missing.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_module");
    expect(result.module).toBe("psycopg");
    expect(result.transitive).toBe(false);
    expect(result.exitCode).toBe(0);

    // Independent raw capture: the embedded script itself must keep both real
    // streams noise-free; the probe result above already proves stdout stayed
    // strict JSON (otherwise parsing would have failed closed).
    const raw = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(bin, ["-c", HERMES_MEMORY_PYTHON_IMPORT_CHECK], { env }, (err, out, errOut) => {
        if (err) reject(err);
        else resolve({ stdout: out ?? "", stderr: errOut ?? "" });
      });
    });
    expect(() => JSON.parse(raw.stdout)).not.toThrow();
    expect(JSON.parse(raw.stdout)).toEqual({ r: "missing", module: "psycopg", transitive: false });
    expect(raw.stdout).not.toContain("NOISE_STDOUT_7220");
    expect(raw.stderr).not.toContain("NOISE_STDERR_7220");
    expect(raw.stderr).not.toContain("NOISE_WARN_7220");
  });
});

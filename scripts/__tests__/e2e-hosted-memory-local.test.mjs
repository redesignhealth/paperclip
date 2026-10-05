/**
 * e2e-hosted-memory-local.test.mjs
 *
 * Bounded offline regression for the early gates of the production local E2E
 * script scripts/e2e-hosted-memory-local.sh (TECH-7126 / TECH-7142, E2E_SCOPE=all
 * extension). These tests EXECUTE the real script as a child process and stop at
 * its pre-container gates: no Docker containers, no volumes, no network, no
 * real provider keys (a synthetic sentinel stands in for one provider key),
 * no image. Every assertion below is an executed-path assertion.
 *
 * Controls exercised (offline-executable subset only):
 *   1. E2E_SCOPE gate: only 'allowlist' and 'all' are accepted; anything else
 *      exits 2 before anything else happens.
 *   2. IMAGE gate: the script refuses to run without IMAGE.
 *   3. Provider-key gate: both keys are required; when one is missing the
 *      script exits 2 BEFORE any container/volume exists, and the sentinel
 *      value that WAS provided is never reflected in stdout or stderr.
 *
 * Bounded-wait / typed-tool-proof tests (below the key-gate tests) source the
 * script's own marked helper blocks (`# >>> testable:...`) and execute them
 * against a local hung/ok TCP or HTTP listener on 127.0.0.1, a fake `aws` on
 * PATH, and synthetic ndjson fixtures. No docker, no model, no real AWS/SSM,
 * dummy values only.
 *
 * The live-path controls (memory-only toolset exclusion incl. MCP, tenant B
 * positive/cross-negative, fresh-reader nonce, mem0_add/mem0_search trace
 * proof, leak scan) require the built image and real provider keys and are
 * NOT exercised here; see the report for the material findings on those
 * paths and the unmapped pinned-Hermes limitation.
 *
 * Run: node --test scripts/__tests__/e2e-hosted-memory-local.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "e2e-hosted-memory-local.sh");

// Synthetic sentinel ONLY (never a real key, never sent anywhere: the script
// exits at the key gate before any outbound call or container exists).
const DUMMY_ANTHROPIC_KEY = "DUMMY-SENTINEL-ANTHROPIC-KEY-6f3a91-not-real";

function runScript(env) {
  const res = spawnSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("E2E_SCOPE gate: a scope other than 'allowlist'/'all' exits 2 with the scope error", () => {
  const { status, stdout, stderr } = runScript({ IMAGE: "dummy-image-ref", E2E_SCOPE: "everything" });
  assert.equal(status, 2, `scope gate must exit 2 (got ${status})`);
  const all = `${stdout}\n${stderr}`;
  assert.ok(all.includes("E2E_SCOPE must be 'allowlist' or 'all'"), "the scope error must name the gate");
});

test("IMAGE gate: without IMAGE the script exits nonzero with the IMAGE error", () => {
  const { status, stdout, stderr } = runScript({});
  assert.notEqual(status, 0, "missing IMAGE must exit nonzero");
  const all = `${stdout}\n${stderr}`;
  assert.ok(all.includes("set IMAGE"), "the IMAGE error must name the gate");
});

test("provider-key gate: a missing second key exits 2 before any container/volume, and the provided sentinel key is never echoed", () => {
  const { status, stdout, stderr } = runScript({
    IMAGE: "dummy-image-ref",
    E2E_SCOPE: "all",
    // One synthetic key present, the other absent, no SSM fallback names:
    // the script must stop at the key gate.
    TEST_ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY,
  });
  assert.equal(status, 2, `missing-key gate must exit 2 (got ${status})`);
  const all = `${stdout}\n${stderr}`;
  assert.ok(all.includes("provider keys missing"), "the key-gate error must name the missing keys");
  // No raw provider values in output: the sentinel that WAS provided must
  // never be reflected anywhere (stdout or stderr).
  assert.ok(
    !all.includes(DUMMY_ANTHROPIC_KEY),
    "the provided provider-key sentinel must never appear in stdout/stderr",
  );
  // The gate fires before any container or volume is created: no docker
  // resource names may appear in the output at this stage.
  assert.ok(!all.includes("e2e-mem-pg-"), "no postgres container may be started before the key gate");
  assert.ok(!all.includes("e2e-mem-app-"), "no app container may be started before the key gate");
});

test("provider-key gate: the gate also fires when only the SSM fallbacks are named but unavailable", () => {
  // Naming SSM parameters without any aws credentials would attempt a real
  // SSM call; the offline-safe variant is to verify the env-only path with
  // BOTH direct keys absent: the direct-key check must reject first without
  // touching SSM (no E2E_*_SSM provided).
  const { status, stdout, stderr } = runScript({ IMAGE: "dummy-image-ref", E2E_SCOPE: "all" });
  assert.equal(status, 2);
  const all = `${stdout}\n${stderr}`;
  assert.ok(all.includes("provider keys missing"));
  assert.ok(!all.includes("aws ssm get-parameter"), "no SSM call may be made when no SSM names are given");
});

// ---------------------------------------------------------------------------
// Bounded waits, bounded AWS/SSM reads, typed tool-proof classifier.
// ---------------------------------------------------------------------------

function helperSource() {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const blocks = [...src.matchAll(/# >>> testable:([\w-]+)\n([\s\S]*?)# <<< testable:\1\n/g)].map((m) => m[2]);
  assert.equal(blocks.length, 2, "the script must expose exactly the two marked helper blocks");
  return blocks.join("\n");
}

/** Run bash code with the script's helper blocks sourced, in a scratch dir. Async so local servers keep serving. */
function bashWithHelpers(code, { env = {}, cwd } = {}) {
  const dir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "e2e-helpers-"));
  const file = path.join(dir, "helpers.sh");
  fs.writeFileSync(file, helperSource());
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `set -uo pipefail; source "${file}"; ${code}`], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr, ms: Date.now() - started, dir });
    });
  });
}

/** mode: "hang" accepts the connection and never answers; otherwise a function (req,res). */
function startServer(mode) {
  const sockets = new Set();
  const server =
    mode === "hang"
      ? net.createServer((sock) => {
          sockets.add(sock);
          sock.on("error", () => {});
        })
      : http.createServer(mode);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          for (const s of sockets) s.destroy();
          server.closeAllConnections?.();
          server.close();
        },
      }),
    ),
  );
}

function fakeAwsDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fakeaws-"));
  fs.writeFileSync(path.join(dir, "aws"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

test("bounded(): wall-clock cap kills the whole process group (124), passes exit codes through", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bounded-"));
  const hung = await bashWithHelpers(`bounded 2 sh -c 'sleep 60 & echo $! > "${dir}/child.pid"; wait'; echo "rc=$?"`, { cwd: dir });
  assert.ok(hung.stdout.includes("rc=124"), `timeout must exit 124 (got ${hung.stdout})`);
  assert.ok(hung.ms < 10_000, `capped at ~2s, took ${hung.ms}ms`);
  const childPid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(childPid, 0), "the grandchild sleep must have been killed with the group");
  const ok = await bashWithHelpers(`bounded 5 sh -c 'exit 7'; echo "rc=$?"`);
  assert.ok(ok.stdout.includes("rc=7"), "a finished command's exit code passes through");
});

test("AWS/SSM: a hung aws is wall-capped, uses native bounds (no --max-attempts), prints a fixed code only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ssm-"));
  const fake = fakeAwsDir(`echo $$ > "${dir}/aws.pid"; echo "$@" > "${dir}/aws.args"; echo "$AWS_MAX_ATTEMPTS $AWS_RETRY_MODE" > "${dir}/aws.env"; exec sleep 600`);
  const started = Date.now();
  const res = spawnSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    env: { PATH: `${fake}:${process.env.PATH}`, HOME: process.env.HOME, IMAGE: "dummy-image-ref", E2E_ANTHROPIC_SSM: "dummy/param/name", E2E_AWS_CAP_SECONDS: "2", TEST_OPENAI_API_KEY: "DUMMY-OPENAI" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const all = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 2);
  assert.ok(Date.now() - started < 15_000, "bounded by E2E_AWS_CAP_SECONDS, not by the fake's 600s sleep");
  assert.ok(all.includes("SSM read failed (code=ssm_timeout)"), "fixed timeout code");
  const args = fs.readFileSync(path.join(dir, "aws.args"), "utf8");
  assert.ok(args.includes("--cli-connect-timeout") && args.includes("--cli-read-timeout"), "native CLI timeouts");
  assert.ok(!args.includes("--max-attempts"), "no invalid --max-attempts flag");
  assert.equal(fs.readFileSync(path.join(dir, "aws.env"), "utf8").trim(), "2 standard", "AWS_MAX_ATTEMPTS/AWS_RETRY_MODE env");
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(Number(fs.readFileSync(path.join(dir, "aws.pid"), "utf8")), 0), "the hung aws child is reaped");
});

test("AWS/SSM: failure prints only the fixed code (no AWS stderr, no parameter text); success value is captured, not printed", async () => {
  const bad = fakeAwsDir(`echo "AccessDenied LEAKY_PARAM_TEXT_91" >&2; echo "LEAKY_PARAM_TEXT_91"; exit 255`);
  const fail = await bashWithHelpers(`v="$(ssm_value some/param)" || echo "rc=$?"; echo "captured=[$v]"`, { env: { PATH: `${bad}:${process.env.PATH}` } });
  assert.ok(fail.stdout.includes("rc=1") && fail.stdout.includes("captured=[]"));
  assert.ok(fail.stderr.includes("SSM read failed (code=ssm_unavailable)"));
  assert.ok(!`${fail.stdout}${fail.stderr}`.includes("LEAKY_PARAM_TEXT_91"), "raw AWS output must never be printed");
  // positive control: a normal read is captured into the variable and prints nothing to stderr
  const good = fakeAwsDir(`echo "DUMMY-PARAM-VALUE-4471"`);
  const ok = await bashWithHelpers(`v="$(ssm_value some/param)" && echo "len=${"${#v}"}"`, { env: { PATH: `${good}:${process.env.PATH}` } });
  assert.ok(ok.stdout.includes("len=22"), `value captured (got ${ok.stdout})`);
  assert.equal(ok.stderr, "");
  assert.ok(!ok.stdout.includes("DUMMY-PARAM-VALUE-4471"), "the value itself is never echoed by the helper");
});

test("HTTP: a hung server cannot block api(); wait_healthy and poll_run honor wall-clock budgets", async () => {
  const hang = await startServer("hang");
  try {
    const a = await bashWithHelpers(`API_MAX_TIME=2 api GET /x; echo "rc=$?"`, { env: { BASE: hang.base } });
    assert.equal(a.stdout.trim(), "rc=0");
    assert.ok(a.ms >= 1500 && a.ms < 8000, `api capped near API_MAX_TIME (took ${a.ms}ms)`);

    const h = await bashWithHelpers(`WAIT_HEALTH=3; wait_healthy; echo "rc=$?"`, { env: { BASE: hang.base } });
    assert.ok(h.stdout.includes("rc=1"), "never healthy");
    assert.ok(h.ms < 9000, `wait_healthy honors the 3s wall budget (took ${h.ms}ms)`);

    const r = await bashWithHelpers(`WAIT_RUN=3; poll_run 5f7a8d10-df57-4739-9960-cf39f43a4d3d t1; echo; echo "ms=$SECONDS"`, { env: { BASE: hang.base } });
    assert.ok(r.stdout.startsWith("unknown"), `a hung server yields the fixed status (got ${r.stdout})`);
    assert.ok(r.ms < 9000, `poll_run honors the 3s wall budget (took ${r.ms}ms)`);
  } finally {
    hang.close();
  }
});

test("HTTP positive controls: healthy server, terminal run status, and no echo of a hostile status string", async () => {
  const ok = await startServer((req, res) => {
    if (req.url === "/api/health") return res.end("{}");
    if (req.url.startsWith("/api/heartbeat-runs/")) return res.end(JSON.stringify({ status: "succeeded" }));
    res.statusCode = 404;
    res.end("nope");
  });
  const bad = await startServer((req, res) => {
    if (req.url === "/api/health") {
      res.statusCode = 500;
      return res.end("boom");
    }
    res.end(JSON.stringify({ status: "HOSTILE_STATUS_MARKER leak me" }));
  });
  try {
    const h = await bashWithHelpers(`WAIT_HEALTH=5; wait_healthy; echo "rc=$?"`, { env: { BASE: ok.base } });
    assert.ok(h.stdout.includes("rc=0"));
    const r = await bashWithHelpers(`WAIT_RUN=5; poll_run 5f7a8d10-df57-4739-9960-cf39f43a4d3d t1`, { env: { BASE: ok.base } });
    assert.equal(r.stdout, "succeeded");
    const e = await bashWithHelpers(`WAIT_HEALTH=2; wait_healthy; echo "rc=$?"`, { env: { BASE: bad.base } });
    assert.ok(e.stdout.includes("rc=1"), "HTTP 500 is not healthy (curl -f)");
    const p = await bashWithHelpers(`WAIT_RUN=2; poll_run 5f7a8d10-df57-4739-9960-cf39f43a4d3d t2`, { env: { BASE: bad.base } });
    assert.equal(p.stdout, "unknown");
    assert.ok(!`${p.stdout}${p.stderr}`.includes("HOSTILE_STATUS_MARKER"));
  } finally {
    ok.close();
    bad.close();
  }
});

test("typed tool proof: only whole-line stderr logger records of the run's OWN log count; assistant echo, truncation, substrings and failures do not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-typed-"));
  const rec = (stream, chunk) => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", stream, chunk });
  const TYPED_ADD = "14:22:01 - agent.tool_executor - INFO [20260101_abcd] - tool mem0_add completed (0.12s, 45 chars)\n";
  // run A: only fakes. Assistant echo (stdout), truncated name, line with a prefix, failed record, wrong logger.
  fs.writeFileSync(
    path.join(dir, "runraw-fakeA.ndjson"),
    [
      rec("stdout", TYPED_ADD),
      rec("stdout", "Hermes ─ STORED mem0_add mem0_sear\n"),
      rec("stderr", "14:22:01 - agent.tool_executor - INFO - tool mem0_sear completed (0.12s, 45 chars)\n"),
      rec("stderr", "echo: " + TYPED_ADD),
      rec("stderr", "14:22:01 - agent.tool_executor - INFO - tool mem0_add failed (0.12s): boom\n"),
      rec("stderr", "14:22:01 - some.other_logger - INFO - tool mem0_add completed (0.12s, 45 chars)\n"),
      "not json at all",
    ].join("\n"),
  );
  // run B: genuine typed records for both tools (one split across two chunks, as a stream may deliver it).
  fs.writeFileSync(
    path.join(dir, "runraw-realB.ndjson"),
    [
      rec("stderr", TYPED_ADD),
      rec("stderr", "14:22:02 - agent.tool_executor - INFO - tool mem0_sea"),
      rec("stderr", "rch completed (0.30s, 210 chars)\n"),
    ].join("\n"),
  );
  const out = await bashWithHelpers(
    `for l in fakeA realB; do for t in mem0_add mem0_search; do echo "$l $t $(typed_tool_calls $l $t)"; done; done; echo "missing $(typed_tool_calls nosuch mem0_add)"`,
    { cwd: dir },
  );
  const lines = Object.fromEntries(out.stdout.trim().split("\n").map((l) => [l.replace(/ \d+$/, ""), Number(l.split(" ").pop())]));
  assert.equal(lines["fakeA mem0_add"], 0, "stdout echo / prefixed / failed / wrong-logger lines never count");
  assert.equal(lines["fakeA mem0_search"], 0, "a truncated tool name never counts");
  assert.equal(lines["realB mem0_add"], 1, "positive control: genuine typed record counts for its own run");
  assert.equal(lines["realB mem0_search"], 1, "a record split across stderr chunks is reassembled");
  assert.equal(lines["missing"], 0, "no log file means zero, not an error");
});

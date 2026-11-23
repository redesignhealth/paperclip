import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSessionSecrets,
  redactSessionText,
  restoreRemoteSession,
  saveRemoteSession,
  protectRemoteSessionDir,
  serverSessionCopyPath,
  type RemoteSessionExec,
} from "./session-persistence.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

// A fake "pod": runs the scripts locally under /bin/sh, rooted in a temp dir.
async function makePod() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sess-pod-"));
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sess-store-"));
  dirs.push(root, store);
  const exec: RemoteSessionExec = (script, stdin) =>
    new Promise((resolve) => {
      const child = spawn("/bin/sh", ["-c", script], { cwd: root });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d));
      child.on("close", (code: number | null) => resolve({ exitCode: code, timedOut: false, stdout }));
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
  return { root, store, exec };
}

const header = JSON.stringify({ type: "session", cwd: "/workspace" });
const turn = JSON.stringify({ type: "message", text: "explored the repo" });

describe("remote Pi session persistence", () => {
  it("survives a scrub: saved on the server, restored into the pod at the same path", async () => {
    const pod = await makePod();
    const sessionPath = `${pod.root}/workspace/.paperclip-runtime/pi/sessions/2026-x-agent.jsonl`;
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, `${header}\n${turn}\n`);

    expect(await saveRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath, secrets: [] })).toBe(true);
    // pod scrub
    await fs.rm(`${pod.root}/workspace/.paperclip-runtime`, { recursive: true });

    expect(await restoreRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath })).toBe(true);
    expect(await fs.readFile(sessionPath, "utf8")).toBe(`${header}\n${turn}\n`);
    expect((await fs.stat(sessionPath)).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite a session the pod still has", async () => {
    const pod = await makePod();
    const sessionPath = `${pod.root}/workspace/.paperclip-runtime/pi/sessions/a.jsonl`;
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, `${header}\n${turn}\n`);
    await saveRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath, secrets: [] });
    expect(await restoreRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath })).toBe(false);
  });

  it("a different issue's session path never resolves to the first issue's copy", async () => {
    const pod = await makePod();
    const a = `${pod.root}/workspace/.paperclip-runtime/pi/sessions/issue-a.jsonl`;
    const b = `${pod.root}/workspace/.paperclip-runtime/pi/sessions/issue-b.jsonl`;
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.writeFile(a, `${header}\n${turn}\n`);
    await saveRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath: a, secrets: [] });
    await fs.rm(`${pod.root}/workspace/.paperclip-runtime`, { recursive: true });
    expect(serverSessionCopyPath(pod.store, a)).not.toBe(serverSessionCopyPath(pod.store, b));
    expect(await restoreRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath: b })).toBe(false);
    await expect(fs.stat(b)).rejects.toThrow();
  });

  it("redacts known secret values before storing", async () => {
    const pod = await makePod();
    const sessionPath = `${pod.root}/workspace/.paperclip-runtime/pi/sessions/s.jsonl`;
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    const leak = JSON.stringify({ type: "message", text: "key sk-fake-secret-value-123 and bridge-fake-token-9999" });
    await fs.writeFile(sessionPath, `${header}\n${leak}\n`);
    const secrets = collectSessionSecrets({ OPENAI_API_KEY: "sk-fake-secret-value-123", HOME: "/home/x" }, ["bridge-fake-token-9999"]);
    await saveRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath, secrets });
    const stored = await fs.readFile(serverSessionCopyPath(pod.store, sessionPath), "utf8");
    expect(stored).not.toContain("sk-fake-secret-value-123");
    expect(stored).not.toContain("bridge-fake-token-9999");
    expect(stored).toContain("[REDACTED]");
  });

  it("keeps the previous server copy when the pod file is torn", async () => {
    const pod = await makePod();
    const sessionPath = `${pod.root}/workspace/.paperclip-runtime/pi/sessions/t.jsonl`;
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, `${header}\n${turn}\n`);
    await saveRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath, secrets: [] });
    await fs.writeFile(sessionPath, `${header}\n{"type":"mess`);
    expect(await saveRemoteSession({ exec: pod.exec, storeDir: pod.store, sessionPath, secrets: [] })).toBe(false);
    expect(await fs.readFile(serverSessionCopyPath(pod.store, sessionPath), "utf8")).toBe(`${header}\n${turn}\n`);
  });

  it("makes the runtime dir self-ignoring so Git never sees the session file", async () => {
    const pod = await makePod();
    const ws = `${pod.root}/workspace`;
    await fs.mkdir(ws, { recursive: true });
    await run("git", ["init", "-q"], { cwd: ws });
    const sessionPath = `${ws}/.paperclip-runtime/pi/sessions/g.jsonl`;
    await protectRemoteSessionDir(pod.exec, sessionPath);
    await fs.writeFile(sessionPath, `${header}\n`);
    const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ws });
    expect(stdout).toBe("");
  });

  it("redactSessionText replaces longest secrets first", () => {
    expect(redactSessionText("a abcdefgh-long b abcdefgh", collectSessionSecrets({ X_TOKEN: "abcdefgh-long" }, ["abcdefgh"]))).toBe("a [REDACTED] b [REDACTED]");
  });
});

describe("redaction of JSON-escaped secrets", () => {
  it("redacts a multi-line secret as it appears escaped inside a JSONL line", () => {
    const pem = "-----BEGIN KEY-----\nabcdef\n-----END KEY-----";
    const line = JSON.stringify({ type: "message", text: pem });
    const secrets = collectSessionSecrets({ AGENT_PRIVATE_KEY: pem });
    const out = redactSessionText(line, secrets);
    expect(out).not.toContain("abcdef");
    expect(() => JSON.parse(out)).not.toThrow();
  });
  it("does not treat key ids and paths as secrets", () => {
    expect(collectSessionSecrets({ PAPERCLIP_AGENT_KEY_ID: "key-id-12345678", SSH_KEY_PATH: "/home/x/.ssh/idrsa" })).toEqual([]);
  });
});

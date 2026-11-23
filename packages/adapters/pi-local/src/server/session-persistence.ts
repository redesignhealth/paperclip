// Keeps a remote (sandbox pod) Pi session across wakes (TECH-9798).
//
// A reused sandbox pod is scrubbed between turns, which deletes
// `<workspace>/.paperclip-runtime`, where Pi keeps its session file. The server
// is authoritative, so after each run the session file is copied to a
// server-side store and, before the next run on the same issue, copied back
// into the pod at the same path. The stored copy is keyed by the remote session
// path, which sessionParams (one per agent and issue) carries, so another issue
// never resolves to this file.
//
// Credentials: the file is never left in a place Git can see (the runtime
// directory gets a self-ignoring .gitignore), the server copy is mode 0600,
// and known secret values from the run env are redacted before it is stored.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

export type RemoteSessionExec = (script: string, stdin?: string) => Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
}>;

const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
// Identifiers and paths, not secrets; redacting them could corrupt the resume header.
const NON_SECRET_KEY_PATTERN = /(KEY_ID|PUBLIC_KEY|KEY_PATH|KEY_FILE|_PATH$|_DIR$)/i;
const MIN_SECRET_LENGTH = 8;
const RUNTIME_DIR_NAME = ".paperclip-runtime";

export function serverSessionCopyPath(storeDir: string, remoteSessionPath: string): string {
  const key = createHash("sha256").update(remoteSessionPath).digest("hex").slice(0, 40);
  return path.join(storeDir, "remote", `${key}.jsonl`);
}

export function collectSessionSecrets(env: Record<string, string>, extra: Array<string | null | undefined> = []): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH && SECRET_KEY_PATTERN.test(key) && !NON_SECRET_KEY_PATTERN.test(key)) values.add(value);
  }
  for (const value of extra) if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) values.add(value);
  // Longest first so a secret that contains another is replaced whole.
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactSessionText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join("[REDACTED]");
    // Session lines are JSON, so a multi-line or quoted secret appears escaped.
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join("[REDACTED]");
  }
  return out;
}

function isValidJsonl(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  try {
    for (const line of lines) JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function runtimeDirOf(sessionPath: string): string | null {
  const idx = sessionPath.indexOf(`/${RUNTIME_DIR_NAME}/`);
  return idx < 0 ? null : sessionPath.slice(0, idx + 1 + RUNTIME_DIR_NAME.length);
}

/** Script that creates the session dir and a self-ignoring .gitignore in the runtime dir, so the session file can never be committed. */
export function buildSessionGitIgnoreScript(sessionPath: string): string {
  const dir = shellQuote(path.posix.dirname(sessionPath));
  const runtimeDir = runtimeDirOf(sessionPath);
  if (!runtimeDir) return `mkdir -p ${dir}`;
  const ignore = shellQuote(`${runtimeDir}/.gitignore`);
  return `mkdir -p ${dir} && { [ -e ${ignore} ] || printf '*\\n' > ${ignore}; }`;
}

export async function protectRemoteSessionDir(exec: RemoteSessionExec, sessionPath: string): Promise<void> {
  await exec(buildSessionGitIgnoreScript(sessionPath));
}

/** Copy the server's saved session into the pod when the pod no longer has it. Returns true when a file was restored. */
export async function restoreRemoteSession(input: {
  exec: RemoteSessionExec;
  storeDir: string;
  sessionPath: string;
}): Promise<boolean> {
  const { exec, storeDir, sessionPath } = input;
  const present = await exec(`[ -s ${shellQuote(sessionPath)} ] && echo present || echo absent`);
  // Only a clean "absent" answer triggers a restore; a failed or timed-out probe leaves the pod alone.
  if (present.timedOut || present.exitCode !== 0 || present.stdout.trim() !== "absent") return false;
  let saved: string;
  try {
    saved = await fs.readFile(serverSessionCopyPath(storeDir, sessionPath), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (!isValidJsonl(saved)) return false;
  const quoted = shellQuote(sessionPath);
  // Write to a temp name under umask 077 and rename, so a failed or timed-out write never leaves a torn file at sessionPath.
  const tmp = shellQuote(`${sessionPath}.restoring`);
  const written = await exec(
    `${buildSessionGitIgnoreScript(sessionPath)} && ( umask 077; base64 -d > ${tmp} ) && mv ${tmp} ${quoted} || { rm -f ${tmp}; exit 1; }`,
    Buffer.from(saved, "utf8").toString("base64"),
  );
  return written.exitCode === 0 && !written.timedOut;
}

/** Copy the pod's session file to the server store, redacting known secret values. Best effort; returns true when saved. */
export async function saveRemoteSession(input: {
  exec: RemoteSessionExec;
  storeDir: string;
  sessionPath: string;
  secrets: string[];
}): Promise<boolean> {
  const { exec, storeDir, sessionPath, secrets } = input;
  const read = await exec(`[ -s ${shellQuote(sessionPath)} ] && base64 < ${shellQuote(sessionPath)}`);
  if (read.exitCode !== 0 || read.timedOut) return false;
  const text = Buffer.from(read.stdout.replace(/\s+/g, ""), "base64").toString("utf8");
  // A capped or interrupted read would leave a torn last line; keep the previous copy instead.
  if (!isValidJsonl(text)) return false;
  const target = serverSessionCopyPath(storeDir, sessionPath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, redactSessionText(text, secrets), { mode: 0o600 });
  await fs.rename(temporary, target);
  return true;
}

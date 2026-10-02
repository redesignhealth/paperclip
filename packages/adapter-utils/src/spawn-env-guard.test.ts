/**
 * TECH-7076 guard (adapter-utils, paperclip-runner, server): no NEW code may copy the full server
 * process.env into an object (`...process.env`) or pass it as `env: process.env`.
 *
 * The listed files were each reviewed and are acceptable for the reason given. To add an exception
 * you must justify it here; to spawn a child process build its env from
 * `buildAgentChildBaseEnv()` plus explicit adapter env instead.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [
  path.resolve(here, "."),
  path.resolve(here, "../../paperclip-runner/src"),
  path.resolve(here, "../../../server/src"),
];

// Matched against the WHOLE file text (so a spread split across lines is caught), not line by line.
const FORBIDDEN = [
  /\.\.\.\s*\(?\s*process\.env\b/,
  /\benv\s*:\s*process\.env\b/,
  /Object\.(?:entries|keys|values|assign|fromEntries)\(\s*(?:\{\}\s*,\s*)?process\.env\b/,
  /structuredClone\(\s*process\.env\b/,
];

/** repo-relative path suffix -> why a full process.env copy is acceptable there. */
const REVIEWED_EXCEPTIONS: Record<string, string> = {
  "adapter-utils/src/execution-target.ts":
    "wrapper scripts run INSIDE the sandbox/remote target; their process.env is the target's launch env, not the server's",
  "adapter-utils/src/github-launcher.ts": "runs inside the sandbox, not on the server",
  "adapter-utils/src/local-process-sandbox.ts": "sandbox-side launcher, runs inside the sandbox",
  "paperclip-runner/src/live/runnerd-codex-transport.ts":
    "result is filtered through OPEN_CODE_RUNNER_ENVIRONMENT_KEYS (an allowlist); OPENROUTER_API_KEY and PAPERCLIP_NATIVE_MCP_* are excluded from the server-env half and only accepted from the explicit source",
  "paperclip-runner/src/drivers/acpx/installation-integrity.ts":
    "spawns the provider binary for an integrity check with an env the caller already built",
  "server/src/adapters/process/execute.ts": "used only to resolve the command path / log HOME; child env is built in runChildProcess",
  "server/src/adapters/process/test.ts": "environment test resolves the command path only",
  "server/src/app.ts": "diagnostic/config read, not a child process env",
  "server/src/routes/agents.ts": "diagnostic/readiness reads, not a child process env",
  "server/src/services/heartbeat.ts": "codex readiness read, not a child process env",
  "server/src/routes/execution-workspaces.ts": "trusted Paperclip seed CLI that needs DATABASE_URL and friends",
  "server/src/services/smoke-lab.ts": "trusted in-repo fixture process",
};

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "coverage", "__tests__", "test-support"].includes(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !/\.test\.|\.spec\.|\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function relKey(file: string): string {
  const norm = file.split(path.sep).join("/");
  const m = norm.match(/(adapter-utils\/src|paperclip-runner\/src|server\/src)\/.*$/);
  return m ? m[0] : norm;
}

describe("no new full process.env copies in adapter-utils, paperclip-runner, server (TECH-7076)", () => {
  const files = roots.flatMap((root) => listSourceFiles(root));

  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds a full process.env copy only in reviewed files", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const key = relKey(file);
      if (Object.prototype.hasOwnProperty.call(REVIEWED_EXCEPTIONS, key)) continue;
      const text = readFileSync(file, "utf8");
      for (const re of FORBIDDEN) {
        const global = new RegExp(re.source, "g");
        let match: RegExpExecArray | null;
        while ((match = global.exec(text)) !== null) {
          const line = text.slice(0, match.index).split("\n").length;
          const lineText = text.split("\n")[line - 1]?.trim() ?? "";
          if (lineText.startsWith("//") || lineText.startsWith("*")) continue;
          offenders.push(`${key}:${line}: ${lineText}`);
        }
      }
    }
    expect(
      offenders,
      `Build child envs from buildAgentChildBaseEnv(), or add a reviewed exception with a reason:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every reviewed exception still exists (remove stale entries)", () => {
    const keys = new Set(files.map(relKey));
    const stale = Object.keys(REVIEWED_EXCEPTIONS).filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });
});

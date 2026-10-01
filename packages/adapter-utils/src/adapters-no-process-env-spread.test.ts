/**
 * TECH-7076 guard: adapter code must never copy the whole server process.env into
 * a child process environment. That is how server-only secrets (SSO providers,
 * Better Auth secret, master key, database URLs, cloud credentials) reached an
 * agent's terminal tool. Build the child env from `buildAgentChildBaseEnv()` in
 * @paperclipai/adapter-utils/agent-child-env plus explicit adapter env instead.
 *
 * This is a static check over adapter source, so a future adapter or refactor that
 * reintroduces `...process.env` fails CI instead of silently regressing.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const adaptersRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../adapters");

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "spread of process.env", pattern: /\.\.\.\s*\(?\s*process\.env\b/ },
  { name: "env: process.env", pattern: /\benv\s*:\s*process\.env\b/ },
  { name: "Object.assign(..., process.env)", pattern: /Object\.assign\([^)]*\bprocess\.env\b/ },
  { name: "Object.entries(process.env) copied into an env", pattern: /Object\.fromEntries\(\s*Object\.entries\(\s*process\.env\b/ },
];

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
    const full = path.join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry) && !/\.test\.|\.spec\.|__tests__/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

describe("adapters never copy the full server process.env into a child env (TECH-7076)", () => {
  const files = readdirSync(adaptersRoot)
    .map((name) => path.join(adaptersRoot, name, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((dir) => listSourceFiles(dir));

  it("scans a non-trivial set of adapter source files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds no full process.env copy in any adapter source", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(line)) {
            offenders.push(`${path.relative(adaptersRoot, file)}:${i + 1} (${rule.name}): ${trimmed}`);
          }
        }
      });
    }
    expect(offenders, `Do not copy process.env into a child env:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the guard itself catches the original Hermes bug pattern", () => {
    const bad = "const env = { ...(process.env as Record<string, string>), ...userEnv };";
    expect(FORBIDDEN.some((rule) => rule.pattern.test(bad))).toBe(true);
    const good = "const env = { ...buildAgentChildBaseEnv(process.env), ...userEnv };";
    expect(FORBIDDEN.some((rule) => rule.pattern.test(good))).toBe(false);
  });
});

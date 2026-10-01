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

// Matched against the WHOLE file text, so a spread split across lines is caught, not line by line.
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "spread of process.env", pattern: /\.\.\.\s*\(?\s*process\.env\b/ },
  { name: "env: process.env", pattern: /\benv\s*:\s*process\.env\b/ },
  {
    name: "Object.entries/keys/values/assign/fromEntries(process.env)",
    pattern: /Object\.(?:entries|keys|values|assign|fromEntries)\(\s*(?:\{\}\s*,\s*)?process\.env\b/,
  },
  { name: "structuredClone(process.env)", pattern: /structuredClone\(\s*process\.env\b/ },
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
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (const rule of FORBIDDEN) {
        const re = new RegExp(rule.pattern.source, "g");
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
          const line = text.slice(0, match.index).split("\n").length;
          const lineText = lines[line - 1]?.trim() ?? "";
          if (lineText.startsWith("//") || lineText.startsWith("*")) continue;
          offenders.push(`${path.relative(adaptersRoot, file)}:${line} (${rule.name}): ${lineText}`);
        }
      }
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

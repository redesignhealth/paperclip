/**
 * TECH-7095 static guards.
 *
 * #31's guards only catch `...process.env` and `env: process.env`. These add the shapes it could
 * not see, so the hosted managed-only rules cannot be bypassed by new code:
 *
 *  1. `x ?? process.env`, `x || process.env`, and `const y = process.env` aliases.
 *  2. A `child_process` spawn/exec call whose arguments contain no explicit `env`
 *     (it inherits the server's full environment).
 *  3. Host credential reads in adapters (`os.homedir()`, `os.userInfo()`, provider key reads from
 *     `process.env`) that are not marked as legacy-only.
 *
 * Intentional, reviewed sites are marked in source:
 *   `// env-guard-reviewed: <reason>`   (1 and 2) on the same line or one of the 3 lines above
 *   `// auth-policy: host_fallback`     (3) on the same line or one of the 3 lines above; the code
 *                                        must only run when the policy is not enforced
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

const SPAWN_ROOTS = [
  path.join(repo, "packages/adapter-utils/src"),
  path.join(repo, "packages/paperclip-runner/src"),
  path.join(repo, "server/src"),
  ...adapterSrcDirs(),
];
const ADAPTER_ROOTS = adapterSrcDirs();

function adapterSrcDirs(): string[] {
  const base = path.join(repo, "packages/adapters");
  return readdirSync(base)
    .map((name) => path.join(base, name, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "coverage", "__tests__", "test-support", "fixtures"].includes(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !/\.test\.|\.spec\.|\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(repo, file).split(path.sep).join("/");
}

function markedNear(lines: string[], index: number, marker: RegExp): boolean {
  for (let i = Math.max(0, index - 3); i <= index; i += 1) if (marker.test(lines[i] ?? "")) return true;
  return false;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Text of the balanced `( ... )` that starts at `openIndex`, or null if unbalanced. */
function balancedArgs(text: string, openIndex: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}

// Shapes that put the server env INTO a child/env object. Plain default parameters
// (`env = process.env`) and read-only fallbacks are not leaks by themselves, so they are not flagged;
// `...process.env` and `env: process.env` are covered by the TECH-7076 guard.
const PROCESS_ENV_VALUE_SHAPES = [
  /\benv\s*:\s*[^,{}\n]*(?:\?\?|\|\|)\s*process\.env\b(?!\s*[.\[])/,
  /\.\.\.\s*\([^()\n]*(?:\?\?|\|\|)\s*process\.env\b(?!\s*[.\[])/,
  /\benv\s*:\s*\{\s*\.\.\.\s*process\.env\b/,
];

describe("TECH-7095 guard 1: no `env: x ?? process.env` fallbacks into a child env", () => {
  const files = SPAWN_ROOTS.flatMap((root) => listSourceFiles(root));

  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("finds `env: x ?? process.env` / `...(x ?? process.env)` only at reviewed sites", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!PROCESS_ENV_VALUE_SHAPES.some((re) => re.test(line))) return;
        if (markedNear(lines, i, /env-guard-reviewed:/)) return;
        offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `Use buildAgentChildBaseEnv() or mark a reviewed site with \`// env-guard-reviewed: <reason>\`:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("TECH-7095 guard 2: child_process calls name their env", () => {
  // Bare calls and namespace-import calls (`cp.spawn(`, `child_process.execFile(`).
  const CALL = /(?:(?<![\w.])|(?<=\b(?:cp|child_process|childProcess|nodeChildProcess)\.))(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\s*\(/g;

  it("every spawn/exec call has an explicit env argument or a reviewed marker", () => {
    const offenders: string[] = [];
    for (const file of SPAWN_ROOTS.flatMap((root) => listSourceFiles(root))) {
      const text = readFileSync(file, "utf8");
      if (!/from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)/.test(text)) continue;
      const lines = text.split("\n");
      let match: RegExpExecArray | null;
      CALL.lastIndex = 0;
      while ((match = CALL.exec(text)) !== null) {
        const open = match.index + match[0].length - 1;
        const lineNo = text.slice(0, match.index).split("\n").length;
        const lineText = lines[lineNo - 1] ?? "";
        if (isCommentLine(lineText)) continue;
        if (/^\s*(?:export\s+)?(?:async\s+)?function\b/.test(lineText)) continue;
        // Namespace-form calls inside the embedded probe script of execution-target.ts run INSIDE the
        // execution target (git rev-parse only), never on the server; editing that script text would
        // change a pinned probe, so it is exempted here rather than marked inline.
        if (rel(file) === "packages/adapter-utils/src/execution-target.ts" && /\bcp\.$/.test(text.slice(Math.max(0, match.index - 3), match.index))) continue;
        const args = balancedArgs(text, open);
        if (args === null) continue;
        if (/\benv\b/.test(args)) continue;
        if (markedNear(lines, lineNo - 1, /env-guard-reviewed:/)) continue;
        offenders.push(`${rel(file)}:${lineNo}: ${match[1]}(...) has no explicit env`);
      }
    }
    expect(
      offenders,
      `A spawn/exec without env inherits the server's full environment. Pass an explicit env, or mark with \`// env-guard-reviewed: <reason>\`:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("TECH-7095 guard 3: host credential reads in adapters are legacy-only", () => {
  const HOST_READS = [
    /\bos\.homedir\(\)/,
    /\bos\.userInfo\(\)/,
    /\bhomedir\(\)/,
    /process\.env\.(?:ANTHROPIC|OPENAI|CODEX|CLAUDE|XAI|GROK|GEMINI|GOOGLE|CURSOR|KIMI|OPENROUTER|OPENCLAW)_[A-Z0-9_]+/,
    /process\.env\[\s*["'`](?:ANTHROPIC|OPENAI|CODEX|CLAUDE|XAI|GROK|GEMINI|GOOGLE|CURSOR|KIMI|OPENROUTER|OPENCLAW)_/,
  ];

  it("every host credential/home read is marked `// auth-policy: host_fallback`", () => {
    const offenders: string[] = [];
    for (const file of ADAPTER_ROOTS.flatMap((root) => listSourceFiles(root))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!HOST_READS.some((re) => re.test(line))) return;
        if (markedNear(lines, i, /auth-policy:\s*host_fallback/)) return;
        offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `Host reads must be unreachable under managed_only. Gate them with the policy and mark \`// auth-policy: host_fallback\`:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

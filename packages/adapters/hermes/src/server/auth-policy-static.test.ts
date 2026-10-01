/**
 * TECH-7095 static guard: every host home/credential read left in the Hermes execute path must
 * be an explicitly annotated legacy (host_fallback) read.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["execute.ts", "mcp-config.ts", "skills.ts"];
const HOST_READ = /os\.homedir\(\)|os\.userInfo\(\)|process\.env\.(HOME|HERMES_HOME|USERPROFILE)\b|providerEnv\)/;
const ANNOTATION = "auth-policy: host_fallback";

describe("hermes host reads are annotated", () => {
  for (const file of FILES) {
    it(file, () => {
      const lines = fs.readFileSync(path.join(here, file), "utf8").split("\n");
      const offenders: string[] = [];
      lines.forEach((line, i) => {
        const code = line.replace(/^\s*(\*|\/\/).*$/, "");
        if (!HOST_READ.test(code)) return;
        if (line.includes(ANNOTATION) || (lines[i - 1] ?? "").includes(ANNOTATION)) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
      expect(offenders).toEqual([]);
    });
  }
});

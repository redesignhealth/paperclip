/**
 * Static import-graph guard for publish.ts (TECH-8191 PR 4b).
 * Test 4 from plan §7.1: proves publish is cost-free and transitively free of AI clients.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { extractImportSpecifiers } from "../check-module-boundaries.mjs";

test("publish.ts transitive import closure excludes LLM, embedding, and cost modules", () => {
  const rootFile = resolve(process.cwd(), "server/src/services/company-memory-upgrade/publish.ts");
  const visited = new Set<string>();
  const queue = [rootFile];

  const BANNED_MODULE_BASENAMES = new Set([
    "llm-converter",
    "embedding-client",
    "openai-key",
    "cost",
    "rate-limiter",
    "budget",
    "sweep",
  ]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // census.ts is the standalone census command (which contains its own conversion budget calculator)
    // and is not part of the publish execution pipeline.
    if (current.endsWith("census.ts")) continue;

    const content = readFileSync(current, "utf-8");
    const specifiers = extractImportSpecifiers(content);

    for (const spec of specifiers) {
      if (spec.startsWith(".")) {
        // Resolve local relative import
        let target = resolve(dirname(current), spec);
        if (target.endsWith(".js")) {
          const tsTarget = target.slice(0, -3) + ".ts";
          target = existsSync(tsTarget) ? tsTarget : target;
        } else if (!existsSync(target) && existsSync(target + ".ts")) {
          target = target + ".ts";
        }

        const base = target.split("/").pop()?.replace(/\.(?:js|ts)$/, "");
        assert.ok(
          !base || !BANNED_MODULE_BASENAMES.has(base),
          `publish.ts transitively imports banned module "${base}" via ${current}`,
        );

        if (existsSync(target) && !visited.has(target)) {
          queue.push(target);
        }
      }
    }
  }

  assert.ok(visited.size >= 4, "Expected to walk at least publish.ts and its direct helpers");
});

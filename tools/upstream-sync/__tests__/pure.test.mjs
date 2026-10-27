import test from "node:test";
import assert from "node:assert/strict";
import { buildForkOwnedMatcher, parseForkOwned, touchesMigrations } from "../lib/forkOwned.mjs";
import { extractPr, extractRevertSha, parseLog } from "../lib/upstreamGit.mjs";
import { heuristicClassify, parseLlmResponse } from "../lib/classify.mjs";
import { formatRowAlert } from "../lib/alerts.mjs";

const MD = `# x\n- `+"`ignored/before/marker.ts`"+`\n<!-- fork-owned:start -->\n## A\n- `+"`a/b.ts`"+` note\n- `+"`dir/`"+`\n- `+"`x/**/*.json`"+`\n* `+"`y/*.ts`"+`\nprose `+"`not-a-bullet`"+`\n`;

test("parseForkOwned reads bullets after the marker only", () => {
  assert.deepEqual(parseForkOwned(MD), ["a/b.ts", "dir/", "x/**/*.json", "y/*.ts"]);
});

test("fork-owned matcher: exact, dir, glob", () => {
  const m = buildForkOwnedMatcher(parseForkOwned(MD));
  assert.ok(m("a/b.ts"));
  assert.ok(!m("a/b.tsx"));
  assert.ok(m("dir/deep/file.ts"));
  assert.ok(m("x/p/q/z.json"));
  assert.ok(!m("x/p/q/z.ts"));
  assert.ok(m("y/f.ts"));
  assert.ok(!m("y/sub/f.ts"));
});

test("migrations/schema detection", () => {
  assert.ok(touchesMigrations(["packages/db/src/migrations/0400_x.sql"]));
  assert.ok(touchesMigrations(["packages/db/src/schema/issues.ts"]));
  assert.ok(!touchesMigrations(["packages/db/src/client.ts"]));
});

test("PR number and revert extraction", () => {
  assert.equal(extractPr("fix: thing (#123)"), 123);
  assert.equal(extractPr("Merge pull request #7 from a/b"), 7);
  assert.equal(extractPr("no pr here"), null);
  const sha = "a".repeat(40);
  assert.equal(extractRevertSha(`Revert "x"\n\nThis reverts commit ${sha}.`), sha);
});

test("parseLog splits records and files", () => {
  const RS = "\x1e", US = "\x1f";
  const out = `${RS}${"b".repeat(40)}${US}Ann${US}2026-10-27T00:00:00Z${US}feat: add y (#5)\n\nbody${US}\n\na.ts\nb.ts\n${RS}${"c".repeat(40)}${US}Bob${US}2026-10-27T01:00:00Z${US}fix: z (#6)${US}\n\nc.ts\n`;
  const c = parseLog(out);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0].files, ["a.ts", "b.ts"]);
  assert.equal(c[0].pr, 5);
  assert.equal(c[0].body, "body");
  assert.equal(c[1].author, "Bob");
});

test("heuristic classifier", () => {
  const f = (title, files = ["server/src/x.ts"]) => heuristicClassify({ title, body: "", files }).category;
  assert.equal(f("feat: add widgets (#1)"), "feature");
  assert.equal(f("fix(x): stop crash (#2)"), "fix");
  assert.equal(f("perf: faster list (#3)"), "perf");
  assert.equal(f("feat!: drop v1 api (#4)"), "breaking");
  assert.equal(f("fix: patch XSS in comments (#5)"), "security");
  assert.equal(f("ci: pin action (#6)", [".github/workflows/a.yml"]), "infra");
  assert.equal(f("fix: retained-source containment (#7)"), "fix"); // "source" must not match rce
});

test("LLM response parsing tolerates junk and invalid categories", () => {
  const batch = [{ sha: "1".repeat(40) }, { sha: "2".repeat(40) }];
  const txt = `ok {"results":[{"sha":"111111111","category":"fix","summary":"A"},{"sha":"222222222","category":"nonsense","summary":"B"}]}`;
  const r = parseLlmResponse(txt, batch);
  assert.deepEqual(r[0], { category: "fix", summary: "A" });
  assert.equal(r[1], null);
});

test("alert text contains summary, link and flags", () => {
  const a = formatRowAlert({ category: "feature", summary: "Does X", title: "Add X (#9)", upstream_pr: 9, upstream_sha: "d".repeat(40), fork_owned_hits: ["a"], touches_migrations: true, status: "pending" });
  assert.match(a.text, /NEW\] Does X/);
  assert.match(a.text, /pull\/9/);
  assert.match(a.text, /fork-owned/);
  assert.match(a.text, /migrations/);
});

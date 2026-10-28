import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// Resolve the CLI from this module rather than `process.cwd()`, so the child
// run works no matter where the spec is invoked from.
const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const repoRoot = path.resolve(import.meta.dirname, "../..");
// The child's fixture teardown budget is 120s (agent-chat.shared.ts) with a
// ~64s worst case, plus the body's own timeout and Playwright startup. Give
// the child roughly twice that, and make the outer test outlast the child so
// a stuck child surfaces as a child timeout rather than an outer one.
const CHILD_TIMEOUT_MS = 150_000;
const OUTER_TIMEOUT_MS = 170_000;

/**
 * Parses the child's JSON reporter output.
 *
 * Anything the child (or a loader/hook) writes to stdout before the report
 * would break a plain `JSON.parse`. Try each line that opens a JSON object and
 * keep only a parse that carries the reporter's `suites` marker, shrinking the
 * end so trailing noise is tolerated too.
 */
function parseReport(stdout: string) {
  const lines = stdout.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start].trimStart().startsWith("{")) continue;
    for (let end = lines.length; end > start; end -= 1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines.slice(start, end).join("\n"));
      } catch {
        continue;
      }
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { suites?: unknown }).suites))
        return parsed as { suites: any[] };
    }
  }
  throw new Error(`no Playwright JSON report on child stdout:\n${stdout}`);
}

// The timeout case has to run out a real body timeout before teardown starts.
test.setTimeout(OUTER_TIMEOUT_MS);

type Scenario = "timeout" | "combined" | "agent-create-failure" | "patch-response-failure";
for (const scenario of ["timeout", "combined", "agent-create-failure", "patch-response-failure"] as Scenario[])
test(`independent fixture teardown (${scenario})`, async () => {
  const combinedFailure = scenario === "combined";
  // Setup itself throws: the restore must already be registered, and the
  // setup error must remain the test's only (primary) error.
  const setupFailure = scenario === "agent-create-failure" || scenario === "patch-response-failure";
  const original = { enableAgentChat: false, enableClassicTaskInterface: true };
  let flags = { ...original };
  const patches: unknown[] = [];
  // Teardown order: the diagnostics snapshot must read the chat before the
  // experiment flags are restored, or the chat read 404s and its comments and
  // documents are silently dropped from the attachment.
  const order: string[] = [];
  const server = createServer(async (req, res) => {
    // Both body and teardown must carry the configured auth and stored cookie.
    if (req.headers.authorization !== "Bearer cleanup-test" || !req.headers.cookie?.includes("session=cleanup")) {
      res.writeHead(401).end(); return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let value: unknown = [];
    if (combinedFailure && req.url?.endsWith("/live-runs")) value = [{ id: "run" }];
    else if (combinedFailure && req.url?.endsWith("/cancel")) {
      res.writeHead(500).end("cancel lock timeout"); return;
    }
    else if (req.url === "/api/instance/settings/experimental") {
      if (req.method === "PATCH" && patches.length) order.push("restore");
      if (combinedFailure && req.method === "PATCH" && patches.length) {
        patches.push(JSON.parse(body));
        res.writeHead(503).end("restore unavailable"); return;
      }
      if (req.method === "PATCH") { flags = JSON.parse(body); patches.push(flags); }
      // The enabling PATCH is applied, but its response fails.
      if (scenario === "patch-response-failure" && req.method === "PATCH" && patches.length === 1) {
        res.writeHead(502).end("patch response failed"); return;
      }
      value = flags;
    } else if (req.url === "/api/companies") value = { id: "company", issuePrefix: "TEST" };
    else if (scenario === "agent-create-failure" && req.method === "POST" && req.url?.endsWith("/agents")) {
      res.writeHead(500).end("agent create failed"); return;
    }
    else if (req.method === "POST") value = { id: "agent" };
    else if (req.url?.includes("/chats/")) { order.push("snapshot"); value = null; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-cleanup-regression-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const config = path.join(dir, "playwright.config.cjs");
    await writeFile(config, `module.exports = ${JSON.stringify({
      testDir: path.resolve(import.meta.dirname, "fixtures"),
      testMatch: "agent-chat-cleanup-timeout.ts", workers: 1, retries: 0,
      reporter: "json", outputDir: path.join(dir, "results"),
      use: {
        baseURL: `http://127.0.0.1:${address.port}`,
        extraHTTPHeaders: { Authorization: "Bearer cleanup-test" },
        storageState: { cookies: [{ name: "session", value: "cleanup", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] },
      },
    })};`);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [playwrightCli, "test", "--config", config], {
        cwd: repoRoot,
        env: {
          ...process.env,
          // The fixture harness refuses to run without this opt-in.
          PAPERCLIP_CHAT_CLEANUP_HARNESS: "1",
          CHAT_CLEANUP_COMBINED_FAILURE: String(combinedFailure),
        },
        timeout: CHILD_TIMEOUT_MS,
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => stdout += chunk);
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.code, result.stderr).toBe(1);
    const report = parseReport(result.stdout);
    const childResult = report.suites[0].specs[0].tests[0].results[0];
    expect(childResult.status).toBe(scenario === "timeout" ? "timedOut" : "failed");
    expect(childResult.errors).toHaveLength(1);
    expect(childResult.errors[0].message).toContain({
      timeout: "timeout",
      combined: "original body failure",
      "agent-create-failure": "agent create failed",
      "patch-response-failure": "patch response failed",
    }[scenario]);
    const diagnostic = childResult.attachments.find((a: { name: string }) => a.name === "chat-cleanup-error");
    if (combinedFailure) {
      expect(diagnostic).toBeTruthy();
      const text = Buffer.from(diagnostic.body, "base64").toString();
      expect(text).toContain("500");
      expect(text).toContain("503");
      expect(text.indexOf("500")).toBeLessThan(text.indexOf("503"));
    } else {
      expect(diagnostic).toBeUndefined();
      expect(flags).toEqual(original);
    }
    expect(patches).toEqual([{ enableAgentChat: true, enableClassicTaskInterface: false }, original]);
    // A setup failure never registers diagnostics, so only the restore runs.
    expect(order).toEqual(setupFailure ? ["restore"] : ["snapshot", "restore"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

for (const combinedFailure of [false, true])
test(`independent fixture teardown after body failure (combined cleanup failure: ${combinedFailure})`, async () => {
  const original = { enableAgentChat: false, enableClassicTaskInterface: true };
  let flags = { ...original };
  const patches: unknown[] = [];
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
      if (combinedFailure && req.method === "PATCH" && patches.length) {
        patches.push(JSON.parse(body));
        res.writeHead(503).end("restore unavailable"); return;
      }
      if (req.method === "PATCH") { flags = JSON.parse(body); patches.push(flags); }
      value = flags;
    } else if (req.url === "/api/companies") value = { id: "company", issuePrefix: "TEST" };
    else if (req.method === "POST") value = { id: "agent" };
    else if (req.url?.includes("/chats/")) value = null;
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
      const child = spawn(process.execPath, [path.resolve("node_modules/@playwright/test/cli.js"), "test", "--config", config], { env: { ...process.env, CHAT_CLEANUP_COMBINED_FAILURE: String(combinedFailure) }, timeout: 30_000 });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => stdout += chunk);
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.code, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout);
    const childResult = report.suites[0].specs[0].tests[0].results[0];
    expect(childResult.status).toBe(combinedFailure ? "failed" : "timedOut");
    expect(childResult.errors).toHaveLength(1);
    expect(childResult.errors[0].message).toContain(combinedFailure ? "original body failure" : "timeout");
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
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

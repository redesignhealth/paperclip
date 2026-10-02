/**
 * TECH-7089 G2: the Paperclip-generated Hermes profile + REAL Hermes + ambient host secrets.
 *
 * Runs the real `execute()` (no mocked child) against the real `hermes` CLI with
 * PAPERCLIP_DEPLOYMENT_MODE=authenticated, a fake host HOME holding sentinel `~/.hermes` files and
 * sentinel ambient secrets in process.env. A stub OpenAI-compatible model makes Hermes run a
 * terminal command that dumps its own environment and the host files it can see; that output comes
 * back to the stub as a role:tool message, so we read exactly what an agent's terminal would see.
 *
 * Gated: needs a real hermes on PATH (the production image). Run via
 * server/src/__tests__/docker-hermes-isolation.test.ts or:
 *   docker run --rm -e PAPERCLIP_RUN_HERMES_G2=true <image> vitest run <this file>
 */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { RUN_HOME_PREFIX } from "@paperclipai/adapter-utils/run-home";
import { execute } from "./execute.js";

const RUN = process.env.PAPERCLIP_RUN_HERMES_G2 === "true";
const describeReal = RUN ? describe : describe.skip;

const AMBIENT: Record<string, string> = {
  ANTHROPIC_API_KEY: "SENTINEL-ambient-anthropic-7089",
  OPENAI_API_KEY: "SENTINEL-ambient-openai-7089",
  OPENROUTER_API_KEY: "SENTINEL-ambient-openrouter-7089",
  GH_TOKEN: "SENTINEL-ambient-gh-7089",
  GITHUB_TOKEN: "SENTINEL-ambient-github-7089",
  AWS_SECRET_ACCESS_KEY: "SENTINEL-ambient-aws-7089",
  DATABASE_URL: "postgres://SENTINEL-ambient-db-7089@db/x",
  BETTER_AUTH_SECRET: "SENTINEL-ambient-auth-7089",
  PAPERCLIP_SECRETS_MASTER_KEY: "SENTINEL-ambient-master-7089",
};
const HOST_FILES: Record<string, string> = {
  ".hermes/.env": "OPENAI_API_KEY=SENTINEL-host-dotenv-7089\n",
  ".hermes/auth.json": '{"token":"SENTINEL-host-auth-7089"}',
  ".config/gh/hosts.yml": "github.com:\n  oauth_token: SENTINEL-host-gh-7089\n",
  ".aws/credentials": "[default]\naws_secret_access_key=SENTINEL-host-aws-7089\n",
};
const EXPLICIT_KEY = "explicit-secret-ref-value-7089";
const SENTINELS = [...Object.values(AMBIENT).map((v) => v.split("@")[0].replace("postgres://", "")),
  "SENTINEL-host-config-7089", "SENTINEL-host-dotenv-7089", "SENTINEL-host-auth-7089", "SENTINEL-host-gh-7089", "SENTINEL-host-aws-7089"];

interface Seen { auth: string | undefined; body: any }
function startModel(onRequest: (seen: Seen) => any): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const reply = onRequest({ auth: req.headers.authorization, body });
      const model = body.model ?? "fixture-model";
      const chunk = (delta: any, finish: string | null = null) =>
        "data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
      const data = body.stream
        ? reply?.tool
          ? chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_g2_1", type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n"
          : chunk({ role: "assistant", content: "g2-done" }) + chunk({}, "stop") + "data: [DONE]\n\n"
        : JSON.stringify({ id: "x", object: "chat.completion", created: 0, model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "g2-done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}/v1`, server })));
}

describeReal("G2: isolated Hermes run against real hermes with ambient host secrets", () => {
  let hostHome: string;
  const saved: Record<string, string | undefined> = {};
  const servers: http.Server[] = [];

  beforeAll(async () => {
    hostHome = await fs.mkdtemp(path.join(os.tmpdir(), "g2-host-home-"));
    for (const [rel, content] of Object.entries(HOST_FILES)) {
      await fs.mkdir(path.dirname(path.join(hostHome, rel)), { recursive: true });
      await fs.writeFile(path.join(hostHome, rel), content);
    }
    for (const k of [...Object.keys(AMBIENT), "HOME", "PAPERCLIP_DEPLOYMENT_MODE", "PAPERCLIP_HERMES_HOST_ISOLATION"]) saved[k] = process.env[k];
    Object.assign(process.env, AMBIENT, { HOME: hostHome, PAPERCLIP_DEPLOYMENT_MODE: "authenticated" });
    delete process.env.PAPERCLIP_HERMES_HOST_ISOLATION;
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); })));
    await fs.rm(hostHome, { recursive: true, force: true });
  });

  it("agent terminal sees only the explicit credential and a per-run home", async () => {
    const hostSeen: Seen[] = [];
    const agentSeen: Seen[] = [];
    const host = await startModel((s) => { hostSeen.push(s); });
    servers.push(host.server);
    const agent = await startModel((s) => {
      agentSeen.push(s);
      const hasToolResult = s.body.messages?.some((m: any) => m.role === "tool");
      if (s.body.stream && s.body.tools?.length && !hasToolResult) {
        const files = [...Object.keys(HOST_FILES), ".hermes/config.yaml"].map((f) => `~/${f}`).join(" ");
        return { tool: "terminal", args: { command: `echo HOME=$HOME; env; cat ${files} 2>&1; ls -A ~ 2>&1` } };
      }
    });
    servers.push(agent.server);
    // The fake host's config points at the HOST model server: if isolation leaks, it gets hit.
    await fs.writeFile(path.join(hostHome, ".hermes/config.yaml"),
      `model:\n  default: host-model\n  provider: custom\n  base_url: ${host.url}\n  api_key: SENTINEL-host-config-7089\n`);

    const logs: string[] = [];
    const ctx = {
      runId: "g2-run-1",
      agent: { id: "agent-g2", companyId: "company-g2", name: "G2", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "hermes", timeoutSec: 120, graceSec: 2, model: "fixture-model", provider: "openrouter",
        env: { OPENROUTER_API_KEY: EXPLICIT_KEY, OPENROUTER_BASE_URL: agent.url },
      },
      context: { issueId: "issue-g2", wakeReason: "manual" },
      authToken: "paperclip-run-token",
      onLog: async (_s: string, c: string) => { logs.push(c); },
      onSpawn: async () => {},
    } as unknown as AdapterExecutionContext;

    const homesBefore = new Set((await fs.readdir(os.tmpdir())).filter((n) => n.startsWith(RUN_HOME_PREFIX)));
    const result = await execute(ctx);
    const toolResults = agentSeen.flatMap((s) => (s.body.messages ?? []).filter((m: any) => m.role === "tool"));
    const everything = JSON.stringify(toolResults) + logs.join("") + JSON.stringify(result);

    expect(result.exitCode, logs.join("")).toBe(0);
    expect(hostSeen, "host config model server must never be contacted").toHaveLength(0);
    expect(agentSeen.length, logs.join("")).toBeGreaterThan(0);
    expect(agentSeen.every((s) => s.auth === `Bearer ${EXPLICIT_KEY}`)).toBe(true);
    expect(toolResults.length, "terminal tool never ran").toBeGreaterThan(0);
    for (const sentinel of SENTINELS) expect(everything).not.toContain(sentinel);
    expect(JSON.stringify(toolResults)).toContain(RUN_HOME_PREFIX);
    expect(JSON.stringify(toolResults)).not.toContain(`HOME=${hostHome}`);
    // Only homes created by THIS run: others may belong to parallel tests or crashed servers.
    const created = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith(RUN_HOME_PREFIX) && !homesBefore.has(n));
    expect(created, "run home must be cleaned up").toEqual([]);
  }, 180_000);
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_MEMORY_TOOL_NAMES, buildPiMemoryTaskQuery, findPiMemoryRelayServer, piMemoryExtensionSource, resolvePiMemoryToolName } from "./memory-extension.js";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => Promise<unknown> | unknown;
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details: unknown }> };

interface Call { name: string; arguments: Record<string, unknown>; auth: string | undefined }

let server: http.Server;
let calls: Call[];
let initializes: number;
let respond: (call: Call) => { status?: number; result?: unknown; sse?: boolean };
let configDir: string;
let baseUrl: string;

const SEARCH_RESULTS = {
  results: [
    { id: "m1", memory: "Prefer pnpm filter builds over a full build.", score: 0.9 },
    { id: "m2", memory: "Lesson: rule SEC-12 in apps/api/src/auth.ts flagged by https://github.com/acme/repo/pull/42 (use parameterised queries).", score: 0.8, metadata: { pinned: true, kind: "lesson" } },
    { id: "m3", memory: "Prefer pnpm filter builds over a full build.", score: 0.7 },
    { id: "m4", memory: "Third.", score: 0.6 },
    { id: "m5", memory: "Fourth.", score: 0.5 },
    { id: "m6", memory: "Fifth.", score: 0.4 },
    { id: "m7", memory: "Sixth beyond top five.", score: 0.3 },
  ],
};

beforeEach(async () => {
  calls = [];
  initializes = 0;
  respond = (call) => ({ result: { content: [{ type: "text", text: JSON.stringify(call.name === "memory_search" ? SEARCH_RESULTS : { results: [{ id: "n1", memory: "saved", event: "ADD" }] }) }] } });
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
      const auth = req.headers.authorization;
      if (message.method === "initialize") {
        initializes += 1;
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
        return;
      }
      if (message.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      const call: Call = { name: message.params!.name, arguments: message.params!.arguments, auth };
      calls.push(call);
      const reply = respond(call);
      if (reply.status) { res.writeHead(reply.status); res.end(); return; }
      const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: reply.result });
      if (reply.sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("event: message\ndata: " + payload + "\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configDir = await mkdtemp(path.join(os.tmpdir(), "pi-memory-ext-"));
  process.env.PI_CODING_AGENT_DIR = configDir;
  process.env.TEST_RELAY_URL = baseUrl;
  process.env.TEST_BRIDGE_TOKEN = "bridge-token";
  await writeMcpJson({
    rh_agent_memory_tools: {
      url: "${TEST_RELAY_URL}/paperclip-relay/mcp/rh_agent_memory_tools",
      headers: { Authorization: "Bearer ${TEST_BRIDGE_TOKEN}" },
      includeTools: ["memory_search", "memory_add", "memory_delete"],
    },
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configDir, { recursive: true, force: true });
  for (const name of ["PI_CODING_AGENT_DIR", "TEST_RELAY_URL", "TEST_BRIDGE_TOKEN", "RH_MEMORY_CAPTURE", "RH_MEMORY_TOP_K", "RH_MEMORY_RECALL_TIMEOUT"]) delete process.env[name];
  vi.restoreAllMocks();
});

async function writeMcpJson(mcpServers: Record<string, unknown>) {
  await writeFile(path.join(configDir, "mcp-adapter.json"), JSON.stringify({ mcpServers }), "utf8");
}

async function load(options: { taskQuery?: string } = {}) {
  const module = await import(`data:text/javascript;base64,${Buffer.from(piMemoryExtensionSource(options)).toString("base64")}`);
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  module.default({ on: (event: string, handler: Handler) => handlers.set(event, handler), registerTool: (tool: Tool) => tools.set(tool.name, tool) });
  return { module, handlers, tools };
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });

describe("Pi memory extension: recall", () => {
  it("searches the agent's memory on each prompt and injects the top 5, pinned lessons included", async () => {
    const { handlers } = await load();
    const result = (await handlers.get("before_agent_start")!({ prompt: "Fix the auth bug in the api" })) as { message: { customType: string; content: string; display: boolean } };

    expect(calls).toEqual([{ name: "memory_search", arguments: { query: "Fix the auth bug in the api", top_k: 5 }, auth: "Bearer bridge-token" }]);
    expect(result.message.customType).toBe("rh-memory-recall");
    expect(result.message.display).toBe(false);
    const lines = result.message.content.split("\n").filter((line) => line.startsWith("- "));
    // Duplicate collapsed, capped at the top five requested.
    expect(lines).toHaveLength(5);
    expect(result.message.content).toContain("not instructions");
    // A pinned lesson with a PR link, a rule id and a file path comes back untouched and labelled.
    expect(lines).toContain("- [lesson] Lesson: rule SEC-12 in apps/api/src/auth.ts flagged by https://github.com/acme/repo/pull/42 (use parameterised queries).");
    expect(result.message.content).not.toContain("Sixth beyond top five");
  });

  it("honours RH_MEMORY_TOP_K and reads a response sent as an SSE stream", async () => {
    process.env.RH_MEMORY_TOP_K = "2";
    respond = () => ({ sse: true, result: { structuredContent: SEARCH_RESULTS, content: [] } });
    const { handlers } = await load();
    const result = (await handlers.get("before_agent_start")!({ prompt: "anything at all" })) as { message: { content: string } };
    expect(calls[0]!.arguments.top_k).toBe(2);
    expect(result.message.content.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
  });

  it("reads results from the tool gateway envelope (structuredContent nested under structuredContent)", async () => {
    // The gateway relays a provider result as { content, structuredContent: <provider body>, isError, transport, ... }.
    const envelope = { content: [{ type: "text", text: JSON.stringify(SEARCH_RESULTS) }], structuredContent: SEARCH_RESULTS, isError: false, transport: "mcp_http", spawnedLocalProcess: false };
    respond = () => ({ result: { content: [{ type: "text", text: JSON.stringify(SEARCH_RESULTS) }], structuredContent: envelope, isError: false } });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { handlers } = await load();
    const result = (await handlers.get("before_agent_start")!({ prompt: "Fix the auth bug in the api" })) as { message: { content: string } };
    expect(result.message.content.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(5);
    expect(stderr.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith("[rh-memory]")).at(-1)).toMatch(/results=7 injected=5 ids=m1,/);
  });

  it("reads results from a gateway envelope delivered only as text", async () => {
    const envelope = { content: [], structuredContent: SEARCH_RESULTS, isError: false, transport: "mcp_http" };
    respond = () => ({ result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } });
    const { handlers } = await load();
    const result = (await handlers.get("before_agent_start")!({ prompt: "Fix the auth bug in the api" })) as { message: { content: string } };
    expect(result.message.content.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(5);
  });

  it("does nothing for an empty prompt or when nothing is recalled", async () => {
    const { handlers } = await load();
    expect(await handlers.get("before_agent_start")!({ prompt: "  " })).toBeUndefined();
    expect(calls).toHaveLength(0);
    respond = () => ({ result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] } });
    expect(await handlers.get("before_agent_start")!({ prompt: "no memories yet" })).toBeUndefined();
  });

  it("reuses one MCP session for the run", async () => {
    const { handlers } = await load();
    await handlers.get("before_agent_start")!({ prompt: "first prompt" });
    await handlers.get("before_agent_start")!({ prompt: "second prompt" });
    expect(initializes).toBe(1);
    expect(calls).toHaveLength(2);
  });
});

describe("Pi memory extension: capture", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "You were woken by Paperclip wake abc.\nPAPERCLIP_RUN_ID=run-1\nFix the flaky retry test in packages/queue." }] },
    assistant("Calling tools."),
    { role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
    assistant("Fixed the flaky retry test by awaiting the timer flush in packages/queue/retry.test.ts.\nToken: sk-abcdefghijklmnopqrstuvwxyz123456\nRun id 8812 finished.\nLesson: always flush fake timers before asserting retries."),
  ];

  it("stores the cleaned task and outcome with memory_add at the end of a turn", async () => {
    const { handlers } = await load();
    await handlers.get("agent_end")!({ messages });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("memory_add");
    const text = calls[0]!.arguments.text as string;
    expect(text).toContain("Task: Fix the flaky retry test in packages/queue.");
    expect(text).toContain("Lesson: always flush fake timers before asserting retries.");
    expect(text).toContain("Fixed the flaky retry test");
    // No secret, wake boilerplate or run id survives.
    expect(text).not.toMatch(/sk-abc|woken|PAPERCLIP_|Run id|Token:/);
  });

  it("never sends memory_add text longer than the memory server accepts (2000 characters)", async () => {
    const longTask = "Investigate the failing deployment pipeline and report back. ".repeat(60);
    const longOutcome = "Traced the failure to a stale cache entry and cleared it before the rerun. ".repeat(120);
    const { handlers } = await load();
    await handlers.get("agent_end")!({ messages: [
      { role: "user", content: [{ type: "text", text: longTask }] },
      assistant(longOutcome),
    ] });
    expect(calls).toHaveLength(1);
    const text = calls[0]!.arguments.text as string;
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text).toMatch(/^Task: /);
    expect(text).toContain("Outcome: ");
  });

  it("is on by default and off for RH_MEMORY_CAPTURE=off", async () => {
    process.env.RH_MEMORY_CAPTURE = "off";
    const { handlers } = await load();
    await handlers.get("agent_end")!({ messages });
    expect(calls).toHaveLength(0);
  });

  it("skips a turn with no useful outcome, an error stop, or only junk", async () => {
    const { handlers } = await load();
    await handlers.get("agent_end")!({ messages: [{ role: "user", content: "hello there" }, assistant("ok")] });
    await handlers.get("agent_end")!({ messages: [{ role: "user", content: "do it" }, assistant("A long enough outcome that would be kept otherwise, really.", { stopReason: "error" })] });
    await handlers.get("agent_end")!({ messages: [{ role: "user", content: "do it" }, assistant("PAPERCLIP_RUN_ID=abc and the api_key: supersecretvalue1234 for the wake heartbeat procedure")] });
    await handlers.get("agent_end")!({ messages: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("Pi memory extension: tools", () => {
  it("registers explicit search, add and delete tools that call the memory server", async () => {
    const { tools } = await load();
    expect([...tools.keys()].sort()).toEqual([...PI_MEMORY_TOOL_NAMES].sort());
    const search = await tools.get("memory_search")!.execute("t1", { query: "retries" });
    expect(JSON.parse(search.content[0]!.text).results).toHaveLength(7);
    await tools.get("memory_add")!.execute("t2", { text: "Lesson: flush timers." });
    await tools.get("memory_delete")!.execute("t3", { memory_id: "abc" });
    expect(calls.map((call) => [call.name, call.arguments])).toEqual([
      ["memory_search", { query: "retries", top_k: 5 }],
      ["memory_add", { text: "Lesson: flush timers." }],
      ["memory_delete", { memory_id: "abc" }],
    ]);
  });
});

describe("Pi memory extension: failure path", () => {
  it("fails open and warns when the memory service answers with an error", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    respond = () => ({ status: 503 });
    const { handlers, tools } = await load();
    expect(await handlers.get("before_agent_start")!({ prompt: "needs memory" })).toBeUndefined();
    await expect(handlers.get("agent_end")!({ messages: [{ role: "user", content: "task" }, assistant("A sufficiently long outcome that would normally be stored.")] })).resolves.toBeUndefined();
    const tool = await tools.get("memory_search")!.execute("t", { query: "x" });
    expect(tool.content[0]!.text).toContain("Memory service unavailable");
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toMatch(/\[rh-memory\] recall failed: Error: http 503 query="needs memory"/);
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toMatch(/capture failed: Error: http 503/);
  });

  it("fails open when the service is unreachable or slow", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.RH_MEMORY_RECALL_TIMEOUT = "0.2";
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { handlers } = await load();
    expect(await handlers.get("before_agent_start")!({ prompt: "needs memory" })).toBeUndefined();
    expect(stderr).toHaveBeenCalled();
    server = http.createServer(() => undefined); // so afterEach can close something
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  it("is inert when mcp-adapter.json has no memory server or a missing variable", async () => {
    await writeMcpJson({ comms: { url: "${TEST_RELAY_URL}/x", includeTools: ["inbox"] } });
    const inert = await load();
    expect(inert.handlers.size).toBe(0);
    expect(inert.tools.size).toBe(0);
    await writeMcpJson({ mem: { url: "${NOT_SET_ANYWHERE}/x", includeTools: ["memory_search"] } });
    expect((await load()).handlers.size).toBe(0);
    await rm(path.join(configDir, "mcp-adapter.json"));
    expect((await load()).handlers.size).toBe(0);
  });
});

describe("findPiMemoryRelayServer", () => {
  it("finds the relay server that allows memory_search", () => {
    const make = (key: string, allowedTools: string[]) => ({ key, server: { name: key, url: "u", token: "t", connectionId: "c", allowedTools } });
    expect(findPiMemoryRelayServer([make("comms", ["inbox"]), make("mem", ["memory_search", "memory_add"])])?.key).toBe("mem");
    expect(findPiMemoryRelayServer([make("comms", ["inbox"])])).toBeNull();
  });
});

// Pods get the agent's assigned MCP connections through one gateway server, whose tool names are namespaced and hyphenated.
const GATEWAY_TOOLS = [
  "mcp.app-gallery-linear-43e589c0:save-comment",
  "mcp.rh-agent-memory-tools-2d639e79:memory-add",
  "mcp.rh-agent-memory-tools-2d639e79:memory-delete",
  "mcp.rh-agent-memory-tools-2d639e79:memory-search",
];

describe("memory tools behind the gateway's namespaced names", () => {
  it("resolves the memory tools from gateway names, bare names and collision suffixes", () => {
    expect(resolvePiMemoryToolName(GATEWAY_TOOLS, "memory_search")).toBe("mcp.rh-agent-memory-tools-2d639e79:memory-search");
    expect(resolvePiMemoryToolName(GATEWAY_TOOLS, "memory_add")).toBe("mcp.rh-agent-memory-tools-2d639e79:memory-add");
    expect(resolvePiMemoryToolName(["memory_search", "memory-search"], "memory_search")).toBe("memory_search");
    expect(resolvePiMemoryToolName(["mcp.mem-1234abcd:memory-search-0a1b2c3d"], "memory_search")).toBe("mcp.mem-1234abcd:memory-search-0a1b2c3d");
    expect(resolvePiMemoryToolName(["mcp.x:memory-search-extra", "mcp.x:recall-memory-search"], "memory_search")).toBeNull();
    expect(resolvePiMemoryToolName(["mcp.x:save-comment"], "memory_delete")).toBeNull();
  });

  it("finds the gateway server that lists a namespaced memory tool", () => {
    const make = (key: string, allowedTools: string[]) => ({ key, server: { name: key, url: "u", token: "t", connectionId: "c", allowedTools } });
    expect(findPiMemoryRelayServer([make("paperclip_assigned", GATEWAY_TOOLS)])?.key).toBe("paperclip_assigned");
    expect(findPiMemoryRelayServer([make("paperclip_assigned", ["mcp.app-gallery-linear-43e589c0:save-comment"])])).toBeNull();
  });

  it("recalls, captures and runs the tools through the namespaced upstream names", async () => {
    await writeMcpJson({
      paperclip_assigned: {
        url: "${TEST_RELAY_URL}/paperclip-relay/mcp/paperclip_assigned",
        headers: { Authorization: "Bearer ${TEST_BRIDGE_TOKEN}" },
        includeTools: GATEWAY_TOOLS,
      },
    });
    const search = GATEWAY_TOOLS[3]!;
    respond = (call) => ({ result: { content: [{ type: "text", text: JSON.stringify(call.name === search ? SEARCH_RESULTS : { results: [{ id: "n1", memory: "saved", event: "ADD" }] }) }] } });
    const { handlers, tools } = await load();
    const recalled = (await handlers.get("before_agent_start")!({ prompt: "Fix the auth bug in the api" })) as { message: { content: string } };
    expect(recalled.message.content).toContain("Prefer pnpm filter builds");
    await handlers.get("agent_end")!({ messages: [{ role: "user", content: "task" }, assistant("A sufficiently long outcome that would normally be stored.")] });
    await tools.get("memory_delete")!.execute("t", { memory_id: "abc" });
    expect(calls.map((call) => call.name)).toEqual([search, GATEWAY_TOOLS[1], GATEWAY_TOOLS[2]]);
  });

  it("registers only the tools the server allows", async () => {
    await writeMcpJson({ mem: { url: "${TEST_RELAY_URL}/x", includeTools: ["mcp.m-1:memory-search"] } });
    const { handlers, tools } = await load();
    expect([...tools.keys()]).toEqual(["memory_search"]);
    await handlers.get("agent_end")!({ messages: [{ role: "user", content: "task" }, assistant("A sufficiently long outcome that would normally be stored.")] });
    expect(calls).toEqual([]);
  });
});

describe("Pi memory extension: log lines for scoring recall", () => {
  const lines = (stderr: { mock: { calls: unknown[][] } }) => stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[rh-memory]"));

  it("logs what was loaded and one recall line per prompt with the query, counts and top ids", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { handlers } = await load();
    await handlers.get("before_agent_start")!({ prompt: "Fix the\nauth bug   in the api" });
    expect(lines(stderr)).toEqual([
      "[rh-memory] loaded: search=memory_search add=memory_add delete=memory_delete\n",
      // m3 repeats m1's text, so 7 results become 5 injected lines; ids and scores cover every returned result, in order
      '[rh-memory] recall query="Fix the auth bug in the api" results=7 injected=5 ids=m1,m2,m3,m4,m5,m6,m7 scores=0.9,0.8,0.7,0.6,0.5,0.4,0.3\n',
    ]);
  });

  it("logs ids and scores per result, with a placeholder for a missing score, and never the memory text", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    respond = () => ({ result: { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "a1", memory: "SECRET MEMORY TEXT one", score: 0.123456 }, { memory_id: "a2", memory: "SECRET MEMORY TEXT two" }, { id: "a3", memory: "SECRET MEMORY TEXT three", score: "high" }] }) }] } });
    const { handlers } = await load();
    await handlers.get("before_agent_start")!({ prompt: "Fix the retry bug" });
    const line = lines(stderr).at(-1)!;
    expect(line).toBe('[rh-memory] recall query="Fix the retry bug" results=3 injected=3 ids=a1,a2,a3 scores=0.123,?,?\n');
    expect(line).not.toContain("SECRET");
  });

  it("logs zero results, a short prompt and a bounded query", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    respond = () => ({ result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] } });
    const { handlers } = await load();
    expect(await handlers.get("before_agent_start")!({ prompt: "x" })).toBeUndefined();
    expect(await handlers.get("before_agent_start")!({ prompt: "a".repeat(500) })).toBeUndefined();
    const out = lines(stderr);
    expect(out).toContain("[rh-memory] recall skipped: prompt too short\n");
    expect(out.at(-1)).toBe(`[rh-memory] recall query="${"a".repeat(200)}..." results=0 injected=0 ids= scores=\n`);
    expect(calls).toHaveLength(1);
  });

  it("names the failure on an error line that carries the query, and logs a stored capture", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    respond = () => ({ result: { isError: true, content: [{ type: "text", text: "boom" }] } });
    const { handlers } = await load();
    await handlers.get("before_agent_start")!({ prompt: "needs memory" });
    expect(lines(stderr).at(-1)).toBe('[rh-memory] recall failed: Error: tool error query="needs memory"\n');
    respond = () => ({ result: { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "n1", memory: "saved", event: "ADD" }] }) }] } });
    await handlers.get("agent_end")!({ messages: [{ role: "user", content: "task" }, assistant("A sufficiently long outcome that would normally be stored.")] });
    expect(stderr.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith("[rh-memory]")).at(-1)).toMatch(/^\[rh-memory\] capture stored chars=\d+\n$/);
    await handlers.get("agent_end")!({ messages: [] });
    expect(lines(stderr).at(-1)).toBe("[rh-memory] capture skipped: nothing worth storing\n");
  });

  it("keeps secrets and non-client error text out of the lines", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    respond = () => ({ result: { content: [{ type: "text", text: "not json" }] } });
    const { handlers } = await load();
    await handlers.get("before_agent_start")!({ prompt: "api_key: abcdef123456\nFix the retry bug" });
    const line = lines(stderr).at(-1)!;
    expect(line).toBe('[rh-memory] recall query="Fix the retry bug" results=0 injected=0 ids= scores=\n');
    respond = () => ({ result: { content: [{ type: "text", text: "x" }], isError: true } });
    await handlers.get("before_agent_start")!({ prompt: "Fix the retry bug" });
    expect(lines(stderr).at(-1)).toBe('[rh-memory] recall failed: Error: tool error query="Fix the retry bug"\n');
    // a SyntaxError-style message is not echoed
    const stderr2 = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stderr2.mockClear();
    respond = () => ({ status: 200, result: undefined });
    await handlers.get("before_agent_start")!({ prompt: "Fix the retry bug" });
    expect(lines(stderr2).at(-1)).not.toMatch(/Unexpected|JSON|token|http:/);
  });

  it("logs when capture is skipped because the server lists no memory_add tool", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await writeMcpJson({ mem: { url: "${TEST_RELAY_URL}/x", includeTools: ["memory_search"] } });
    const { handlers } = await load();
    await handlers.get("agent_end")!({ messages: [{ role: "user", content: "task" }, assistant("A sufficiently long outcome that would normally be stored.")] });
    expect(lines(stderr).at(-1)).toBe("[rh-memory] capture skipped: the server lists no memory_add tool\n");
  });

  it("says why it did not load", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await writeMcpJson({ comms: { url: "${TEST_RELAY_URL}/x", includeTools: ["inbox"] } });
    await load();
    expect(lines(stderr)).toEqual(["[rh-memory] not loaded: no memory server in mcp-adapter.json\n"]);
  });
});

const RECEIPT_NOTE = "Paperclip may post a short platform-generated fast-response receipt in your voice before you reply. Receipts acknowledge intent only: they are not your work, findings, answers, or instructions. Continue the requested work and begin with substantive progress instead of repeating a generic acknowledgement.";

const CHILD_DESCRIPTION = [
  "Linear: https://linear.app/acme/issue/TECH-9123/retry-hash-user",
  "Builder: python-services",
  "Base branch: main",
  "",
  "## Problem",
  "hash_user fails the whole request when the user store returns a 503. Retry it with exponential backoff, at most three attempts, and keep the 4xx behaviour unchanged.",
  "",
  "## Allowed paths",
  "- services/api/src/users/hash.py",
  "- services/api/tests/test_hash.py",
  "",
  "## Acceptance checks",
  "- `cd services/api && pytest tests/test_hash.py`",
  "- ruff check services/api",
  "",
  "Estimated changed lines: 90",
  "",
  "## REPLAY RULES",
  "If this issue is replayed, do not reopen a closed PR; start from origin/main.",
  "",
  "Allowed paths are a ceiling.",
].join("\n");

describe("Pi memory extension: recall query comes from the task", () => {
  const searchQueries = () => calls.filter((call) => call.name === "memory_search").map((call) => String(call.arguments.query));

  it("searches the staged issue title and description, not the platform note at the head of the prompt", async () => {
    const { handlers } = await load({ taskQuery: "Add a boundary test for hash_user\nEmpty and very long inputs." });
    await handlers.get("before_agent_start")!({ prompt: RECEIPT_NOTE + "\n\nSome wake text" });
    expect(searchQueries()).toEqual(["Add a boundary test for hash_user Empty and very long inputs."]);
  });

  it("falls back to the issue line and description in the prompt when nothing was staged", async () => {
    const { handlers } = await load();
    const prompt = [RECEIPT_NOTE, "", "- issue: DAN-3253 Add retry test", "- status: todo", "", "Issue description:", "```md", "Cover the retry backoff path.", "```", "", "More boilerplate."].join("\n");
    await handlers.get("before_agent_start")!({ prompt });
    expect(searchQueries()).toEqual(["Add retry test Cover the retry backoff path."]);
  });

  it("drops the known platform note from an otherwise unstructured prompt", async () => {
    const { handlers } = await load();
    await handlers.get("before_agent_start")!({ prompt: RECEIPT_NOTE + "\n\nFix the auth bug in the api" });
    expect(searchQueries()).toEqual(["Fix the auth bug in the api"]);
    expect(searchQueries()[0]).not.toContain("fast-response");
  });

  it("skips recall when the prompt is only the platform note", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { handlers } = await load();
    expect(await handlers.get("before_agent_start")!({ prompt: RECEIPT_NOTE })).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(stderr.mock.calls.map(([line]) => String(line))).toContain("[rh-memory] recall skipped: no task text in the prompt\n");
  });

  it("bounds the staged query", async () => {
    const { handlers } = await load({ taskQuery: "a".repeat(5000) });
    await handlers.get("before_agent_start")!({ prompt: "anything at all" });
    expect(searchQueries()[0]).toHaveLength(300);
  });

  it("shortens a long ticket to the title plus the start of the description, without URLs, links, code or extra whitespace", async () => {
    const description = [
      "See [the design doc](https://docs.example.com/d/abc) and https://github.com/acme/repo/pull/42 for context.",
      "```ts",
      "const noisy = codeThatShouldNotBeSearched();",
      "```",
      "The retry backoff   never   resets after a success.",
      "x".repeat(2000),
    ].join("\n");
    const { handlers } = await load({ taskQuery: "Fix retry backoff\n" + description });
    await handlers.get("before_agent_start")!({ prompt: "anything at all" });
    const query = searchQueries()[0]!;
    expect(query.startsWith("Fix retry backoff See the design doc and for context. The retry backoff never resets after a success.")).toBe(true);
    expect(query).not.toMatch(/https?:|\]\(|noisy|codeThatShouldNotBeSearched|\n|\s{2}/);
    expect(query.length).toBeLessThanOrEqual(300);
  });

  it("stages the issue title on the first line and the bounded raw description after it", () => {
    expect(buildPiMemoryTaskQuery({ issue: { title: " Fix  retry ", description: "Backoff is wrong.\r\nSecond line.\n" } })).toBe("Fix retry\nBackoff is wrong.\nSecond line.");
    expect(buildPiMemoryTaskQuery({ issue: { title: "Only title", description: null } })).toBe("Only title");
    expect(buildPiMemoryTaskQuery({ issue: { title: "t".repeat(3000) } })).toHaveLength(300);
    expect(buildPiMemoryTaskQuery({ issue: { title: "t", description: "d".repeat(9000) } })).toHaveLength(2 + 6000);
    expect(buildPiMemoryTaskQuery(undefined)).toBe("");
    expect(buildPiMemoryTaskQuery({})).toBe("");
  });

  it("builds a task-only query from a realistic planner child issue", async () => {
    const wake = { issue: { title: "[python-services] TECH-9123: Retry hash_user lookups on transient 503", description: CHILD_DESCRIPTION } };
    const { handlers } = await load({ taskQuery: buildPiMemoryTaskQuery(wake) });
    await handlers.get("before_agent_start")!({ prompt: "anything at all" });
    const query = searchQueries()[0]!;
    expect(query).toBe("Retry hash_user lookups on transient 503 hash_user fails the whole request when the user store returns a 503. Retry it with exponential backoff, at most three attempts, and keep the 4xx behaviour unchanged.");
    expect(query).not.toMatch(/Linear|Builder|Allowed|Estimated|REPLAY|Base branch|TECH-|python-services|services\/|pytest|ceiling/i);
    expect(query.length).toBeLessThanOrEqual(300);
  });

  it("uses the first plain paragraph when the child has no Problem or Change section", async () => {
    const description = ["Linear: https://linear.app/acme/issue/TECH-9124/x", "Builder: python-services", "Base branch: main", "", "Allowed paths:", "- services/api/src/auth.py", "- services/api/tests/test_auth.py", "", "Token refresh races when two requests refresh at once; serialise the refresh.", "", "Estimated changed lines: 80", "Allowed paths are a ceiling."].join("\n");
    const { handlers } = await load({ taskQuery: buildPiMemoryTaskQuery({ issue: { title: "Fix refresh race", description } }) });
    await handlers.get("before_agent_start")!({ prompt: "anything at all" });
    expect(searchQueries()).toEqual(["Fix refresh race Token refresh races when two requests refresh at once; serialise the refresh."]);
  });

  it("keeps technical tokens and prose notes, and stops at blank lines after metadata lists", async () => {
    const description = ["Builder: python-services", "Allowed paths:", "- services/a/b.py", "", "Fix UTF-8 decoding in the SHA-256 hasher.", "", "Note: keep the public API unchanged.", "", "Acceptance criteria:", "Run the hasher tests and ruff."].join("\n");
    const { handlers } = await load({ taskQuery: buildPiMemoryTaskQuery({ issue: { title: "Hasher bug", description } }) });
    await handlers.get("before_agent_start")!({ prompt: "anything at all" });
    expect(searchQueries()).toEqual(["Hasher bug Fix UTF-8 decoding in the SHA-256 hasher."]);
  });

  it("drops the planner's Routing line from the recall query", async () => {
    const description = ["Routing: python-services because the change is in rh-data-platform under services/* (target:rh-data-platform, Routing rule 2); it is a test-only change.", "Builder: python-services", "", "Add one parametrized test pinning try_resolve_email on non-string and falsy claim values."].join("\n");
    const { handlers } = await load({ taskQuery: buildPiMemoryTaskQuery({ issue: { title: "pin try_resolve_email for non-string and falsy claim values (test only)", description } }) });
    await handlers.get("before_agent_start")!({ prompt: "anything at all" });
    const query = searchQueries()[0]!;
    expect(query).toBe("pin try_resolve_email for non-string and falsy claim values (test only) Add one parametrized test pinning try_resolve_email on non-string and falsy claim values.");
    expect(query).not.toMatch(/Routing|because|python-services/);
  });

  it("drops a bold Routing line and keeps the plain paragraph under it", async () => {
    const description = ["**Routing:** data-pipeline because the change is under redesign-health-data/projects.", "Backfill the foo table for November."].join("\n");
    const { handlers } = await load({ taskQuery: buildPiMemoryTaskQuery({ issue: { title: "Backfill foo", description } }) });
    await handlers.get("before_agent_start")!({ prompt: "anything at all" });
    expect(searchQueries()).toEqual(["Backfill foo Backfill the foo table for November."]);
  });

  it("falls back to the title alone when the description is only metadata", async () => {
    const description = ["Linear: https://linear.app/acme/issue/TECH-9125/x", "Builder: data-pipelines", "Allowed paths: redesign-health-data/projects/x/y.py", "Estimated changed lines: 40", "Allowed paths are a ceiling."].join("\n");
    const { handlers } = await load({ taskQuery: buildPiMemoryTaskQuery({ issue: { title: "TECH-9125 Backfill the foo table", description } }) });
    await handlers.get("before_agent_start")!({ prompt: "anything at all" });
    expect(searchQueries()).toEqual(["Backfill the foo table"]);
  });

  it("strips the same boilerplate from an issue description found in the prompt", async () => {
    const { handlers } = await load();
    const prompt = ["- issue: [python-services] TECH-9123: Retry hash_user lookups", "", "Issue description:", "```md", CHILD_DESCRIPTION, "```"].join("\n");
    await handlers.get("before_agent_start")!({ prompt });
    expect(searchQueries()[0]).toMatch(/^Retry hash_user lookups hash_user fails the whole request/);
    expect(searchQueries()[0]).not.toMatch(/Builder|Allowed|Estimated|REPLAY|TECH-/);
  });
});

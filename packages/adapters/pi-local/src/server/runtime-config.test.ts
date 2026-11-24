import { PI_MCP_CONFIG_FILE } from "./mcp-config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pointRelayedProvidersAtBridge, preparePiRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function readModelsJson(agentConfigDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentConfigDir, "models.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("preparePiRuntimeConfig", () => {
  it("attributes OpenRouter aliases and model overrides while preserving routing and other providers", async () => {
    const other = { baseUrl: "https://other.example/v1", headers: { "X-Title": "Other" } };
    const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({
      router: {
        baseUrl: "https://openrouter.ai/api/v1", apiKey: "fixture-key",
        headers: { "http-referer": "https://pi.example", "X-Route": "selected" },
        modelOverrides: { model: { headers: { "x-title": "Pi" } } },
      }, other, openrouter: other,
    }) } });
    cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
    const { providers } = await readModelsJson(prepared.env.PI_CODING_AGENT_DIR) as { providers: Record<string, any> };
    expect(providers.router).toMatchObject({ apiKey: "fixture-key", headers: { "HTTP-Referer": "https://paperclip.ing", "X-Route": "selected" } });
    expect(providers.router.headers).not.toHaveProperty("http-referer");
    expect(providers.router.modelOverrides.model.headers["X-Title"]).toBe("Paperclip");
    expect(providers.router.modelOverrides.model.headers).not.toHaveProperty("x-title");
    expect(providers.other).toEqual(other);
    expect(providers.openrouter).toEqual(other);
    await prepared.cleanup();
  });

  it("writes only mcp-adapter.json into a managed dir when there are no providers", async () => {
    const mcpConfig = { mcpServers: { argus: { url: "${PAPERCLIP_API_URL}/paperclip-relay/mcp/argus" } } };
    const prepared = await preparePiRuntimeConfig({ env: { FOO: "bar" }, mcpConfig });
    cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
    expect(prepared.agentConfigDir).toBe(prepared.env.PI_CODING_AGENT_DIR);
    expect(JSON.parse(await fs.readFile(path.join(prepared.agentConfigDir!, "mcp-adapter.json"), "utf8"))).toEqual(mcpConfig);
    await expect(fs.access(path.join(prepared.agentConfigDir!, "models.json"))).rejects.toThrow();
    await prepared.cleanup();
  });

  it("writes the MCP config under the name pi-mcp-adapter 7.x reads, not mcp.json (TECH-10096)", async () => {
    const prepared = await preparePiRuntimeConfig({ env: {}, mcpConfig: { mcpServers: {} } });
    cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
    expect(PI_MCP_CONFIG_FILE).toBe("mcp-adapter.json");
    expect(await fs.readdir(prepared.agentConfigDir!)).toEqual(["mcp-adapter.json"]);
    expect(prepared.env.PI_CODING_AGENT_DIR).toBe(prepared.agentConfigDir);
    await prepared.cleanup();
  });

  it("writes models.json and mcp-adapter.json together when both are configured", async () => {
    const mcpConfig = { mcpServers: {} };
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({ other: { baseUrl: "https://other.example/v1" } }) },
      mcpConfig,
    });
    cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
    expect(JSON.parse(await fs.readFile(path.join(prepared.agentConfigDir!, "mcp-adapter.json"), "utf8"))).toEqual(mcpConfig);
    expect(Object.keys((await readModelsJson(prepared.agentConfigDir!)).providers as object)).toEqual(["other"]);
    await prepared.cleanup();
  });

  it("is a no-op when PAPERCLIP_PI_PROVIDERS is unset", async () => {
    const prepared = await preparePiRuntimeConfig({ env: { FOO: "bar" } });

    expect(prepared.env).toEqual({ FOO: "bar" });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("writes the providers JSON verbatim to a managed models.json and points PI_CODING_AGENT_DIR at it", async () => {
    const providers = {
      tensorix: {
        baseUrl: "http://gateway.example.svc.cluster.local:8080/anthropic",
        apiKey: "sk-literal",
        api: "anthropic-messages",
        models: [
          {
            id: "deepseek/deepseek-chat-v3.1",
            name: "DeepSeek v3.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    };

    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    cleanupPaths.add(agentConfigDir);

    expect(await readModelsJson(agentConfigDir)).toEqual({ providers });
    expect(prepared.notes.some((n) => n.includes("tensorix"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(agentConfigDir);
    await expect(fs.access(agentConfigDir)).rejects.toThrow();
  });

  it("reads PAPERCLIP_PI_PROVIDERS from process.env when absent from the run env", async () => {
    const providers = { tensorix: { baseUrl: "http://gw/anthropic", api: "anthropic-messages", models: [] } };
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await preparePiRuntimeConfig({ env: {} });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      expect(agentConfigDir).toBeTruthy();
      cleanupPaths.add(agentConfigDir);
      expect(await readModelsJson(agentConfigDir)).toEqual({ providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders from the run env (bakes the literal key)", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:ANTHROPIC_API_KEY}", api: "anthropic-messages", models: [] },
    };
    const prepared = await preparePiRuntimeConfig({
      env: {
        PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers),
        ANTHROPIC_API_KEY: "sk-bf-REALVK",
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsJson.providers.tensorix.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("does NOT expand {env:VAR} from the server env when the provider config came from the run env (TECH-7076)", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:PAPERCLIP_PI_TEST_KEY}", api: "anthropic-messages", models: [] },
    };
    process.env.PAPERCLIP_PI_TEST_KEY = "sk-from-process-env";
    try {
      const prepared = await preparePiRuntimeConfig({
        env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
      });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const modelsJson = (await readModelsJson(agentConfigDir)) as {
        providers: { tensorix: { apiKey: string } };
      };
      expect(modelsJson.providers.tensorix.apiKey).toBe("{env:PAPERCLIP_PI_TEST_KEY}");
      expect(JSON.stringify(modelsJson)).not.toContain("sk-from-process-env");
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_TEST_KEY;
    }
  });

  it("an operator-set server-env provider config may still expand {env:VAR} from the server env", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:PAPERCLIP_PI_TEST_KEY}", api: "anthropic-messages", models: [] },
    };
    process.env.PAPERCLIP_PI_TEST_KEY = "sk-from-process-env";
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await preparePiRuntimeConfig({ env: {} });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const modelsJson = (await readModelsJson(agentConfigDir)) as { providers: { tensorix: { apiKey: string } } };
      expect(modelsJson.providers.tensorix.apiKey).toBe("sk-from-process-env");
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_TEST_KEY;
      delete process.env.PAPERCLIP_PI_PROVIDERS;
    }
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}", api: "anthropic-messages", models: [] },
    };
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsJson.providers.tensorix.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_PI_PROVIDERS without writing a config", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("ignores provider entries that are not objects and names them in the note", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({ tensorix: "nope" }) },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces skipped non-object entries while keeping the usable ones", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: {
        PAPERCLIP_PI_PROVIDERS: JSON.stringify({
          bad: "http://gw/v1",
          tensorix: { baseUrl: "http://gw/anthropic", apiKey: "k", api: "anthropic-messages", models: [] },
        }),
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    expect(prepared.agentConfigDir).toBe(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: Record<string, unknown>;
    };
    expect(modelsJson.providers.tensorix).toBeDefined();
    expect(modelsJson.providers.bad).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: bad.",
      "Injected 1 custom Pi provider(s) from PAPERCLIP_PI_PROVIDERS into a managed models.json: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_PI_PROVIDERS contains invalid JSON", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "{not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_PI_PROVIDERS is not a JSON object", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "[1,2]" },
    });
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces the skipped entries when no provider objects remain", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: '{"a": 1}' },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: a.",
    ]);
    await prepared.cleanup();
  });

  it("stays silent when PAPERCLIP_PI_PROVIDERS is an empty object", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "{}" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  const routerProviders = (apiKey: string) =>
    JSON.stringify({ "ramp-router": { baseUrl: "https://api.router.com/v1", api: "openai-responses", apiKey, models: [{ id: "gpt-6-luna" }] } });

  it("never echoes an apiKey value in a note, even when a literal key looks like an env var name", async () => {
    const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: routerProviders("SKLITERALKEY123") } });
    cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
    expect(prepared.notes.join("\n")).not.toContain("SKLITERALKEY123");
    await prepared.cleanup();
  });

  it("warns with the env var name when a $NAME apiKey reference is missing or empty, and never writes the key value", async () => {
    for (const apiKey of ["$RAMP_ROUTER_API_KEY", "${RAMP_ROUTER_API_KEY}"]) {
      for (const env of [{} as Record<string, string>, { RAMP_ROUTER_API_KEY: "" }]) {
        const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: routerProviders(apiKey), ...env } });
        cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
        expect(prepared.notes.filter((n) => n.includes('"ramp-router"') && n.includes("RAMP_ROUTER_API_KEY") && n.includes("missing or empty"))).toHaveLength(1);
        await prepared.cleanup();
      }
      const prepared = await preparePiRuntimeConfig({
        env: { PAPERCLIP_PI_PROVIDERS: routerProviders(apiKey), RAMP_ROUTER_API_KEY: "sk-secret-value" },
      });
      cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
      expect(prepared.notes.some((n) => n.includes("missing or empty"))).toBe(false);
      const raw = await fs.readFile(path.join(prepared.env.PI_CODING_AGENT_DIR, "models.json"), "utf8");
      expect(raw).not.toContain("sk-secret-value");
      expect(raw).toContain(`"apiKey": ${JSON.stringify(apiKey)}`);
      await prepared.cleanup();
    }
  });

  it("warns that a bare env var name is a literal key in Pi 0.87 and says to use $NAME", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: routerProviders("RAMP_ROUTER_API_KEY"), RAMP_ROUTER_API_KEY: "sk-secret-value" },
    });
    cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
    expect(prepared.notes.some((n) => n.includes('"ramp-router"') && n.includes("literal key") && n.includes("$NAME"))).toBe(true);
    expect(prepared.notes.join("\n")).not.toContain("sk-secret-value");
    await prepared.cleanup();
  });
});

describe("preparePiRuntimeConfig model relay (TECH-10174)", () => {
  const KEY = "router-secret-key-0123456789";
  const providers = (apiKey: string) => JSON.stringify({
    "ramp-router": { baseUrl: "https://api.router.example/v1", apiKey, api: "openai-completions", models: [{ id: "m" }] },
    other: { baseUrl: "https://other.example/v1", apiKey: "$OTHER_KEY" },
  });

  it("moves the key and real baseUrl to the relay entry and writes no key into models.json", async () => {
    const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: providers("$RAMP_ROUTER_API_KEY"), RAMP_ROUTER_API_KEY: KEY, OTHER_KEY: "o" }, modelRelay: true });
    cleanupPaths.add(prepared.agentConfigDir!);
    expect(prepared.relayedProviders).toEqual({ "ramp-router": { upstreamBaseUrl: "https://api.router.example/v1", apiKey: KEY } });
    expect(prepared.droppedEnvKeys).toEqual(["RAMP_ROUTER_API_KEY"]);
    const raw = await fs.readFile(path.join(prepared.agentConfigDir!, "models.json"), "utf8");
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("api.router.example");
    const written = (await readModelsJson(prepared.agentConfigDir!)).providers as Record<string, Record<string, unknown>>;
    expect(written["ramp-router"]).toMatchObject({ apiKey: "$PAPERCLIP_API_KEY", api: "openai-completions", models: [{ id: "m" }] });
    expect(written.other).toMatchObject({ baseUrl: "https://other.example/v1", apiKey: "$OTHER_KEY" });
    expect(prepared.notes.join("\n")).not.toContain("missing or empty");
    expect(prepared.notes.join("\n")).not.toContain(KEY);
  });

  it("drops the raw provider config from the pod env when it carries a literal key", async () => {
    const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: providers(KEY) }, modelRelay: true });
    cleanupPaths.add(prepared.agentConfigDir!);
    expect(prepared.relayedProviders["ramp-router"]?.apiKey).toBe(KEY);
    expect(prepared.droppedEnvKeys).toEqual(["PAPERCLIP_PI_PROVIDERS"]);
  });

  it("does not relay when not requested, when the key is missing, or when the baseUrl is not https", async () => {
    const off = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: providers("$RAMP_ROUTER_API_KEY"), RAMP_ROUTER_API_KEY: KEY } });
    cleanupPaths.add(off.agentConfigDir!);
    expect(off.relayedProviders).toEqual({});
    expect(off.droppedEnvKeys).toEqual([]);
    expect(await fs.readFile(path.join(off.agentConfigDir!, "models.json"), "utf8")).toContain("$RAMP_ROUTER_API_KEY");
    const noKey = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: providers("$RAMP_ROUTER_API_KEY") }, modelRelay: true });
    cleanupPaths.add(noKey.agentConfigDir!);
    expect(noKey.relayedProviders).toEqual({});
    const http = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: providers("$RAMP_ROUTER_API_KEY").replace("https://api.router", "http://api.router"), RAMP_ROUTER_API_KEY: KEY },
      modelRelay: true,
    });
    cleanupPaths.add(http.agentConfigDir!);
    expect(http.relayedProviders).toEqual({});
  });

  it("points relayed providers at the bridge URL and leaves others alone", () => {
    const body = JSON.stringify({ providers: { "ramp-router": { baseUrl: "http://127.0.0.1:0/api/model-relay/ramp-router", apiKey: "$PAPERCLIP_API_KEY" }, other: { baseUrl: "https://o/v1" } } });
    const out = JSON.parse(pointRelayedProvidersAtBridge(body, "http://127.0.0.1:4310/")!);
    expect(out.providers["ramp-router"].baseUrl).toBe("http://127.0.0.1:4310/api/model-relay/ramp-router");
    expect(out.providers.other.baseUrl).toBe("https://o/v1");
    expect(pointRelayedProvidersAtBridge(JSON.stringify({ providers: { other: { baseUrl: "https://o/v1" } } }), "http://127.0.0.1:4310")).toBeNull();
  });

  // The shape of PAPERCLIP_PI_PROVIDERS in prod and dev (pi_router_providers_env): the provider speaks the Responses API under
  // /v1, and the Claude models override api and baseUrl to the Messages API at the host root.
  const routerShape = () => JSON.stringify({
    "ramp-router": {
      baseUrl: "https://api.router.com/v1",
      api: "openai-responses",
      apiKey: "$RAMP_ROUTER_API_KEY",
      models: [
        { id: "gpt-6.1-sol", reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000 },
        { id: "gpt-6-luna", reasoning: true, compat: { supportsExplicitPromptCacheMode: true } },
        { id: "deepseek-v4.1-flash-1017-us", reasoning: true, maxTokens: 128000 },
        { id: "claude-sonnet-5-5", api: "anthropic-messages", baseUrl: "https://api.router.com", compat: { forceAdaptiveThinking: true } },
        { id: "claude-opus-5-5", api: "anthropic-messages", baseUrl: "https://api.router.com", compat: { forceAdaptiveThinking: true } },
      ],
    },
  });

  it("relays Claude models that override baseUrl, and models that do not, with no Router URL or key left in models.json", async () => {
    const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: routerShape(), RAMP_ROUTER_API_KEY: KEY }, modelRelay: true });
    cleanupPaths.add(prepared.agentConfigDir!);
    // One relay entry per distinct upstream: the provider's /v1 base, and the host-root base the Claude models use.
    expect(prepared.relayedProviders).toEqual({
      "ramp-router": { upstreamBaseUrl: "https://api.router.com/v1", apiKey: KEY },
      "ramp-router-m1": { upstreamBaseUrl: "https://api.router.com", apiKey: KEY },
    });
    expect(prepared.droppedEnvKeys).toEqual(["RAMP_ROUTER_API_KEY"]);
    const raw = await fs.readFile(path.join(prepared.agentConfigDir!, "models.json"), "utf8");
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("api.router.com");
    const staged = pointRelayedProvidersAtBridge(raw, "http://127.0.0.1:4310")!;
    const provider = (JSON.parse(staged).providers as Record<string, Record<string, unknown>>)["ramp-router"]!;
    const models = provider.models as Array<Record<string, unknown>>;
    expect(provider).toMatchObject({ baseUrl: "http://127.0.0.1:4310/api/model-relay/ramp-router", apiKey: "$PAPERCLIP_API_KEY", api: "openai-responses" });
    // Non-Claude models keep no override and inherit the provider's relay URL.
    expect(models.find((m) => m.id === "gpt-6-luna")).not.toHaveProperty("baseUrl");
    expect(models.find((m) => m.id === "deepseek-v4.1-flash-1017-us")).not.toHaveProperty("baseUrl");
    for (const id of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
      expect(models.find((m) => m.id === id)).toMatchObject({ api: "anthropic-messages", baseUrl: "http://127.0.0.1:4310/api/model-relay/ramp-router-m1" });
    }
    expect(JSON.stringify(models)).not.toContain("router.com");
  });

  it("relays a per-model apiKey override with its own key, and rewrites modelOverrides too", async () => {
    const providersJson = JSON.stringify({
      "ramp-router": {
        baseUrl: "https://api.router.com/v1",
        apiKey: "$RAMP_ROUTER_API_KEY",
        models: [{ id: "a", apiKey: "$OTHER_ROUTER_KEY" }, { id: "b", apiKey: "$OTHER_ROUTER_KEY", baseUrl: "https://api.router.com" }],
        modelOverrides: { c: { baseUrl: "https://api.router.com" } },
      },
    });
    const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: providersJson, RAMP_ROUTER_API_KEY: KEY, OTHER_ROUTER_KEY: "other-router-key-0123456789" }, modelRelay: true });
    cleanupPaths.add(prepared.agentConfigDir!);
    expect(Object.values(prepared.relayedProviders).map((e) => `${e.upstreamBaseUrl} ${e.apiKey}`).sort()).toEqual([
      "https://api.router.com other-router-key-0123456789",
      "https://api.router.com/v1 other-router-key-0123456789",
      "https://api.router.com/v1 router-secret-key-0123456789",
      "https://api.router.com router-secret-key-0123456789",
    ].sort());
    expect(prepared.droppedEnvKeys.sort()).toEqual(["OTHER_ROUTER_KEY", "RAMP_ROUTER_API_KEY"]);
    const raw = await fs.readFile(path.join(prepared.agentConfigDir!, "models.json"), "utf8");
    expect(raw).not.toContain("router.com");
    expect(raw).not.toContain("router-key");
    expect(raw).not.toMatch(/\$(?!PAPERCLIP_API_KEY)[A-Z_]+/);
  });

  it("leaves a provider entirely unrelayed when one model override cannot be relayed safely", async () => {
    for (const model of [
      { id: "x", apiKey: "!op read secret" },
      { id: "x", apiKey: "$MISSING_KEY" },
      { id: "x", baseUrl: "http://api.router.com" },
      { id: "x", headers: { Authorization: "Bearer abc" } },
    ]) {
      const providersJson = JSON.stringify({ "ramp-router": { baseUrl: "https://api.router.com/v1", apiKey: "$RAMP_ROUTER_API_KEY", models: [model] } });
      const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: providersJson, RAMP_ROUTER_API_KEY: KEY }, modelRelay: true });
      cleanupPaths.add(prepared.agentConfigDir!);
      expect(prepared.relayedProviders).toEqual({});
      expect(prepared.droppedEnvKeys).toEqual([]);
      expect(await fs.readFile(path.join(prepared.agentConfigDir!, "models.json"), "utf8")).toContain("$RAMP_ROUTER_API_KEY");
    }
  });
});

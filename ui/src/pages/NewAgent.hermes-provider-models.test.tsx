// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { NewAgent } from "./NewAgent";
import { ApiError } from "@/api/client";
import { withHermesCreatePreflight } from "./test-support/hermes-create-preflight";
// Test-only: the pure Hermes runtime resolver, to prove how a wizard-saved config resolves at runtime.
import { resolveProvider } from "@paperclipai/hermes-paperclip-adapter/server";

/**
 * Independent TECH-7395 coverage for the Hermes Local model catalog through the
 * REAL native ModelDropdown component (no AgentConfigForm mock). NewAgent.test.tsx
 * covers the same route/query wiring through a deterministic stand-in dropdown;
 * this file covers what only the real component can prove: selectable catalog
 * choices, the custom-model entry path, the Default choice, and that
 * out-of-order catalog responses never surface another provider's options.
 *
 * The create/test APIs are mocked, so nothing here touches a live server and
 * no credential material ever leaves the test. OpenRouter IDs in the mocked
 * catalogs are opaque markers; the upstream ID prefix question under team
 * review is deliberately not exercised.
 */

const api = vi.hoisted(() => ({
  get: vi.fn(),
  adapterModels: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  hire: vi.fn(),
  testEnvironment: vi.fn(),
  getAdapterAuthSignal: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));
const envApi = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn() }));
const settings = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));
const secrets = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  listMyUserSecrets: vi.fn(),
}));
const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  adapters: [] as object[],
  navigate: vi.fn(),
  openNewIssue: vi.fn(),
}));
const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  create: vi.fn(async () => ({ connectionId: "managed-connection", grantId: "managed-grant" })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));
vi.mock("@/api/environments", () => ({ environmentsApi: envApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: settings }));
vi.mock("@/api/secrets", () => ({ secretsApi: secrets }));
vi.mock("@/api/adapters", () => ({
  adaptersApi: { list: async () => state.adapters },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: state.openNewIssue }),
}));
vi.mock("@/lib/router", () => ({
  useNavigate: () => state.navigate,
  useSearchParams: () => [state.params],
}));
vi.mock("@/components/onboarding/PillGuy", () => ({ PillGuy: () => null }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: any) => children,
  MotionConfig: ({ children }: any) => children,
  motion: {
    span: ({ children }: any) => <span>{children}</span>,
    div: ({ children, initial, animate, exit, transition, ...rest }: any) => (
      <div {...rest}>{children}</div>
    ),
  },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Catalog = Array<{ id: string; label: string }>;

const catalogs: Record<string, Catalog> = {
  openrouter: [
    { id: "anthropic/claude-opus-4-6", label: "OR Opus" },
    { id: "openai/gpt-5.4", label: "OR GPT" },
  ],
  anthropic: [{ id: "claude-opus-5", label: "Claude Opus 5" }],
  openai: [{ id: "gpt-5.4", label: "GPT 5.4" }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function render(adapter = "hermes_local", runnerProvider = "codex", name = "test-agent") {
  state.params = new URLSearchParams({
    name,
    adapterType: adapter,
    runnerProvider,
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <TooltipProvider><NewAgent /></TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function findButton(scope: ParentNode, text: string) {
  return Array.from(scope.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

async function clickButton(scope: ParentNode, text: string) {
  const button = findButton(scope, text);
  expect(button, `Missing button ${text}`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function fill(label: string, value: string) {
  const input = container.querySelector(
    `[aria-label="${label}"]`,
  ) as HTMLInputElement;
  expect(input, `Missing input ${label}`).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function chooseProvider(provider: string) {
  const select = container.querySelector(
    'select[aria-label="API key provider"]',
  ) as HTMLSelectElement;
  expect(select, "Missing API key provider select").toBeTruthy();
  await act(async () => {
    select.value = provider;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

/** Exercise the real native ModelDropdown, including its custom-model path. */
function modelSelect(): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
  expect(select, "Model select").toBeTruthy();
  return select!;
}

function selectedModelText() {
  const custom = container.querySelector<HTMLInputElement>('input[aria-label="Model ID"]');
  return custom?.value ?? modelSelect().selectedOptions[0]?.textContent?.trim();
}

function optionTexts() {
  return Array.from(modelSelect().options).map(option => option.textContent?.trim() ?? "");
}

async function selectModel(label: string) {
  const select = modelSelect();
  const option = Array.from(select.options).find(option => option.textContent?.trim() === label);
  expect(option, `Missing model option ${label}`).toBeTruthy();
  await act(async () => {
    select.value = option!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function typeManualModel(value: string) {
  await selectModel("Enter custom model…");
  await fill("Model ID", value);
  await settle();
}

const providerOf = (call: unknown[]) =>
  (call[2] as { provider?: string } | undefined)?.provider;
const hermesCalls = () =>
  api.adapterModels.mock.calls.filter((call) => call[1] === "hermes_local");
const modelsKey = (provider?: string) =>
  queryKeys.agents.adapterModels("company-1", "hermes_local", "local-1", provider);

const pass = {
  adapterType: "hermes_local",
  status: "pass",
  checks: [
    { code: "hello_probe_passed", level: "info", message: "Model replied" },
  ],
  testedAt: "2026-09-07T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  state.adapters = [
    "claude_local",
    "codex_local",
    "opencode_local",
    "pi_local",
    "paperclip_runner", "cursor_cloud", "cursor", "gemini_local", "kimi_local", "grok_local", "hermes_local", "hermes_gateway",
  ].map((type) => ({ type, loaded: true, disabled: false }));
  api.adapterModels.mockImplementation(
    async (_company, _type, options) =>
      catalogs[(options as { provider?: string } | undefined)?.provider ?? ""] ?? [],
  );
  api.list.mockResolvedValue([{ id: "ceo", role: "ceo", status: "idle" }]);
  const setupAgent = {
    id: "setup-agent", companyId: "company-1", name: "test-agent",
    role: "general", status: "paused", pauseReason: "setup",
    adapterConfig: {}, runtimeConfig: {},
  };
  api.create.mockImplementation(async (_company, input) => ({ ...setupAgent, ...input }));
  api.update.mockImplementation(async (_id, input) => ({ ...setupAgent, ...input }));
  api.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
  api.getClaudeOAuthTokenStatus.mockRejectedValue(new ApiError("Not found", 404, null));
  api.testEnvironment.mockImplementation(withHermesCreatePreflight(pass));
  api.hire.mockImplementation(async (_company, input) => ({
    agent: { ...input, id: "new-agent", status: "idle", urlKey: "test-agent" },
  }));
  envApi.list.mockResolvedValue([
    { id: "local-1", name: "Local", driver: "local", config: {} },
  ]);
  envApi.capabilities.mockResolvedValue({ sandboxProviders: {} });
  settings.get.mockResolvedValue({ defaultEnvironmentId: "local-1" });
  settings.getExperimental.mockResolvedValue({ enableNativeRunner: true });
  settings.getGeneral.mockResolvedValue({ executionMode: "any" });
  secrets.list.mockResolvedValue([]);
  secrets.create.mockResolvedValue({ id: "org-secret-1" });
  secrets.remove.mockResolvedValue({ ok: true });
  secrets.listMyUserSecrets.mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
});

describe("New agent setup Hermes model catalog (real dropdown)", () => {
  it("defaults the Hermes wizard to Ramp Router, never the URL runner provider, and requests provider- and environment-scoped options", async () => {
    await render("hermes_local", "codex", "test-agent");
    const calls = hermesCalls();
    // TECH-7895: new Hermes agents default to Ramp Router, whose catalog is account-specific.
    expect(calls.map(providerOf)).toEqual(["router", "router"]);
    expect(calls[0][0]).toBe("company-1");
    // Catalog discovery is scoped to the provider and resolved environment;
    // it never carries credential material or a refresh flag.
    expect(calls.map(call => call[2])).toEqual([
      { provider: "router", environmentId: null },
      { provider: "router", environmentId: "local-1" },
    ]);
    expect(Object.keys(calls[0][2] ?? {}).sort()).toEqual(["environmentId", "provider"]);
    expect(api.adapterModels).not.toHaveBeenCalledWith(
      "company-1",
      "hermes_local",
      expect.objectContaining({ provider: "codex" }),
    );

    // The select shows the human label for the router provider.
    const select = container.querySelector(
      'select[aria-label="API key provider"]',
    ) as HTMLSelectElement;
    const routerOption = Array.from(select.options).find((option) => option.value === "router");
    expect(routerOption?.textContent?.trim()).toBe("Ramp Router");

    // No Router catalog: manual entry stays, and no other provider's options leak in.
    expect(optionTexts()).toContain("Enter custom model…");
    expect(optionTexts()).not.toContain("OR Opus");
    expect(optionTexts()).not.toContain("Claude Opus 5");
    expect(modelsKey("router")).not.toEqual(modelsKey("codex"));
  });

  it("suggests auto-jev-routing when Ramp Router is selected, and still accepts a manual model", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("anthropic");
    await chooseProvider("router");
    expect(selectedModelText()).toContain("auto-jev-routing");

    await typeManualModel("vendor/custom-model");
    expect(selectedModelText()).toContain("vendor/custom-model");
    // The suggestion is a default, not a closed list: re-selecting Router keeps the manual model.
    await chooseProvider("router");
    expect(selectedModelText()).toContain("vendor/custom-model");
  });

  it("keeps a manual model spelled exactly like the suggestion as the user's own choice", async () => {
    await render("hermes_local", "codex", "test-agent");
    await typeManualModel("auto-jev-routing");
    // Switching away must not treat it as the Router suggestion and clear it.
    await chooseProvider("anthropic");
    expect(selectedModelText()).toContain("auto-jev-routing");
    expect(selectedModelText()).not.toMatch(/^Default/);
    await fill("ANTHROPIC_API_KEY", "anthropic-test-key");
    await clickButton(container, "Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config).toMatchObject({ provider: "anthropic", model: "auto-jev-routing" });
  });

  it("clears a catalog-selected model when switching to Router and shows the Router suggestion", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("openrouter");
    await selectModel("OR Opus");
    await chooseProvider("router");
    expect(selectedModelText()).toBe("Default (auto-jev-routing)");
  });

  it("keeps the current provider's options when earlier requests resolve after later ones", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<Catalog>>>();
    api.adapterModels.mockImplementation(async (_company, _type, options) => {
      const provider = (options as { provider?: string } | undefined)?.provider ?? "";
      if (!gates.has(provider)) gates.set(provider, deferred());
      return gates.get(provider)!.promise;
    });
    await render("hermes_local", "codex", "test-agent"); // router issued, pending
    await chooseProvider("openrouter"); // openrouter issued, pending
    await chooseProvider("anthropic"); // anthropic issued, pending
    await chooseProvider("openai"); // openai issued, pending — current selection

    // The newest request finishes first.
    await act(async () => {
      gates.get("openai")!.resolve(catalogs.openai);
    });
    await settle();
    expect(optionTexts()).toContain("GPT 5.4");
    expect(optionTexts()).not.toContain("Claude Opus 5");
    expect(optionTexts()).not.toContain("OR Opus");

    // The older, slower anthropic response lands afterwards while the dropdown
    // remains visible: its options must not flip to the stale provider.
    await act(async () => {
      gates.get("anthropic")!.resolve(catalogs.anthropic);
    });
    await settle();
    expect(optionTexts()).toContain("GPT 5.4");
    expect(optionTexts()).not.toContain("Claude Opus 5");

    // The oldest openrouter response lands last of all, still without leaking in.
    await act(async () => {
      gates.get("openrouter")!.resolve(catalogs.openrouter);
    });
    await settle();
    expect(optionTexts()).toContain("GPT 5.4");
    expect(optionTexts()).not.toContain("OR Opus");
    expect(optionTexts()).not.toContain("Claude Opus 5");

    // Every late response was still cached under its own provider's key.
    expect(cache.getQueryData(modelsKey("anthropic"))).toEqual(catalogs.anthropic);
    expect(cache.getQueryData(modelsKey("openai"))).toEqual(catalogs.openai);
    expect(cache.getQueryData(modelsKey("openrouter"))).toEqual(catalogs.openrouter);
  });

  it("serves the cached catalog immediately when switching back to a provider, and never requests another provider for it", async () => {
    // The first openrouter fetch resolves; the return trip's background refetch
    // hangs forever, so anything visible after switching back must come from the
    // provider-keyed cache rather than a fresh response.
    const openrouterResponses: Array<Promise<Catalog>> = [
      Promise.resolve(catalogs.openrouter),
      new Promise<Catalog>(() => {}),
    ];
    let openrouterCalls = 0;
    api.adapterModels.mockImplementation(async (_company, _type, options) => {
      const scope = options as { provider?: string; environmentId?: string | null } | undefined;
      const provider = scope?.provider ?? "";
      if (provider === "openrouter" && scope?.environmentId === "local-1") {
        const response = openrouterResponses[Math.min(openrouterCalls, openrouterResponses.length - 1)];
        openrouterCalls += 1;
        return response;
      }
      return Promise.resolve(catalogs[provider] ?? []);
    });
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("openrouter");
    await chooseProvider("anthropic");
    await chooseProvider("openrouter");

    const texts = optionTexts();
    expect(texts).toContain("OR Opus");
    expect(texts).not.toContain("Claude Opus 5");

    const providers = hermesCalls().map(providerOf);
    // Return trip re-observes the openrouter query (background refetch allowed),
    // but every request stays on a provider actually selected in the wizard.
    expect(providers).toEqual(["router", "router", "openrouter", "anthropic", "openrouter"]);
    // Catalog requests carry only provider and environment scope.
    for (const call of hermesCalls()) {
      expect(Object.keys(call[2] ?? {}).sort()).toEqual(["environmentId", "provider"]);
    }
  });

  it("selects a catalog model, clears it on provider switch, and submits an exact manual model with the provider's own key", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("openrouter");
    await selectModel("OR Opus");
    expect(selectedModelText()).toContain("OR Opus");

    await chooseProvider("anthropic");
    // Switching provider resets the model selection to the Default choice.
    expect(selectedModelText()).toBe("Default");
    expect(optionTexts()).toContain("Claude Opus 5");
    expect(optionTexts()).not.toContain("OR Opus");

    // Enter a custom model outside the static catalog.
    await typeManualModel("claude-sonnet-5-5");
    expect(selectedModelText()).toContain("claude-sonnet-5-5");

    await fill("ANTHROPIC_API_KEY", "anthropic-test-key");
    await clickButton(container, "Finish setup");

    expect(api.hire).toHaveBeenCalledTimes(1);
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe("claude-sonnet-5-5");
    expect(config.provider).toBe("anthropic");
    expect(config.env.ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(config.env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("anthropic-test-key");
    // The pre-store probe tested the entered key for the selected provider only.
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({
      ANTHROPIC_API_KEY: "anthropic-test-key",
    });
  });

  it("passes a manually typed openrouter/-prefixed model verbatim: the prefix strip is catalog-side only", async () => {
    await render("hermes_local", "codex", "test-agent");
    // The OpenRouter provider is selected (its server catalog strips one leading
    // openrouter/ prefix), so this is exactly the case a global UI-side rewrite
    // would corrupt. The wizard must not rewrite manual input.
    await chooseProvider("openrouter");
    await typeManualModel("openrouter/anthropic/claude-sonnet-4-6");
    expect(selectedModelText()).toContain("openrouter/anthropic/claude-sonnet-4-6");

    await fill("OPENROUTER_API_KEY", "openrouter-test-key");
    await clickButton(container, "Finish setup");

    expect(api.hire).toHaveBeenCalledTimes(1);
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe("openrouter/anthropic/claude-sonnet-4-6");
    expect(config.env.OPENROUTER_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("openrouter-test-key");
  });

  it.each([
    ["openrouter", "OR Opus", "anthropic/claude-opus-4-6", "OPENROUTER_API_KEY", "openrouter"],
    ["openai", "GPT 5.4", "gpt-5.4", "OPENAI_API_KEY", "openai-api"],
    ["anthropic", "Claude Opus 5", "claude-opus-5", "ANTHROPIC_API_KEY", "anthropic"],
  ])("saves the provider alongside a selected %s catalog model (%s)", async (selected, label, id, key, expected) => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider(selected);
    await selectModel(label);
    await fill(key, "hermes-test-key");
    await clickButton(container, "Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe(id);
    expect(config.provider).toBe(expected);
  });

  it("pins the provider and exact model for a keyless catalog selection", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("openrouter");
    await selectModel("OR Opus");
    await clickButton(container, "Finish setup");
    const pinned = api.hire.mock.calls[0][1].adapterConfig;
    expect(pinned.model).toBe("anthropic/claude-opus-4-6");
    expect(pinned.provider).toBe("openrouter");
    expect(pinned).not.toHaveProperty("env");
  });

  const ROUTER_FORECAST = { provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: false };
  const serverDefaultText = () =>
    container.querySelector('[data-testid="hermes-server-default"]')?.textContent ?? "";

  it("shows Server default before the check, then the server's Router forecast, and submits intent only", async () => {
    await render("hermes_local", "codex", "test-agent");
    // Nothing is guaranteed before the server answers: the provider is the server's to choose.
    expect(selectedModelText()).toBe("Server default");
    expect(serverDefaultText()).toContain("Server default.");
    expect(serverDefaultText()).not.toContain("Ramp Router");

    await clickButton(container, "Run test");
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({ purpose: "create", testCredentials: {} });
    expect(api.testEnvironment.mock.calls[0][2].adapterConfig).not.toHaveProperty("provider");
    expect(serverDefaultText()).toContain("Ramp Router · auto-jev-routing");
    expect(selectedModelText()).toContain("Ramp Router · auto-jev-routing");

    await clickButton(container, "Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    const hire = api.hire.mock.calls[0][1];
    expect(hire.adapterConfig).not.toHaveProperty("provider");
    expect(hire.adapterConfig).not.toHaveProperty("model");
    expect(hire.adapterConfig).not.toHaveProperty("env");
    expect(hire.expectedCreateDefaults).toEqual(ROUTER_FORECAST);
  });

  it("gates a typed auto model exactly like an untouched wizard", async () => {
    await render("hermes_local", "codex", "test-agent");
    await typeManualModel("auto");
    await clickButton(container, "Finish setup");
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({ purpose: "create", adapterConfig: { model: "auto" } });
    expect(api.hire.mock.calls[0][1].expectedCreateDefaults).toEqual(ROUTER_FORECAST);
  });

  it.each([
    ["fails", { status: "fail", checks: [{ code: "hermes_router_unsupported", level: "error", message: "Hermes does not support router" }], createDefaults: { provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: false } }],
    ["passes without confirming Router readiness", { status: "pass", checks: [], createDefaults: { provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: false } }],
    ["returns no server defaults (unknown)", { status: "pass", checks: [] }],
  ])("does not hire an untouched wizard when the create-purpose test %s", async (_label, outcome) => {
    api.testEnvironment.mockResolvedValue({ adapterType: "hermes_local", testedAt: "2026-09-07T00:00:00Z", ...outcome });
    await render("hermes_local", "codex", "test-agent");
    await clickButton(container, "Finish setup");
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.hire).not.toHaveBeenCalled();
  });

  it("shows the platform OpenAI default without pinning any provider", async () => {
    const platform = { provider: null, model: null, source: "platform_openai", requiresRouterReadiness: false, platformRouterKeyBound: false };
    api.testEnvironment.mockResolvedValue({
      adapterType: "hermes_local", status: "pass", testedAt: "2026-09-07T00:00:00Z",
      checks: [{ code: "create_defaults_platform_openai", level: "info", message: "Defaults resolved" }],
      createDefaults: platform,
    });
    await render("hermes_local", "codex", "test-agent");
    await clickButton(container, "Run test");
    expect(serverDefaultText()).toContain("platform OpenAI key");
    expect(serverDefaultText()).not.toContain("Ramp Router");
    await clickButton(container, "Finish setup");
    const hire = api.hire.mock.calls[0][1];
    expect(hire.adapterConfig).not.toHaveProperty("provider");
    expect(hire.adapterConfig).not.toHaveProperty("model");
    expect(hire.expectedCreateDefaults).toEqual(platform);
  });

  it("explains a remote environment for a Router default and does not hire", async () => {
    api.testEnvironment.mockResolvedValue({
      adapterType: "hermes_local", status: "fail", testedAt: "2026-09-07T00:00:00Z",
      checks: [{ code: "hermes_router_remote_unsupported", level: "error", message: "Router is local only" }],
      createDefaults: ROUTER_FORECAST,
    });
    await render("hermes_local", "codex", "test-agent");
    await clickButton(container, "Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("supported local environment");
    expect(container.textContent).toContain("ask an admin");
  });

  it("asks for a re-test when the server's defaults changed, never falling through to another create", async () => {
    api.hire.mockRejectedValueOnce(
      new ApiError("defaults changed", 409, { error: "defaults changed", code: "agent_create_defaults_changed" }),
    );
    await render("hermes_local", "codex", "test-agent");
    await clickButton(container, "Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("server defaults changed");
    // The previous forecast is discarded: the label is back to the unconfirmed server default.
    expect(serverDefaultText()).not.toContain("Ramp Router");
    await clickButton(container, "Finish setup");
    // A second finish re-runs the create-purpose test before the next attempt.
    expect(api.testEnvironment).toHaveBeenCalledTimes(2);
    expect(api.hire).toHaveBeenCalledTimes(2);
  });

  it("pins Router when its key is typed, leaving the default model to the server", async () => {
    await render("hermes_local", "codex", "test-agent");
    // An untouched wizard persists nothing, so the key alone is what binds the provider.
    await fill("RAMP_ROUTER_API_KEY", "router-test-key");
    await clickButton(container, "Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    const hire = api.hire.mock.calls[0][1];
    expect(hire.adapterConfig.provider).toBe("router");
    expect(hire.adapterConfig).not.toHaveProperty("model");
    expect(hire.adapterConfig.env.RAMP_ROUTER_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(hire.expectedCreateDefaults).toEqual(ROUTER_FORECAST);
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("router-test-key");
  });

  it("keeps a manual Router model verbatim when attaching its key, in both the probe and saved config", async () => {
    await render();
    const model = "openrouter/anthropic/account-specific-router-model";
    await typeManualModel(model);
    await fill("RAMP_ROUTER_API_KEY", "router-manual-model-test-key");
    expect(selectedModelText()).toContain(model);
    await clickButton(container, "Finish setup");

    expect(api.hire).toHaveBeenCalledTimes(1);
    expect(api.hire.mock.calls[0][1].adapterConfig).toMatchObject({
      provider: "router", model,
      env: { RAMP_ROUTER_API_KEY: { type: "secret_ref", secretId: "org-secret-1" } },
    });
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({
      adapterConfig: { provider: "router", model },
      testCredentials: { RAMP_ROUTER_API_KEY: "router-manual-model-test-key" },
    });
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("router-manual-model-test-key");
  });

  it("preserves a manually entered vendor model when switching to Router rather than replacing it with the suggestion", async () => {
    await render();
    await chooseProvider("anthropic");
    const model = "claude-account-specific-model";
    await typeManualModel(model);
    await fill("ANTHROPIC_API_KEY", "old-provider-test-key");
    await chooseProvider("router");
    expect(selectedModelText()).toContain(model);
    await fill("RAMP_ROUTER_API_KEY", "new-provider-test-key");
    await clickButton(container, "Finish setup");

    expect(api.hire).toHaveBeenCalledTimes(1);
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.provider).toBe("router");
    expect(config.model).toBe(model);
    expect(config.env).toEqual({ RAMP_ROUTER_API_KEY: { type: "secret_ref", secretId: "org-secret-1", version: "latest" } });
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({ RAMP_ROUTER_API_KEY: "new-provider-test-key" });
  });

  it("keeps an explicit Router pick with Default chosen, gated by the server-default Router readiness", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("anthropic");
    await chooseProvider("router");
    expect(selectedModelText()).toContain("auto-jev-routing");
    await selectModel("Default (auto-jev-routing)");
    await clickButton(container, "Finish setup");
    const hire = api.hire.mock.calls[0][1];
    // The explicit pick is kept; the server fills the Router default model at create.
    expect(hire.adapterConfig.provider).toBe("router");
    expect(hire.adapterConfig).not.toHaveProperty("model");
    expect(hire.expectedCreateDefaults).toEqual(ROUTER_FORECAST);
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({ purpose: "create", adapterConfig: { provider: "router" } });
  });

  it("does not save a pinned Router config when the backend readiness test fails", async () => {
    api.testEnvironment.mockResolvedValue({
      adapterType: "hermes_local",
      status: "fail",
      checks: [{ code: "hermes_router_unsupported", level: "error", message: "Hermes does not support router" }],
      testedAt: "2026-09-07T00:00:00Z",
    });
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("router");
    await clickButton(container, "Finish setup");
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.hire).not.toHaveBeenCalled();
  });

  it("keeps an explicit provider pick when Default is chosen after a catalog model", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("anthropic");
    await selectModel("Claude Opus 5");
    await selectModel("Default");
    await clickButton(container, "Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config).not.toHaveProperty("model");
    expect(config.provider).toBe("anthropic");
  });

  it("does not treat a keyless manual model outside the catalog as a provider choice", async () => {
    await render("hermes_local", "codex", "test-agent");
    await typeManualModel("custom/x");
    await clickButton(container, "Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe("custom/x");
    expect(config).not.toHaveProperty("provider");
  });

  it("keeps the Default choice: new intent stays unset, the server forecasts Router and readiness gates the hire", async () => {
    await render("hermes_local", "codex", "test-agent");
    await selectModel("Server default");
    expect(selectedModelText()).toMatch(/^Server default/);

    await selectModel("Server default");
    expect(selectedModelText()).toMatch(/^Server default/);

    await clickButton(container, "Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    const hire = api.hire.mock.calls[0][1];
    // The submitted intent has no provider or model; the server forecast (Router) is only an expectation.
    expect(hire.adapterConfig).not.toHaveProperty("provider");
    expect(hire.adapterConfig).not.toHaveProperty("model");
    expect(hire.adapterConfig).not.toHaveProperty("env");
    expect(hire.expectedCreateDefaults).toEqual(ROUTER_FORECAST);
    // The create-purpose Router readiness test ran first, with no credential entered.
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({ purpose: "create", testCredentials: {} });
  });

  it("offers no model options for a provider without a catalog and keeps manual entry through the real dropdown", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("zai");
    expect(hermesCalls().map(providerOf)).toContain("zai");

    expect(optionTexts()).toEqual(["Default", "Enter custom model…"]);
    expect(optionTexts()).not.toContain("OR Opus");

    await typeManualModel("zai/glm-4.7");
    expect(selectedModelText()).toContain("zai/glm-4.7");
    await fill("ZAI_API_KEY", "zai-test-key");
    await clickButton(container, "Finish setup");

    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe("zai/glm-4.7");
    expect(config.env.ZAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("zai-test-key");
  });
});

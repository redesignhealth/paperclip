// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { NewAgent } from "./NewAgent";
import { ApiError } from "@/api/client";
// Test-only: the pure Hermes runtime resolver, to prove how a wizard-saved config resolves at runtime.
import { resolveProvider } from "@paperclipai/hermes-paperclip-adapter/server";

/**
 * Independent TECH-7395 coverage for the Hermes Local model catalog through the
 * REAL ModelDropdown component (no AgentConfigForm mock). NewAgent.test.tsx
 * covers the same route/query wiring through a deterministic stand-in dropdown;
 * this file covers what only the real component can prove: selectable catalog
 * choices, the type-to-create manual entry path, the Default choice, and that
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

/** The real ModelDropdown trigger: the direct button child of the Model Field. */
function modelTrigger(): HTMLButtonElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (element) => element.textContent?.trim() === "Model",
  );
  expect(label, "Model field label").toBeTruthy();
  const field = label!.closest("div")!.parentElement!;
  const trigger = Array.from(field.children).find(
    (child): child is HTMLButtonElement => child.tagName === "BUTTON",
  );
  expect(trigger, "model dropdown trigger button").toBeTruthy();
  return trigger!;
}

async function openModelDropdown() {
  await act(async () => {
    modelTrigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
  const content = document.querySelector('[data-slot="popover-content"]');
  expect(content, "model dropdown did not open").toBeTruthy();
  return content as HTMLElement;
}

function openDropdown() {
  const content = document.querySelector('[data-slot="popover-content"]');
  expect(content, "model dropdown should still be open").toBeTruthy();
  return content as HTMLElement;
}

function optionTexts(content: HTMLElement) {
  return Array.from(content.querySelectorAll("button")).map(
    (button) => button.textContent?.trim() ?? "",
  );
}

async function typeManualModel(content: HTMLElement, value: string) {
  const search = content.querySelector(
    'input[placeholder^="Search models"]',
  ) as HTMLInputElement;
  expect(search, "model search input").toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  const manual = Array.from(content.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Use manual model"),
  );
  expect(manual, `type-to-create affordance for ${value}`).toBeTruthy();
  await act(async () => {
    manual!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

const providerOf = (call: unknown[]) =>
  (call[2] as { provider?: string } | undefined)?.provider;
const hermesCalls = () =>
  api.adapterModels.mock.calls.filter((call) => call[1] === "hermes_local");
const modelsKey = (provider?: string) =>
  queryKeys.agents.adapterModels("company-1", "hermes_local", null, provider);

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
  api.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
  api.getClaudeOAuthTokenStatus.mockRejectedValue(new ApiError("Not found", 404, null));
  api.testEnvironment.mockResolvedValue(pass);
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
  it("defaults to OpenRouter from the wizard state, never the URL runner provider, and requests exact provider-only options", async () => {
    await render("hermes_local", "codex", "test-agent");
    const calls = hermesCalls();
    expect(calls.map(providerOf)).toEqual(["openrouter"]);
    expect(calls[0][0]).toBe("company-1");
    // The catalog route carries the provider and nothing else: no credential
    // material, no refresh, no environment override.
    expect(calls[0][2]).toEqual({ provider: "openrouter" });
    expect(Object.keys(calls[0][2] ?? {}).sort()).toEqual(["provider"]);
    expect(api.adapterModels).not.toHaveBeenCalledWith(
      "company-1",
      "hermes_local",
      expect.objectContaining({ provider: "codex" }),
    );

    const content = await openModelDropdown();
    const texts = optionTexts(content);
    expect(texts).toContain("OR Opus");
    expect(texts).toContain("OR GPT");
    // Hermes keeps the Default choice alongside catalog suggestions.
    expect(texts).toContain("Default");
    expect(texts).not.toContain("Claude Opus 5");

    expect(cache.getQueryData(modelsKey("openrouter"))).toEqual(catalogs.openrouter);
    expect(cache.getQueryData(modelsKey("codex"))).toBeUndefined();
    expect(modelsKey("openrouter")).not.toEqual(modelsKey("codex"));
  });

  it("keeps the current provider's options when earlier requests resolve after later ones", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<Catalog>>>();
    api.adapterModels.mockImplementation(async (_company, _type, options) => {
      const provider = (options as { provider?: string } | undefined)?.provider ?? "";
      if (!gates.has(provider)) gates.set(provider, deferred());
      return gates.get(provider)!.promise;
    });
    await render("hermes_local", "codex", "test-agent"); // openrouter issued, pending
    await chooseProvider("anthropic"); // anthropic issued, pending
    await chooseProvider("openai"); // openai issued, pending — current selection

    // The newest request finishes first.
    await act(async () => {
      gates.get("openai")!.resolve(catalogs.openai);
    });
    await settle();
    let content = await openModelDropdown();
    expect(optionTexts(content)).toContain("GPT 5.4");
    expect(optionTexts(content)).not.toContain("Claude Opus 5");
    expect(optionTexts(content)).not.toContain("OR Opus");

    // The older, slower anthropic response lands afterwards while the dropdown
    // stays open: the visible options must not flip to the stale provider.
    await act(async () => {
      gates.get("anthropic")!.resolve(catalogs.anthropic);
    });
    await settle();
    content = openDropdown();
    expect(optionTexts(content)).toContain("GPT 5.4");
    expect(optionTexts(content)).not.toContain("Claude Opus 5");

    // The oldest openrouter response lands last of all, still without leaking in.
    await act(async () => {
      gates.get("openrouter")!.resolve(catalogs.openrouter);
    });
    await settle();
    content = openDropdown();
    expect(optionTexts(content)).toContain("GPT 5.4");
    expect(optionTexts(content)).not.toContain("OR Opus");
    expect(optionTexts(content)).not.toContain("Claude Opus 5");

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
      const provider = (options as { provider?: string } | undefined)?.provider ?? "";
      if (provider === "openrouter") {
        const response = openrouterResponses[Math.min(openrouterCalls, openrouterResponses.length - 1)];
        openrouterCalls += 1;
        return response;
      }
      return Promise.resolve(catalogs[provider] ?? []);
    });
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("anthropic");
    await chooseProvider("openrouter");

    const content = await openModelDropdown();
    const texts = optionTexts(content);
    expect(texts).toContain("OR Opus");
    expect(texts).not.toContain("Claude Opus 5");

    const providers = hermesCalls().map(providerOf);
    // Return trip re-observes the openrouter query (background refetch allowed),
    // but every request stays on a provider actually selected in the wizard.
    expect(providers).toEqual(["openrouter", "anthropic", "openrouter"]);
    // The catalog request never carries credential material or a refresh flag.
    for (const call of hermesCalls()) {
      expect(Object.keys(call[2] ?? {}).sort()).toEqual(["provider"]);
    }
  });

  it("selects a catalog model, clears it on provider switch, and submits an exact manual model with the provider's own key", async () => {
    await render("hermes_local", "codex", "test-agent");
    let content = await openModelDropdown();
    await clickButton(content, "OR Opus");
    expect(modelTrigger().textContent).toContain("OR Opus");

    await chooseProvider("anthropic");
    // Switching provider resets the model selection to the Default choice.
    expect(modelTrigger().textContent?.trim()).toBe("Default");
    content = await openModelDropdown();
    expect(optionTexts(content)).toContain("Claude Opus 5");
    expect(optionTexts(content)).not.toContain("OR Opus");

    // Type-to-create a model outside the static catalog.
    await typeManualModel(content, "claude-sonnet-5-5");
    expect(modelTrigger().textContent).toContain("claude-sonnet-5-5");

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
    const content = await openModelDropdown();
    await typeManualModel(content, "openrouter/anthropic/claude-sonnet-4-6");
    expect(modelTrigger().textContent).toContain("openrouter/anthropic/claude-sonnet-4-6");

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
    if (selected !== "openrouter") await chooseProvider(selected);
    const content = await openModelDropdown();
    await clickButton(content, label);
    await fill(key, "hermes-test-key");
    await clickButton(container, "Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe(id);
    expect(config.provider).toBe(expected);
  });

  it("pins the provider and exact model for a keyless catalog selection", async () => {
    await render("hermes_local", "codex", "test-agent");
    const content = await openModelDropdown();
    await clickButton(content, "OR Opus");
    await clickButton(container, "Finish setup");
    const pinned = api.hire.mock.calls[0][1].adapterConfig;
    expect(pinned.model).toBe("anthropic/claude-opus-4-6");
    expect(pinned.provider).toBe("openrouter");
    expect(pinned).not.toHaveProperty("env");
  });

  it("drops the keyless catalog pin when Default is chosen after a catalog model", async () => {
    await render("hermes_local", "codex", "test-agent");
    let content = await openModelDropdown();
    await clickButton(content, "OR Opus");
    content = await openModelDropdown();
    await clickButton(content, "Default");
    await clickButton(container, "Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config).not.toHaveProperty("model");
    expect(config).not.toHaveProperty("provider");
  });

  it("keeps an explicit provider pick when Default is chosen after a catalog model", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("anthropic");
    let content = await openModelDropdown();
    await clickButton(content, "Claude Opus 5");
    content = await openModelDropdown();
    await clickButton(content, "Default");
    await clickButton(container, "Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config).not.toHaveProperty("model");
    expect(config.provider).toBe("anthropic");
  });

  it("does not treat a keyless manual model outside the catalog as a provider choice", async () => {
    await render("hermes_local", "codex", "test-agent");
    const content = await openModelDropdown();
    await typeManualModel(content, "custom/x");
    await clickButton(container, "Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe("custom/x");
    expect(config).not.toHaveProperty("provider");
  });

  it("keeps the Default choice: submitting without a model leaves the model unset for runtime resolution", async () => {
    await render("hermes_local", "codex", "test-agent");
    let content = await openModelDropdown();
    await clickButton(content, "OR GPT");
    expect(modelTrigger().textContent).toContain("OR GPT");

    content = await openModelDropdown();
    await clickButton(content, "Default");
    expect(modelTrigger().textContent?.trim()).toBe("Default");

    await clickButton(container, "Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    const config = api.hire.mock.calls[0][1].adapterConfig;
    // The real Hermes config builder omits an empty model so the runtime default wins.
    expect(config).not.toHaveProperty("model");
    // Nothing bound the provider (no key, secret, explicit pick, or catalog model), so it is omitted
    // and a host Hermes provider configuration still applies.
    expect(config).not.toHaveProperty("provider");
    expect(
      resolveProvider({
        explicitProvider: config.provider,
        detectedProvider: "zai",
        detectedModel: "glm-5",
        model: config.model ?? "glm-5",
      }),
    ).toEqual({ provider: "zai", resolvedFrom: "hermesConfig" });
    // No credential was entered, so no probe ran and nothing rides the config env.
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(config).not.toHaveProperty("env");
  });

  it("offers no model options for a provider without a catalog and keeps manual entry through the real dropdown", async () => {
    await render("hermes_local", "codex", "test-agent");
    await chooseProvider("zai");
    expect(hermesCalls().map(providerOf)).toContain("zai");

    const content = await openModelDropdown();
    expect(content.textContent).toContain("No models found.");
    expect(optionTexts(content)).not.toContain("OR Opus");

    await typeManualModel(content, "zai/glm-4.7");
    expect(modelTrigger().textContent).toContain("zai/glm-4.7");
    await fill("ZAI_API_KEY", "zai-test-key");
    await clickButton(container, "Finish setup");

    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe("zai/glm-4.7");
    expect(config.env.ZAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("zai-test-key");
  });
});

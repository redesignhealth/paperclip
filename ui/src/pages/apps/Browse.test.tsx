// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse } from "./Browse";
import { aiConnectionRouterAppDefinition, getAppStoreDefinition } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";

const aggregatorCatalogMock = vi.hoisted(() => [] as AggregatorAppCatalogEntry[]);
const openNewIssueMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const setupComposioAppMock = vi.hoisted(() => vi.fn());
const listComposioAppsMock = vi.hoisted(() => vi.fn());
const syncComposioAppsMock = vi.hoisted(() => vi.fn());
const refreshComposioAppsMock = vi.hoisted(() => vi.fn());
const manageComposioAppAccountMock = vi.hoisted(() => vi.fn());
function genericResponse(value: { apps?: any[]; sync?: Record<string, unknown> }) {
  return { provider: "composio", discovery: { availability: "available", message: null },
    sync: { status: "ready", ...value.sync }, apps: (value.apps ?? []).map(snapshot => ({ ...snapshot, provider: snapshot.provider ?? "composio",
      appSlug: snapshot.appSlug ?? aggregatorCatalogMock.find(app => app.aliases.includes(snapshot.toolkit) || app.routes.some(route => route.toolkit === snapshot.toolkit))?.slug ?? snapshot.toolkit,
      appName: snapshot.appName ?? snapshot.toolkit })) };
}
vi.mock("@/api/agents", () => ({ agentsApi: { list: (companyId: string) => listAgentsMock(companyId) } }));
vi.mock("@paperclipai/shared/aggregator-app-catalog", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/shared/aggregator-app-catalog")>(),
  AGGREGATOR_APP_CATALOG: aggregatorCatalogMock,
  findComposioCatalogApp: (toolkit: string) => aggregatorCatalogMock.find(app => app.aliases.includes(toolkit) || app.routes.some(route => route.provider === "composio" && route.toolkit === toolkit)),
}));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: openNewIssueMock }) }));

const accountIdentity = vi.hoisted(() => ({ userId: "board-user" as string | null, settled: true, failed: false }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => accountIdentity }));

const poolListMock = vi.hoisted(() => vi.fn());
const poolRemoveMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/ai-connection-pools", () => ({ aiConnectionPoolsApi: { list: poolListMock, remove: poolRemoveMock } }));

const assistantConnectionsMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/publicMcp", () => ({ publicMcpApi: { connections: assistantConnectionsMock } }));

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const archiveConnectionMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const startOAuthMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const prepareOAuthNavigationMock = vi.hoisted(() => vi.fn());
const navigateTopLevelMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const experimentalMock = vi.hoisted(() => vi.fn());
const chatSetupMock = vi.hoisted(() => vi.fn());
const emailControlMock = vi.hoisted(() => vi.fn());
const chatListMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: experimentalMock } }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { list: chatListMock, setup: chatSetupMock } }));
vi.mock("@/api/email", () => ({ emailApi: { control: emailControlMock } }));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listAggregatorApps: async (...args: unknown[]) => genericResponse(await listComposioAppsMock(...args)),
    syncAggregatorApps: async (...args: unknown[]) => genericResponse(await syncComposioAppsMock(...args)),
    refreshAggregatorApps: async (...args: unknown[]) => genericResponse(await refreshComposioAppsMock(...args)),
    refreshCatalog: vi.fn().mockResolvedValue({}),
    configureArcadeDiscovery: vi.fn(),
    syncComposioApps: (...args: unknown[]) => syncComposioAppsMock(...args),
    listComposioApps: (...args: unknown[]) => listComposioAppsMock(...args),
    refreshComposioApps: (...args: unknown[]) => refreshComposioAppsMock(...args),
    manageComposioAppAccount: (...args: unknown[]) => manageComposioAppAccountMock(...args),
    setupComposioApp: (...args: unknown[]) => setupComposioAppMock(...args),
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    archiveConnection: (
      connectionId: string,
    ) => archiveConnectionMock(connectionId),
    startOAuth: (connectionId: string, input: Record<string, unknown>) =>
      startOAuthMock(connectionId, input),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
  },
}));

vi.mock("@/api/auth", () => ({
  authApi: { getSession: () => getSessionMock() },
}));

vi.mock("@/lib/oauthHandoff", () => ({
  prepareOAuthNavigation: prepareOAuthNavigationMock,
}));

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: navigateTopLevelMock,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => navigateMock,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function galleryEntry(overrides: Record<string, unknown>) {
  return {
    key: "github",
    name: "GitHub",
    logoUrl: "https://example.com/github.png",
    tagline: "Let agents open pull requests and issues.",
    authKind: "oauth",
    transportTemplate: {
      transport: "mcp_remote",
      url: "https://api.github.com/mcp",
    },
    credentialFields: [],
    recommendedDefaults: {},
    urlPatterns: [],
    ...overrides,
  };
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-notion",
    name: "Notion",
    description: "Read and update workspace content.",
    status: "active",
    applicationKey: "app-gallery:notion:one",
    metadata: { sourceTemplateKey: "notion" },
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-notion",
    applicationId: "app-notion",
    transport: "mcp_remote",
    name: "devinfoley@gmail.com",
    status: "active",
    enabled: true,
    authKind: "oauth",
    healthStatus: "ok",
    healthMessage: null,
    lastError: null,
    createdByUserId: "user-1",
    config: { sourceTemplateKey: "notion" },
    transportConfig: {},
    ...overrides,
  };
}

describe("Connectors landing page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    accountIdentity.userId = "board-user"; accountIdentity.settled = true;
    assistantConnectionsMock.mockReset().mockResolvedValue([]);
    syncComposioAppsMock.mockReset().mockImplementation((...args) => listComposioAppsMock(...args));
    listComposioAppsMock.mockReset().mockResolvedValue({ apps: [] });
    refreshComposioAppsMock.mockReset().mockResolvedValue({ apps: [] });
    manageComposioAppAccountMock.mockReset();
    listAgentsMock.mockResolvedValue([{ id: "default-agent", name: "Default agent", role: "ceo", reportsTo: null, status: "active", createdAt: new Date(0) }]);
    aggregatorCatalogMock.splice(0);
    experimentalMock.mockResolvedValue({ enableChatConnectors: true, enableGitHubReviewBots: true });
    chatListMock.mockResolvedValue([]);
    chatSetupMock.mockReset().mockResolvedValue({ status: "archived" });
    emailControlMock.mockReset().mockResolvedValue({ status: "archived" });
    listGalleryMock.mockResolvedValue({
      apps: [
        galleryEntry({
          key: "notion",
          name: "Notion",
          tagline: "Read and update workspace content.",
        }),
        galleryEntry({
          key: "jira",
          name: "Jira",
          tagline: "Track projects and issues.",
        }),
        galleryEntry({
          key: "gmail",
          name: "Gmail",
          tagline: "Search and draft email.",
          availability: {
            available: false,
            reason: "Gmail is not available on this Paperclip instance yet.",
          },
        }),
      ],
    });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    listUserDirectoryMock.mockResolvedValue({ users: [] });
    archiveConnectionMock.mockResolvedValue(connection({ status: "archived" }));
    startOAuthMock.mockReset();
    startOAuthMock.mockResolvedValue({ authorizationUrl: "https://mcp.example.test/authorize?state=xyz" });
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue(null);
    prepareOAuthNavigationMock.mockReset();
    prepareOAuthNavigationMock.mockImplementation(async (start: { authorizationUrl: string }) => ({
      kind: "authorization" as const,
      url: start.authorizationUrl,
      host: "mcp.example.test",
    }));
    navigateTopLevelMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
    vi.clearAllMocks();
  });

  async function renderBrowse(allCatalog = true) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider><Browse /></TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    if (allCatalog) {
      await clickButton("All", container);
    }
    return client;
  }

  // Rows with several connections fold behind an "N connections" toggle; open them all so account rows are visible.
  async function renderBrowseExpanded(allCatalog = true) {
    const client = await renderBrowse(allCatalog);
    const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => /^\d+ connections$/.test(button.textContent?.trim() ?? "") && button.getAttribute("aria-expanded") === "false",
    );
    for (const toggle of toggles) await act(() => toggle.click());
    await flushReact();
    return client;
  }

  it("shows provider catalog rows and splits legacy gateway accounts by API format", async () => {
    const slugs = ["notion", "openrouter", "bedrock", "google", "responses-api", "messages-api", "chat-completions-api", "local"];
    listGalleryMock.mockResolvedValue({ apps: slugs.map(slug => getAppStoreDefinition(slug)) });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Model gateway", applicationKey: "app-gallery:gateway", metadata: { sourceTemplateKey: "gateway" } })] });
    listConnectionsMock.mockResolvedValue({ connections: ["responses", "messages"].map(protocol => connection({
      id: protocol, name: `${protocol} account`, applicationId: "gateway-app", connectionPurpose: "ai",
      config: { sourceTemplateKey: "gateway", ai: { provider: protocol === "messages" ? "anthropic" : "openai", method: "api_key", routing: { kind: "gateway", protocol, auth: "bearer", baseUrl: "https://models.example.com/v1", models: [] } } },
    })) });
    await renderBrowse();
    expect(container.textContent).not.toContain("Connect a model provider");
    expect(container.textContent).not.toContain("Model gateway");
    for (const slug of slugs) expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
    const responses = container.querySelector('[data-app-slug="responses-api"]')!;
    const messages = container.querySelector('[data-app-slug="messages-api"]')!;
    expect(responses.textContent).toContain("responses account");
    expect(responses.textContent).not.toContain("messages account");
    expect(messages.textContent).toContain("messages account");
    const bedrock = container.querySelector('[data-app-slug="bedrock"]')!;
    const connect = Array.from(bedrock.querySelectorAll('button')).find(button => button.textContent?.includes("Connect"))!;
    await act(() => connect.click());
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?source=bedrock");
  });

  it("offers assistant setup from Connections without choosing an agent", async () => {
    await renderBrowse();
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Set up Assistant Connection (MCP)"]');
    expect(button).not.toBeNull();
    await act(() => button!.click());
    expect(navigateMock).toHaveBeenCalledWith("/apps/assistant-connection");
    expect(chatSetupMock).not.toHaveBeenCalled();
  });

  it("keeps assistant setup in the Paperclip catalog when filtering connection sources", async () => {
    await renderBrowse(false);
    const assistantButton = () => container.querySelector('[aria-label="Set up Assistant Connection (MCP)"]');
    expect(assistantButton()).not.toBeNull();
    await clickButton("Composio", container);
    expect(assistantButton()).toBeNull();
    await clickButton("Arcade", container);
    expect(assistantButton()).toBeNull();
    await clickButton("All", container);
    await search("assistant");
    expect(assistantButton()).not.toBeNull();
    expect(container.textContent).not.toContain("No connectors match");
  });

  const assistantGrant = { id: "grant", companyId: "company-1", companyName: "Paperclip", clientName: "Claude", scopes: ["paperclip:read"], createdAt: "2026-10-06T00:00:00Z", revokedAt: null };

  it("shows active assistant grants in Installed and removes them after revocation", async () => {
    assistantConnectionsMock.mockResolvedValue([assistantGrant]);
    const client = await renderBrowse(false);
    await clickButton("Installed", container);
    const manage = container.querySelector<HTMLButtonElement>('[aria-label="Manage Assistant Connection (MCP)"]');
    expect(manage).not.toBeNull();
    expect(container.querySelector('[data-app-slug="assistant-connection"]')?.textContent).toContain("Claude");
    await act(() => manage!.click());
    expect(navigateMock).toHaveBeenCalledWith("/apps/assistant-connection");
    assistantConnectionsMock.mockResolvedValue([{ ...assistantGrant, revokedAt: "2026-10-06T01:00:00Z" }]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["mcp-connections"] }); });
    await flushReact();
    expect(container.querySelector('[data-app-slug="assistant-connection"]')).toBeNull();
  });

  it.each([
    ["empty", []],
    ["revoked", [{ ...assistantGrant, revokedAt: "2026-10-06T01:00:00Z" }]],
    ["another organization", [{ ...assistantGrant, companyId: "other-company" }]],
  ])("does not show %s assistant grants as installed", async (_label, grants) => {
    assistantConnectionsMock.mockResolvedValue(grants);
    await renderBrowse(false);
    await clickButton("Installed", container);
    expect(container.querySelector('[data-app-slug="assistant-connection"]')).toBeNull();
  });

  it("keeps pending assistant status visible in Installed until it can determine access", async () => {
    let resolve!: (rows: typeof assistantGrant[]) => void;
    assistantConnectionsMock.mockReturnValue(new Promise<typeof assistantGrant[]>(done => { resolve = done; }));
    await renderBrowse(false);
    await clickButton("Installed", container);
    expect(container.textContent).toContain("Checking your connection status");
    expect(container.textContent).not.toContain("No connectors match");
    await act(() => resolve([assistantGrant]));
    await flushReact();
    expect(container.querySelector('[aria-label="Manage Assistant Connection (MCP)"]')).not.toBeNull();
  });

  it("shows a retryable assistant status failure in Installed instead of an empty result", async () => {
    assistantConnectionsMock.mockRejectedValue(new Error("offline"));
    await renderBrowse(false);
    await clickButton("Installed", container);
    expect(container.textContent).toContain("Couldn’t load your connection status");
    expect(container.textContent).not.toContain("No connectors match");
    assistantConnectionsMock.mockResolvedValue([assistantGrant]);
    await clickButton("Try again", container);
    await flushReact();
    expect(container.querySelector('[aria-label="Manage Assistant Connection (MCP)"]')).not.toBeNull();
  });

  function indexedApp(name: string, providers: ("composio" | "arcade" | "executor")[] = ["composio"]): AggregatorAppCatalogEntry {
    const slug = name.toLowerCase().replaceAll(" ", "-");
    return { name, slug, aliases: [slug], routes: providers.map((provider) => ({
      provider, toolkit: slug, logoUrl: `https://logos.example.com/${slug}.svg`, docsUrl: `https://docs.${provider}.dev/${slug}`,
    })) };
  }

  async function search(value: string) {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search connectors"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  function composioFixture() {
    aggregatorCatalogMock.push(indexedApp("Circleback"));
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } })] });
    const snapshot = { connectionId: "conn-notion", toolkit: "circleback", status: "connected", checkedAt: new Date().toISOString(), accounts: [{ id: "ca-work", alias: "Meeting notes", status: "ACTIVE", isDefault: true }] };
    listComposioAppsMock.mockResolvedValue({ apps: [snapshot] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [snapshot] });
    return snapshot;
  }

  async function clickButton(text: string, scope: ParentNode = document) {
    const button = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.trim() === text)!;
    expect(button).toBeTruthy();
    await act(() => button.click());
    await flushReact();
  }

  async function accountMenu(action: string, name = "Meeting notes") {
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="Manage ${name}"]`)!;
    await act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === action)!;
    await act(() => item.click());
    await flushReact();
  }

  async function connectionMenu(name = "Meeting notes") {
    const trigger = container.querySelector<HTMLButtonElement>(`[data-app-slug="circleback"] button[aria-label="Manage ${name} connection"]`)!;
    expect(trigger).toBeTruthy();
    await act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }

  async function openComposioAccountMenu(name = "Composio account") {
    const trigger = container.querySelector<HTMLButtonElement>(`[data-app-slug="composio"] button[aria-label="Manage ${name} connection"]`)!;
    expect(trigger).toBeTruthy();
    await act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    return document.querySelector<HTMLElement>('[role="menu"]')!;
  }

  it("defaults to Paperclip with five chips, expands search to All, and retains explicit source scope", async () => {
    aggregatorCatalogMock.push(indexedApp("Remote App", ["composio"]));
    await renderBrowse(false);
    expect(container.querySelector('[aria-label="App filters"]')?.textContent).toBe("PaperclipComposioArcadeInstalledAll");
    expect(container.querySelector('[data-app-slug="remote-app"]')).toBeNull();
    await search("Remote App");
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toBe("All");
    expect(container.querySelector('[data-app-slug="remote-app"]')).toBeTruthy();
    await search("");
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toBe("Paperclip");
    await clickButton("Arcade", container);
    await search("Remote App");
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toBe("Arcade");
    expect(container.textContent).toContain("No connectors match");
    await clickButton("Clear search", container);
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toBe("Arcade");
  });

  it.each(["composio", "arcade"] as const)("scopes %s to its catalog and accounts without native catalog overlaps", async (provider) => {
    const otherProvider = provider === "composio" ? "arcade" : "composio";
    const providerName = provider === "composio" ? "Composio" : "Arcade";
    aggregatorCatalogMock.push(indexedApp("Notion", [provider]), indexedApp("Remote App", [provider]), indexedApp("Other App", [otherProvider]));
    listGalleryMock.mockResolvedValue({ apps: ["notion", provider, otherProvider].map(getAppStoreDefinition) });
    listApplicationsMock.mockResolvedValue({ applications: [application(), application({ id: "gateway-app", name: providerName, metadata: { sourceTemplateKey: provider } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ name: "Native Notion" }), connection({ id: "gateway", applicationId: "gateway-app", name: `${providerName} account`, config: { sourceTemplateKey: provider } })] });
    listComposioAppsMock.mockResolvedValue({ apps: [{ provider, appSlug: "notion", appName: "Notion", connectionId: "gateway", toolkit: "notion", status: "not_connected", accounts: [] }] });
    await renderBrowse(false);
    expect(container.querySelector('[data-app-slug="notion"]')).toBeTruthy();

    await clickButton(providerName, container);
    expect(container.querySelector(`[data-app-slug="${provider}"]`)).toBeTruthy();
    expect(container.querySelector('[data-app-slug="remote-app"]')).toBeTruthy();
    expect(container.querySelector('[data-app-slug="notion"]')).toBeNull();
    expect(container.querySelector(`[data-app-slug="${otherProvider}"]`)).toBeNull();
    expect(container.querySelector('[data-app-slug="other-app"]')).toBeNull();

    await search("Notion");
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toBe(providerName);
    expect(container.textContent).toContain("No connectors match");
    await clickButton("All", container);
    expect(container.querySelector('[data-app-slug="notion"]')?.textContent).toContain("Native Notion");
  });

  it("does not reuse another viewing user's managed-account cache", async () => {
    composioFixture();
    const client = await renderBrowse(false);
    expect(container.textContent).toContain("Meeting notes");
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    accountIdentity.userId = "another-user";
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><Browse /></TooltipProvider></QueryClientProvider>));
    await flushReact();
    expect(container.textContent).not.toContain("Meeting notes");
    expect(client.getQueryData(queryKeys.tools.aggregatorApps("conn-notion", "board-user"))).toBeTruthy();
    expect(client.getQueryData<{ apps: unknown[] }>(queryKeys.tools.aggregatorApps("conn-notion", "another-user"))?.apps).toEqual([]);
  });

  it("groups native and matching-label accounts across providers and gateways without dropping any lines", async () => {
    aggregatorCatalogMock.push(indexedApp("Notion", ["composio", "arcade"]));
    listGalleryMock.mockResolvedValue({ apps: ["notion", "composio", "arcade", "executor"].map(getAppStoreDefinition) });
    const gateways = ["composio", "arcade", "executor", "arcade"];
    listApplicationsMock.mockResolvedValue({ applications: [application(), ...gateways.map((provider, index) => application({ id: `app-${index}`, name: provider, metadata: { sourceTemplateKey: provider } }))] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ name: "Native" }), ...gateways.map((provider, index) => connection({ id: `gateway-${index}`, applicationId: `app-${index}`, name: `Gateway ${index}`, config: { sourceTemplateKey: provider } }))] });
    listComposioAppsMock.mockImplementation((id: string) => ({ apps: [{ provider: gateways[Number(id.split("-")[1])], appSlug: "notion", appName: "Notion", connectionId: id, toolkit: "notion", checkedAt: new Date().toISOString(), status: "connected", accounts: [{ id: "same-id", alias: "Work", status: "ACTIVE", isDefault: false }] }] }));
    await renderBrowse(false);
    expect(container.querySelectorAll('[data-app-slug="notion"]')).toHaveLength(1);
    const row = container.querySelector('[data-app-slug="notion"]')!;
    await clickButton("5 connections", row);
    expect(row.querySelectorAll('button[aria-label="Manage Work connection"]')).toHaveLength(4);
    expect(row.textContent).toContain("Native");
    for (const provider of ["Composio", "Arcade", "Executor"]) expect(row.textContent).toContain(`Managed by ${provider}`);
    await clickButton("Arcade", container);
    expect(container.querySelectorAll('[data-app-slug="notion"] button[aria-label="Manage Work connection"]')).toHaveLength(4);
    expect(container.querySelector('[data-app-slug="notion"] button[aria-label="Connect Notion"]')).toBeNull();
  });

  it("offers only provider management in imported account menus", async () => {
    composioFixture();
    await renderBrowse();
    const items = await connectionMenu();
    expect(items.map(item => item.textContent?.trim())).toEqual(["Open in Composio"]);
    expect(items[0].getAttribute("href")).toBe("https://dashboard.composio.dev/~/org/connect/apps");
    expect(items[0].getAttribute("target")).toBe("_blank");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(manageComposioAppAccountMock).not.toHaveBeenCalled();
    expect(archiveConnectionMock).not.toHaveBeenCalled();
  });

  it("does not expose local deletion or renaming for imported accounts", async () => {
    composioFixture();
    await renderBrowse();
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Manage Meeting notes connection"]')!;
    await act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Open in Composio");
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Remove connection");
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Rename");
    expect(manageComposioAppAccountMock).not.toHaveBeenCalled();
  });

  it("shows verified upstream accounts as installed on every page, searches their labels, and opens Manage", async () => {
    composioFixture();
    listUserDirectoryMock.mockResolvedValue({ users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: null } }] });
    aggregatorCatalogMock.push(...Array.from({ length: 60 }, (_, index) => indexedApp(`Indexed App ${index}`)));
    await renderBrowse();
    const circleback = container.querySelector('[data-app-slug="circleback"]')!;
    expect(circleback.getAttribute("data-connected")).toBe("true");
    expect(circleback.textContent).toContain("Accounts managed in Composio.");
    expect(circleback.textContent).toContain("Managed by Composio ·“Composio account”");
    expect(circleback.textContent).not.toContain("Connected by");
    expect(circleback.textContent).not.toContain("Dotta");
    expect(circleback.querySelector('[title="Connected"]')).toBeTruthy();
    expect(circleback.querySelector('button[aria-label="Manage Meeting notes"]')).toBeTruthy();
    expect(circleback.querySelector('button[aria-label="Connect Circleback"]')).toBeNull();
    await clickButton("Next", container);
    expect(container.querySelector('[data-app-slug="circleback"] button[aria-label="Manage Circleback"]')).toBeTruthy();
    await search("Meeting notes");
    expect(container.querySelectorAll('[data-app-slug="circleback"]')).toHaveLength(1);
    await clickButton("Manage", container);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Meeting notes");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('“Composio account”');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Accounts and sign-in are managed in Composio.");
    expect(document.querySelectorAll('[role="dialog"] a[href="/apps/conn-notion/permissions"]')).toHaveLength(1);
    expect(openNewIssueMock).not.toHaveBeenCalled();
  });

  it("uses the waiting status for an aggregator account until sign-in is verified", async () => {
    const snapshot = composioFixture();
    const pending = { ...snapshot, status: "not_connected", accounts: [{ ...snapshot.accounts[0], status: "INITIATED" }] };
    listComposioAppsMock.mockResolvedValue({ apps: [pending] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [pending] });
    await renderBrowse();
    const circleback = container.querySelector('[data-app-slug="circleback"]')!;
    expect(circleback.textContent).toContain("Waiting for sign-in");
    expect(circleback.textContent).toContain("Finish connecting this account.");
    expect(circleback.querySelector('[title="Connected"]')).toBeNull();
    await act(() => circleback.querySelector<HTMLButtonElement>('button[aria-label="Manage Meeting notes"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Manage Circleback");
  });

  it("discovers app authorization on refresh and reflects a disconnection when returning from Composio", async () => {
    composioFixture();
    const response = await listComposioAppsMock();
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    syncComposioAppsMock.mockResolvedValue(response);
    await renderBrowse();
    await vi.waitFor(() => expect(container.querySelector('[data-app-slug="circleback"]')?.getAttribute("data-connected")).toBe("true"));
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    syncComposioAppsMock.mockResolvedValue({ apps: [] });
    await act(() => focusManager.setFocused(false));
    await act(() => focusManager.setFocused(true));
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="Connect Circleback"]')).toBeTruthy());
    focusManager.setFocused(undefined);
    expect(setupComposioAppMock).not.toHaveBeenCalled();
  });

  it("opens provider-owned management and refreshes observed accounts without mutation", async () => {
    const snapshot = composioFixture();
    await renderBrowse();
    await clickButton("Manage", container);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Accounts and sign-in are managed in Composio.");
    expect(dialog.querySelector('a[href="https://dashboard.composio.dev/~/org/connect/apps"]')?.getAttribute("target")).toBe("_blank");
    expect(dialog.textContent).not.toContain("Rename");
    expect(dialog.textContent).not.toContain("Disconnect");
    const disconnected = { ...snapshot, status: "not_connected", accounts: [] };
    refreshComposioAppsMock.mockResolvedValue({ apps: [disconnected] });
    await clickButton("Refresh", dialog);
    expect(refreshComposioAppsMock).toHaveBeenCalledWith("conn-notion", ["circleback"]);
    expect(dialog.textContent).toContain("No connected Circleback accounts.");
    expect(manageComposioAppAccountMock).not.toHaveBeenCalled();
    expect(setupComposioAppMock).not.toHaveBeenCalled();
  });

  it("preserves failed observations with an unverified status and offers retry", async () => {
    const snapshot = composioFixture();
    listComposioAppsMock.mockResolvedValue({ apps: [{ ...snapshot, errorAt: new Date().toISOString() }], sync: { status: "error", error: "Unavailable" } });
    await renderBrowse();
    expect(container.querySelector('button[aria-label="Manage Circleback"]')).toBeTruthy();
    expect(container.querySelector('[data-app-slug="circleback"] [title="Connected"]')).toBeNull();
    expect(container.textContent).toContain("Last known account · Refresh to verify");
    expect(container.textContent).toContain("Unavailable");
    const menu = await openComposioAccountMenu();
    await act(() => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === "Refresh Composio")!.click());
    await flushReact();
    expect(syncComposioAppsMock).toHaveBeenCalledWith("conn-notion", true);
  });

  it("refreshes only the selected Composio account while another account is syncing", async () => {
    composioFixture();
    const work = connection({ id: "conn-work", applicationId: "gateway-app", name: "Work Composio", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } });
    const personal = connection({ id: "conn-personal", applicationId: "gateway-app", name: "Personal Composio", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } });
    listConnectionsMock.mockResolvedValue({ connections: [work, personal] });
    listComposioAppsMock.mockImplementation((id: string) => Promise.resolve({ apps: [], sync: { status: id === "conn-work" ? "syncing" : "ready" } }));
    await renderBrowse();
    expect(container.textContent).not.toContain("Refresh Composio");
    await clickButton("2 connections", container.querySelector('[data-app-slug="composio"]')!);
    let menu = await openComposioAccountMenu("Work Composio");
    expect(Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === "Refresh Composio")?.getAttribute("aria-disabled")).toBe("true");
    await act(() => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flushReact();
    menu = await openComposioAccountMenu("Personal Composio");
    const refresh = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === "Refresh Composio")!;
    expect(refresh.getAttribute("aria-disabled")).not.toBe("true");
    syncComposioAppsMock.mockClear();
    await act(() => refresh.click());
    await flushReact();
    expect(syncComposioAppsMock.mock.calls.filter(([, force]) => force === true)).toEqual([["conn-personal", true]]);
  });

  it("discovers native-overlap accounts without adding an aggregator connect offer", async () => {
    const snapshot = composioFixture();
    aggregatorCatalogMock.push(indexedApp("Notion"));
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio"), getAppStoreDefinition("notion")] });
    listComposioAppsMock.mockResolvedValue({ apps: [{ ...snapshot, toolkit: "notion", accounts: [{ ...snapshot.accounts[0], alias: "Imported workspace" }] }] });
    await renderBrowse();
    const row = container.querySelector('[data-app-slug="notion"]')!;
    expect(row.textContent).toContain("Imported workspace");
    expect(row.textContent).toContain("Managed by Composio ·“Composio account”");
    expect(row.querySelector('button[aria-label*="third-party"]')).toBeNull();
    expect(row.querySelector('button[aria-label="Connect Notion"]')).toBeTruthy();
    expect(syncComposioAppsMock).toHaveBeenCalledWith("conn-notion");
    expect(refreshComposioAppsMock).not.toHaveBeenCalled();
  });

  it("suppresses aggregator routes for native apps, including hidden native connectors", async () => {
    aggregatorCatalogMock.push(indexedApp("Notion", ["composio", "arcade"]), indexedApp("Google Sheets"), indexedApp("GitHub API"), indexedApp("Context7"), indexedApp("HubSpot", ["composio", "arcade"]));
    await renderBrowse();
    expect(container.querySelectorAll('[data-app-slug="notion"]')).toHaveLength(1);
    expect(container.querySelector('[data-app-slug="notion"] button[aria-label*="third-party"]')).toBeNull();
    expect(container.querySelector('[data-app-slug="google-sheets"]')).toBeNull();
    expect(container.querySelector('[data-app-slug="github-api"]')).toBeNull();
    expect(container.querySelector('[data-app-slug="context7"]')).toBeNull();
    expect(container.querySelectorAll('[data-app-slug="hubspot"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-app-slug="hubspot"] button[aria-label*="third-party"]')).toHaveLength(2);
  });

  it("paginates the catalog while keeping installed connectors above every page and resets on search", async () => {
    aggregatorCatalogMock.push(...Array.from({ length: 60 }, (_, index) => indexedApp(`Indexed App ${String(index).padStart(2, "0")}`)));
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({ connections: [connection()] });
    await renderBrowse();
    expect(container.querySelectorAll('[data-connected="false"][data-app-slug]:not([data-app-slug="custom-mcp"]):not([data-app-slug="assistant-connection"])')).toHaveLength(50);
    expect(container.querySelector('[aria-label="Connector list"] > [data-app-slug]:not([data-app-slug="assistant-connection"])')?.getAttribute("data-app-slug")).toBe("notion");
    const next = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Next")!;
    await act(() => next.click());
    expect(container.textContent).toContain("Page 2 of");
    expect(container.querySelector('[aria-label="Connector list"] > [data-app-slug]:not([data-app-slug="assistant-connection"])')?.getAttribute("data-app-slug")).toBe("notion");
    await search("Indexed App 59");
    expect(container.textContent).toContain("Page 1 of 1");
    expect(container.querySelector('[data-app-slug="indexed-app-59"]')).not.toBeNull();
    await search("no-such-app");
    expect(container.textContent).toContain("No connectors match");
    expect(container.querySelector('[aria-label="Connector catalog pages"]')).toBeNull();
  });

  it("offers each provider once and carries the exact selected toolkit to setup", async () => {
    aggregatorCatalogMock.push(indexedApp("HubSpot", ["composio", "arcade"]));
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect HubSpot"]')!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Which service would you like to use?");
    await act(() => Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent?.includes("Arcade"))!.click());
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?source=arcade&targetToolkit=hubspot");
  });

  it.each(["composio", "arcade"] as const)("skips provider selection and opens setup for a sole %s provider", async (provider) => {
    const app = indexedApp("Circleback", [provider]);
    app.routes[0].toolkit = "circle_back";
    aggregatorCatalogMock.push(app);
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Circleback"]')!.click());
    expect(navigateMock).toHaveBeenCalledWith(`/apps/connect?source=${provider}&targetToolkit=circle_back`);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the saved gateway flow directly for a sole provider and allows cancellation", async () => {
    aggregatorCatalogMock.push(indexedApp("Circleback"));
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", config: { sourceTemplateKey: "composio" } })] });
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Circleback"]')!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Connect Circleback through Composio");
    expect(dialog.textContent).not.toContain("Which service would you like to use?");
    expect(dialog.textContent).not.toContain("Back");
    expect(dialog.textContent).not.toContain("Connection settings");
    expect(dialog.textContent).not.toContain("An agent can check Circleback in Composio");
    expect(dialog.querySelector('[data-slot="badge"]')).toBeNull();
    expect(dialog.querySelector<HTMLSelectElement>('#composio-app-account')?.value).toBe("conn-notion");
    expect(dialog.querySelector('#composio-app-agent')).toBeNull();
    expect(dialog.textContent).not.toContain("Which agent");
    expect(dialog.textContent).not.toContain("Using");
    expect(dialog.textContent).not.toContain("Use another account");
    expect(dialog.querySelector('a[href="https://dashboard.composio.dev/~/org/connect/apps"]')).toBeNull();
    expect(listAgentsMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    await act(() => Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("configures an app directly through a saved gateway without creating an agent task", async () => {
    setupComposioAppMock.mockResolvedValueOnce({ status: "authorization_required", authorizationUrl: "https://connect.composio.dev/link/test" })
      .mockRejectedValueOnce(new Error("Finish connecting this app in Composio, then check again")).mockResolvedValueOnce({ status: "connected" });
    aggregatorCatalogMock.push(indexedApp("HubSpot", ["composio", "arcade"]));
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", config: { sourceTemplateKey: "composio" } })] });
    await renderBrowse();
    expect(container.querySelector('[data-app-slug="hubspot"]')?.getAttribute("data-connected")).toBe("false");
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect HubSpot"]')!.click());
    await act(() => Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((button) => button.textContent?.includes("Composio"))!.click());
    expect(document.querySelector<HTMLSelectElement>('#composio-app-account')?.value).toBe("conn-notion");
    expect(navigateMock).not.toHaveBeenCalled();
    await act(() => Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((button) => button.textContent === "Continue")!.click());
    await vi.waitFor(() => expect(setupComposioAppMock).toHaveBeenCalledWith("conn-notion", "hubspot", { action: "start" }));
    await vi.waitFor(() => expect(document.querySelector('a[href="https://connect.composio.dev/link/test"]')).not.toBeNull());
    expect(openNewIssueMock).not.toHaveBeenCalled();
    await act(() => Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((button) => button.textContent === "I’ve connected it")!.click());
    await vi.waitFor(() => expect(setupComposioAppMock).toHaveBeenCalledWith("conn-notion", "hubspot", { action: "complete" }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Finish connecting"));
    expect(document.querySelector('a[href="https://connect.composio.dev/link/test"]')).not.toBeNull();
    await act(() => Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((button) => button.textContent === "I’ve connected it")!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(pushToastMock).toHaveBeenCalledWith({ title: "HubSpot is connected through Composio.", tone: "success" });
    expect(openNewIssueMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("uses the selected saved Composio account and clears the previous account's sign-in link", async () => {
    composioFixture();
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [] });
    listConnectionsMock.mockResolvedValue({ connections: [
      connection({ applicationId: "gateway-app", name: "Work Composio", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } }),
      connection({ id: "conn-personal", applicationId: "gateway-app", name: "Personal Composio", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } }),
      connection({ id: "conn-paused", applicationId: "gateway-app", name: "Paused Composio", enabled: false, config: { sourceTemplateKey: "composio" } }),
    ] });
    listAgentsMock.mockRejectedValue(new Error("Agents are unavailable"));
    setupComposioAppMock.mockReset().mockResolvedValueOnce({ status: "authorization_required", authorizationUrl: "https://connect.composio.dev/link/personal" }).mockResolvedValueOnce({ status: "connected" });
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Circleback"]')!.click());
    const select = document.querySelector<HTMLSelectElement>('#composio-app-account')!;
    expect(Array.from(select.options).map(option => option.textContent)).toEqual(["Work Composio", "Personal Composio", "Connect a new account…"]);
    await act(() => { select.value = "conn-personal"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushReact();
    await clickButton("Continue", document.querySelector('[role="dialog"]')!);
    expect(setupComposioAppMock).toHaveBeenCalledWith("conn-personal", "circleback", { action: "start" });
    expect(document.querySelector('a[href="https://connect.composio.dev/link/personal"]')).toBeTruthy();
    await act(() => { select.value = "conn-notion"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushReact();
    expect(document.querySelector('a[href="https://connect.composio.dev/link/personal"]')).toBeNull();
    await clickButton("Continue", document.querySelector('[role="dialog"]')!);
    expect(setupComposioAppMock).toHaveBeenLastCalledWith("conn-notion", "circleback", { action: "start" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(listAgentsMock).not.toHaveBeenCalled();
    expect(openNewIssueMock).not.toHaveBeenCalled();
    listAgentsMock.mockResolvedValue([]);
  });

  it("offers a new Composio account in the dropdown and carries the requested app into setup", async () => {
    composioFixture();
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [] });
    setupComposioAppMock.mockReset();
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Circleback"]')!.click());
    const select = document.querySelector<HTMLSelectElement>('#composio-app-account')!;
    await act(() => { select.value = "__new__"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushReact();
    expect(navigateMock).not.toHaveBeenCalled();
    await clickButton("Connect new account", document.querySelector('[role="dialog"]')!);
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?source=composio&targetToolkit=circleback&new=1");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(setupComposioAppMock).not.toHaveBeenCalled();
    expect(listAgentsMock).not.toHaveBeenCalled();
  });

  it("returns from Composio gateway setup directly to its app flow even with multiple providers", async () => {
    aggregatorCatalogMock.push(indexedApp("HubSpot", ["composio", "arcade"]));
    window.history.replaceState({}, "", "/apps?source=composio&targetToolkit=hubspot");
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", config: { sourceTemplateKey: "composio" } })] });
    await renderBrowse();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("through Composio"));
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Which service would you like to use?");
    expect(document.querySelector<HTMLSelectElement>('#composio-app-account')?.value).toBe("conn-notion");
    expect(document.querySelector('#composio-app-agent')).toBeNull();
    expect(openNewIssueMock).not.toHaveBeenCalled();
  });

  it("shows retirement guidance before paused state for an obsolete Composio account", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "old-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "old-app", enabled: false, healthStatus: "error", transport: "rest_api", config: { sourceTemplateKey: "composio", connectionMethodKey: "api-key" } })] });
    await renderBrowse();
    expect(container.textContent).toContain("Retired");
    expect(container.textContent).toContain("Add a new Composio MCP connection");
    expect(container.textContent).not.toContain("Paused");
  });

  const googleSlugs = [
    "google-workspace",
    "gmail", "google-drive", "google-docs", "google-sheets", "google-slides",
    "google-calendar", "google-chat", "google-people", "google-workspace-search",
  ];

  it("offers one Google Workspace connector while retaining the individual service definitions", async () => {
    const definitions = googleSlugs.map((slug) => getAppStoreDefinition(slug)!);
    listGalleryMock.mockResolvedValue({ apps: [...definitions, getAppStoreDefinition("notion")] });
    const client = await renderBrowse();

    for (const definition of definitions) {
      expect(definition.methods.length).toBeGreaterThan(0);
      expect(getAppStoreDefinition(definition.slug)).toBe(definition);
      if (definition.slug === "google-workspace") {
        expect(container.querySelectorAll('[data-app-slug="google-workspace"]')).toHaveLength(1);
      } else {
        expect(container.querySelector(`[data-app-slug="${definition.slug}"]`)).toBeNull();
      }
    }
    expect(container.querySelector('[data-app-slug="notion"]')).not.toBeNull();
    expect(client.getQueryData(queryKeys.apps.gallery("company-1"))).toEqual({
      apps: [...definitions, getAppStoreDefinition("notion")],
    });
    expect(archiveConnectionMock).not.toHaveBeenCalled();
    await clickButton("Connect", container.querySelector('[data-app-slug="google-workspace"]')!);
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?source=google-workspace");
  });

  it.each(["active", "draft", "disabled"])(
    "shows saved Google %s accounts without changing their access or status",
    async (status) => {
      const applications = googleSlugs.map((slug) => application({
        id: `app-${slug}`, name: `Saved ${slug}`, applicationKey: `app-gallery:${slug}:one`,
        metadata: { sourceTemplateKey: slug },
      }));
      const connections = googleSlugs.map((slug) => connection({
        id: `conn-${slug}`, applicationId: `app-${slug}`, name: `Account for ${slug}`,
        status, enabled: status !== "disabled", config: { sourceTemplateKey: slug },
      }));
      listGalleryMock.mockResolvedValue({ apps: googleSlugs.map(getAppStoreDefinition) });
      listApplicationsMock.mockResolvedValue({ applications });
      listConnectionsMock.mockResolvedValue({ connections });
      const client = await renderBrowse();

      for (const slug of googleSlugs) {
        expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
        expect(container.textContent).toContain(`Account for ${slug}`);
      }
      expect(client.getQueryData(queryKeys.tools.connections("company-1"))).toEqual({ connections });
      expect(client.getQueryData(queryKeys.tools.applications("company-1"))).toEqual({ applications });
      expect(archiveConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["config", "transportConfig"])(
    "shows a Google account identified by %s even when its gallery entry is absent",
    async (sourceField) => {
      listGalleryMock.mockResolvedValue({ apps: [] });
      listApplicationsMock.mockResolvedValue({ applications: [application({
        id: "legacy-google", name: "My documents", applicationKey: null, metadata: null,
      }), application()] });
      listConnectionsMock.mockResolvedValue({ connections: [connection({
        id: "legacy-google-account", applicationId: "legacy-google", name: "Saved Google account",
        config: {}, transportConfig: {}, [sourceField]: { sourceTemplateKey: "google-docs" },
      }), connection()] });
      await renderBrowse();

      expect(container.textContent).toContain("Saved Google account");
      expect(container.textContent).toContain("Notion");
      expect(archiveConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["catalog", "custom"])(
    "preserves both Google and non-Google accounts in a mixed-provider %s row",
    async (rowKind) => {
      const notion = getAppStoreDefinition("notion")!;
      listGalleryMock.mockResolvedValue({ apps: rowKind === "catalog" ? [notion] : [] });
      listApplicationsMock.mockResolvedValue({ applications: [application(rowKind === "custom"
        ? { name: "My tools", applicationKey: null, metadata: null }
        : {})] });
      const connections = [connection({
        id: "google-account", name: "Saved Google account",
        config: { sourceTemplateKey: "google-docs" },
      }), connection({
        id: "notion-account", name: "Visible Notion account",
        config: { sourceTemplateKey: "notion" },
      })];
      listConnectionsMock.mockResolvedValue({ connections });
      const client = await renderBrowse();

      await clickButton("2 connections");
      expect(container.textContent).toContain("Visible Notion account");
      expect(container.textContent).toContain("Saved Google account");
      expect(container.textContent).toContain(rowKind === "catalog" ? "Notion" : "My tools");
      expect(client.getQueryData(queryKeys.tools.connections("company-1"))).toEqual({ connections });
      expect(archiveConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["metadata", "applicationKey"])(
    "keeps a non-Google custom connector identified by %s and its saved Google account",
    async (sourceField) => {
      listGalleryMock.mockResolvedValue({ apps: [] });
      const savedApplication = application({
        name: "My custom connector",
        metadata: sourceField === "metadata" ? { sourceTemplateKey: "custom-provider" } : null,
        applicationKey: sourceField === "applicationKey" ? "custom-provider" : null,
      });
      listApplicationsMock.mockResolvedValue({ applications: [savedApplication] });
      const connections = [connection({
        name: "Saved Google account", config: { sourceTemplateKey: "google-docs" },
      })];
      listConnectionsMock.mockResolvedValue({ connections });
      const client = await renderBrowse();

      expect(container.querySelector('[data-app-slug="custom-provider"]')).not.toBeNull();
      expect(container.textContent).toContain("My custom connector");
      expect(container.textContent).toContain("Saved Google account");
      expect(client.getQueryData(queryKeys.tools.applications("company-1"))).toEqual({ applications: [savedApplication] });
      expect(client.getQueryData(queryKeys.tools.connections("company-1"))).toEqual({ connections });
      expect(archiveConnectionMock).not.toHaveBeenCalled();
    },
  );

  it("hides cached memory connectors until enabled and preserves saved MCP connections", async () => {
    const providers = ["mem0", "zep", "supermemory", "cognee", "honcho"];
    listGalleryMock.mockResolvedValue({ apps: [...providers, "notion"].map(getAppStoreDefinition) });
    const client = await renderBrowse();
    for (const slug of providers) expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
    expect(container.querySelector('[data-app-slug="notion"]')).not.toBeNull();
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableMemoryConnectors: true }); });
    await flushReact();
    for (const slug of providers) expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
    await act(() => {
      client.setQueryData(queryKeys.tools.connections("company-1"), { connections: [connection({ id: "saved", applicationId: "saved-app", config: { sourceTemplateKey: "mem0", connectionMethodKey: "mcp" }, transport: "mcp_remote" })] });
      client.setQueryData(queryKeys.tools.applications("company-1"), { applications: [application({ id: "saved-app", name: "Mem0", metadata: { sourceTemplateKey: "mem0" } })] });
      client.setQueryData(queryKeys.instance.experimentalSettings, { enableMemoryConnectors: false });
    });
    await flushReact();
    expect(container.textContent).toContain("Mem0");
    for (const slug of ["zep", "supermemory", "cognee", "honcho"]) expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
  });

  it("shows all MCP aggregators by default and ignores cached legacy opt-outs", async () => {
    const providers = ["zapier", "arcade", "composio", "executor"];
    listGalleryMock.mockResolvedValue({ apps: [...providers, "notion"].map(getAppStoreDefinition) });
    const client = await renderBrowse();
    for (const slug of providers) expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableMcpAggregators: false }); });
    await flushReact();
    for (const slug of providers) expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
  });

  it("defaults to tools-only GitHub and hides chat-only catalog and existing chat accounts", async () => {
    experimentalMock.mockResolvedValue({});
    listGalleryMock.mockResolvedValue({ apps: ["agentmail", "github", "github-code-review-bot", "discord", "telegram", "microsoft-teams"].map(getAppStoreDefinition) });
    listApplicationsMock.mockResolvedValue({ applications: [application({
      id: "chat-app", type: "chat", name: "Private bot", applicationKey: "chat:github:endpoint-1", metadata: { purpose: "channel" },
    })] });
    await renderBrowse();
    expect(chatListMock).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-app-slug="github"]')).not.toBeNull();
    for (const slug of ["github-code-review-bot", "discord", "telegram", "microsoft-teams", "slack"]) {
      expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
    }
    expect(container.textContent).not.toContain("Private bot");
    expect(container.querySelector('[data-app-slug="agentmail"]')).not.toBeNull();
    await act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Connect AgentMail"]')!.click());
    expect(navigateMock.mock.lastCall?.[0]).toContain("/apps/chat/connect?provider=agentmail");
    expect(container.textContent).not.toContain("Chat with agents");
    await act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Add key GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github");
    const copilot = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Connect Copilot")!;
    expect(copilot).toBeTruthy();
    await act(() => void copilot.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github&method=copilot-token");
  });

  it("names what the card will actually ask for", async () => {
    // PAP-659 C4. The verb is derived from the connector's resolved default
    // method, so it changes with what this instance can do rather than being a
    // fixed string: Notion signs in, GitHub-without-the-cloud-connector wants a
    // token, and GitHub with it signs in too.
    const github = getAppStoreDefinition("github")!;
    listGalleryMock.mockResolvedValue({
      apps: [
        getAppStoreDefinition("notion"),
        { ...github, ownershipAvailability: { ...github.ownershipAvailability, platform_shared: true } },
      ],
    });
    await renderBrowse();
    expect(container.querySelector('button[aria-label="Connect Notion"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Connect GitHub"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Add key GitHub"]')).toBeNull();
  });

  it("separates tools and saved bots and gates bots independently of chat connectors", async () => {
    listGalleryMock.mockResolvedValue({ apps: ["github", "github-code-review-bot"].map(getAppStoreDefinition) });
    listApplicationsMock.mockResolvedValue({ applications: [
      application({ id: "github-tools", name: "GitHub", metadata: { sourceTemplateKey: "github" } }),
      application({ id: "chat-app", type: "chat", name: "Legacy bot", metadata: { sourceTemplateKey: "github", purpose: "channel" } }),
    ] });
    listConnectionsMock.mockResolvedValue({ connections: [
      connection({ id: "github-account", applicationId: "github-tools", name: "My GitHub" }),
      connection({ id: "chat-tools", applicationId: "chat-app", connectionPurpose: "channel" }),
    ] });
    chatListMock.mockResolvedValue([
      { id: "endpoint-1", provider: "github", status: "active", assignedAgentName: "Review agent", botLabel: "Review bot", assignedAgentId: "agent-1" },
      { id: "endpoint-2", provider: "github", status: "draft", assignedAgentName: "Draft agent", assignedAgentId: "agent-2" },
    ]);
    const client = await renderBrowse();
    const tools = container.querySelector('[data-app-slug="github"]')!;
    const bots = container.querySelector('[data-app-slug="github-code-review-bot"]')!;
    expect(tools.textContent).toContain("My GitHub");
    expect(tools.textContent).not.toContain("Review agent");
    expect(bots.textContent).toContain("Review agent · Code review bot");
    expect(bots.textContent).toContain("Draft agent");
    expect(bots.textContent).not.toContain("My GitHub");
    expect(container.textContent).not.toContain("Legacy bot");
    await act(() => void tools.querySelector<HTMLButtonElement>('button[aria-label="Add account GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github&applicationId=github-tools&name=GitHub&new=1");
    await act(() => void bots.querySelector<HTMLButtonElement>('button[aria-label="Add connection GitHub Code Review Bot"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/connect?provider=github&purpose=chat");
    const finish = [...bots.querySelectorAll("button")].find((button) => button.textContent === "Finish setup")!;
    await act(() => finish.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/connect?provider=github&purpose=chat&resume=endpoint-2");
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: false, enableGitHubReviewBots: true }); });
    await flushReact();
    expect(container.querySelector('[data-app-slug="github-code-review-bot"]')).not.toBeNull();
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: true, enableGitHubReviewBots: false }); });
    await flushReact();
    expect(container.querySelector('[data-app-slug="github-code-review-bot"]')).toBeNull();
    expect(container.textContent).not.toContain("Review agent");
    expect(container.querySelector('[data-app-slug="github"]')).not.toBeNull();
  });

  it("keeps the GitHub tool card when the chat catalog needs its local fallback", async () => {
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("github")] });
    await renderBrowse();
    expect(container.querySelector('[data-app-slug="github"]')).not.toBeNull();
    expect(container.querySelector('[data-app-slug="github-code-review-bot"]')).not.toBeNull();
    await act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Add key GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github");
    await act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Connect GitHub Code Review Bot"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/connect?provider=github&purpose=chat");
  });

  it("renders one connector list with the requested header and no gallery sections", async () => {
    await renderBrowse();

    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Connectors" }]);
    expect(setBreadcrumbsMock).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ href: "/dashboard" })]),
    );
    expect(container.querySelector("header")?.textContent).not.toContain(
      "Connectors",
    );
    expect(
      container.querySelector('header input[aria-label="Search connectors"]'),
    ).toBeTruthy();
    expect(container.querySelector("header")?.classList).toContain(
      "items-center",
    );
    expect(container.querySelector("header")?.classList).not.toContain(
      "justify-end",
    );
    expect(container.querySelector('[aria-label="Popular apps"]')).toBeNull();
    expect(container.querySelector('[aria-label="Connected apps"]')).toBeNull();
    expect(container.querySelector('[aria-label="All apps"]')).toBeNull();
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>(
          '[aria-label="Connector list"] > [data-app-slug]',
        ),
      ).map((row) => row.dataset.appSlug),
    ).toEqual([
      "assistant-connection",
      "agentmail",
      "discord",
      "github-code-review-bot",
      "imessage-photon",
      "jira",
      "microsoft-teams",
      "notion",
      "slack",
      "speko",
      "telegram",
      "custom-mcp",
    ]);
    expect(
      container.querySelector('button[aria-label="Connect Jira"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-app-slug="gmail"]')).toBeNull();
    expect(container.textContent).toContain("Connect your own tool");

    const customConnect = container.querySelector<HTMLButtonElement>(
      '[data-app-slug="custom-mcp"] button',
    );
    await act(async () => {
      customConnect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connect your own MCP server");
    expect(container.textContent).toContain("Paste a config");
    expect(container.textContent).not.toContain("Run your own");

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) =>
          button.textContent?.includes("Connect your own MCP server"),
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/byo");

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Paste a config"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/advanced/paste-config");
  });

  it("folds healthy multi-account lists behind a connection-count toggle", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection(),
        connection({ id: "conn-ops", name: "ops@example.com" }),
        connection({ id: "conn-eng", name: "eng@example.com" }),
      ],
    });
    await renderBrowse();

    const notion = container.querySelector<HTMLElement>('[data-app-slug="notion"]')!;
    const toggle = Array.from(notion.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.textContent?.trim() === "3 connections")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(notion.textContent).not.toContain("ops@example.com");

    await clickButton("3 connections", notion);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    for (const name of ["devinfoley@gmail.com", "ops@example.com", "eng@example.com"]) expect(notion.textContent).toContain(name);

    await clickButton("3 connections", notion);
    expect(notion.textContent).not.toContain("ops@example.com");

    await search("ops@example");
    expect(container.querySelector('[data-app-slug="notion"]')?.textContent).toContain("ops@example.com");
  });

  it("reopens connection lists whenever the search query changes", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({
      connections: [connection(), connection({ id: "conn-ops", name: "ops@example.com" }),
        connection({ id: "conn-eng", name: "eng@example.com" })],
    });
    await renderBrowse();
    await search("ops@example");
    let notion = container.querySelector<HTMLElement>('[data-app-slug="notion"]')!;
    expect(notion.textContent).toContain("ops@example.com");
    await clickButton("3 connections", notion);
    expect(notion.textContent).not.toContain("ops@example.com");

    await search("eng@example");
    notion = container.querySelector<HTMLElement>('[data-app-slug="notion"]')!;
    expect(notion.textContent).toContain("eng@example.com");
    await search("ops@example");
    expect(container.querySelector('[data-app-slug="notion"]')?.textContent).toContain("ops@example.com");
  });

  it("keeps a single account inline and opens lists that need attention", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({ connections: [connection()] });
    await renderBrowse();
    let notion = container.querySelector<HTMLElement>('[data-app-slug="notion"]')!;
    expect(notion.textContent).toContain("devinfoley@gmail.com");
    expect(notion.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();

    act(() => root.unmount());
    listConnectionsMock.mockResolvedValue({
      connections: [connection(), connection({ id: "conn-draft", name: "draft@example.com", status: "draft" })],
    });
    await renderBrowse();
    notion = container.querySelector<HTMLElement>('[data-app-slug="notion"]')!;
    expect(notion.textContent).toContain("2 connections· 1 needs attention");
    expect(notion.textContent).toContain("draft@example.com");
  });

  it.each(["provider_setup", "identity_link", undefined, "complete"])(
    "keeps unfinished verifying chat setup visible for step %s", async (step) => {
      chatListMock.mockResolvedValue([
        { id: "chat-active", provider: "slack", status: "active", assignedAgentName: "Active agent" },
        { id: "chat-verifying", provider: "slack", status: "verifying", assignedAgentName: "Setup agent",
          setup: step === undefined ? undefined : { step } },
      ]);
      await renderBrowse();
      const slack = container.querySelector<HTMLElement>('[data-app-slug="slack"]')!;
      const trigger = slack.querySelector('[data-slot="collapsible-trigger"]')!;
      const unfinished = step !== "complete";
      expect(trigger.getAttribute("aria-expanded")).toBe(String(unfinished));
      expect(slack.textContent?.includes("1 needs attention")).toBe(unfinished);
      expect(slack.textContent?.includes("Finish setup")).toBe(unfinished);
      if (unfinished) {
        await clickButton("Finish setup", slack);
        expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/connect?provider=slack&purpose=chat&resume=chat-verifying");
      }
    },
  );

  it("sorts connected providers first and shows account, owner, status actions, and edit menus inline", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection(),
        connection({
          id: "conn-expired",
          name: "ops@example.com",
          healthStatus: "error",
          healthMessage: "The saved sign-in expired.",
        }),
      ],
    });
    listUserDirectoryMock.mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: {
            id: "user-1",
            name: "Dotta",
            email: "dotta@example.com",
            image: null,
          },
        },
      ],
    });

    await renderBrowse();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[aria-label="Connector list"] > [data-app-slug]',
      ),
    );
    const providers = rows.filter(row => row.dataset.appSlug !== "assistant-connection");
    expect(providers[0]?.dataset.appSlug).toBe("notion");
    const notion = providers[0]!;
    expect(notion.textContent).toContain("devinfoley@gmail.com");
    expect(notion.textContent).toContain("ops@example.com");
    expect(notion.textContent).not.toContain("Connected by");
    expect(notion.textContent).toContain("Dotta");
    expect(notion.textContent).toContain("The saved sign-in expired.");
    expect(
      notion.querySelector('button[aria-label="Add account Notion"]'),
    ).toBeTruthy();
    expect(
      notion.querySelector(
        'button[aria-label="Manage devinfoley@gmail.com connection"]',
      ),
    ).toBeTruthy();
    expect(
      notion.querySelector(
        'button[aria-label="Manage ops@example.com connection"]',
      ),
    ).toBeTruthy();

    await act(async () => {
      notion
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open devinfoley@gmail.com permissions"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/conn-notion/permissions");

    await act(async () => {
      notion
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Add account Notion"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/apps/connect?source=notion&applicationId=app-notion&name=Notion&new=1",
    );

    const reconnect = Array.from(notion.querySelectorAll("button")).find(
      (button) => button.textContent === "Reconnect",
    );
    await act(async () => {
      reconnect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/conn-expired/permissions");
  });

  it("removes a connection from the overflow menu only after destructive confirmation", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({ connections: [connection()] });

    await renderBrowse();

    const menuTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Manage devinfoley@gmail.com connection"]',
    );
    expect(menuTrigger).toBeTruthy();

    await act(async () => {
      menuTrigger?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    await flushReact();

    const removeItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "Remove connection");
    expect(removeItem).toBeTruthy();
    expect(removeItem?.getAttribute("data-variant")).toBe("destructive");

    await act(async () => {
      removeItem?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Remove devinfoley@gmail.com connection?",
    );

    const confirmButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Remove connection");
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("conn-notion");
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connection removed",
        tone: "success",
      }),
    );
  });

  it("retains the confirmed pool revision when a concurrent edit rejects removal", async () => {
    const app = aiConnectionRouterAppDefinition("example.pool", { name: "AI connection pool", description: "Use saved connections" });
    listGalleryMock.mockResolvedValue({ apps: [app] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ name: app.name, metadata: { sourceTemplateKey: app.slug } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ name: "Research", config: { aiRouter: { pluginKey: "example.pool" } } })] });
    poolListMock.mockResolvedValue([{ id: "conn-notion", name: "Research", revision: 7 }]);
    poolRemoveMock.mockRejectedValue(new Error("Pool changed; reload before deleting"));
    await renderBrowse();
    await act(() => { container.querySelector<HTMLButtonElement>('button[aria-label="Manage Research connection"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    await act(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    expect(document.body.textContent).toContain("The connections in this pool are kept.");
    poolListMock.mockResolvedValue([{ id: "conn-notion", name: "Edited elsewhere", revision: 8 }]);
    await act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    expect(poolRemoveMock).toHaveBeenCalledWith("company-1", "conn-notion", 7);
    expect(poolListMock).toHaveBeenCalledTimes(1);
    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ body: "Pool changed; reload before deleting" }));
  });

  it("starts each AgentMail Add connection with a distinct setup identity", async () => {
    chatListMock.mockResolvedValue([{ id: "chat-draft", provider: "agentmail", status: "draft", assignedAgentName: "Ralph" }]);
    await renderBrowse();
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add connection AgentMail"]')!;
    await act(() => add.click());
    const first = new URL(navigateMock.mock.lastCall![0], "http://localhost");
    expect(first.pathname).toBe("/apps/chat/connect");
    expect(first.searchParams.get("provider")).toBe("agentmail");
    expect(first.searchParams.get("setupId")).toMatch(/^[0-9a-f-]{36}$/);
    await act(() => add.click());
    expect(navigateMock.mock.lastCall![0]).not.toBe(first.pathname + first.search);
  });

  it.each(["slack", "discord", "telegram", "github", "microsoft-teams", "agentmail", "imessage-photon"])(
    "puts Manage and removal in the %s chat menu while keeping draft setup visible",
    async (provider) => {
      chatListMock.mockResolvedValue([
        { id: "chat-active", provider, status: "active", assignedAgentName: "Active agent" },
        { id: "chat-draft", provider, status: "draft", assignedAgentName: "Draft agent" },
        { id: "chat-archived", provider, status: "archived", assignedAgentName: "Removed agent" },
      ]);
      await renderBrowse();
      expect(container.textContent).not.toContain("Removed agent");
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Manage")).toBe(false);
      const finish = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Finish setup");
      await act(() => finish!.click());
      expect(navigateMock).toHaveBeenLastCalledWith(`/apps/chat/connect?provider=${provider}&purpose=chat&resume=chat-draft`);
      expect(container.querySelector('button[aria-label^="Manage Draft agent"]')).toBeTruthy();
      await act(() => void container.querySelector('button[aria-label^="Manage Active agent"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
      await flushReact();
      const manage = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === "Manage");
      await act(() => manage!.click());
      expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/chat-active/settings");
    },
  );

  it.each(["slack", "agentmail", "discord", "telegram", "microsoft-teams", "github"])("shows agent and connector-owner identities without routine status labels for %s", async provider => {
    listAgentsMock.mockResolvedValue([{ id: "maya", name: "Maya", appearance: { schemaVersion: 1, characterVersion: "cap-v1", paletteId: "cherry-pop" } }]);
    listUserDirectoryMock.mockResolvedValue({ users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: null } }] });
    chatListMock.mockResolvedValue([{ id: "chat-avatar", provider, status: "verifying", assignedAgentId: "maya", assignedAgentName: "Maya", sponsorUserId: "user-1", setup: { webhookVerifiedAt: "2026-10-07T12:00:00Z" } }]);
    await renderBrowse();
    const avatar = container.querySelector('[aria-label="Maya avatar"]');
    expect(avatar).not.toBeNull();
    const row = avatar!.parentElement!.parentElement!;
    expect(row.textContent).toContain("Dotta");
    expect(row.textContent).not.toContain("Connected by");
    expect(row.textContent).not.toContain("verifying");
    expect(row.querySelector('[data-slot="avatar"]')).not.toBeNull();
  });

  it.each([
    ["slack", "Slack", "active"], ["slack", "Slack", "draft"],
    ["agentmail", "AgentMail", "active"], ["agentmail", "AgentMail", "draft"],
  ])("confirms %s removal for %s %s connections and refreshes the list", async (provider, providerName, status) => {
    chatListMock.mockResolvedValue([{ id: "chat-1", provider, status, assignedAgentName: "CEO" }]);
    const client = await renderBrowse();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(() => void container.querySelector(`button[aria-label="Manage CEO ${providerName} connection"]`)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await flushReact();
    const remove = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === "Remove connection");
    await act(() => remove!.click());
    await flushReact();
    expect(chatSetupMock).not.toHaveBeenCalled();
    expect(emailControlMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Existing Paperclip tasks and conversation history remain available.");
    chatListMock.mockResolvedValue([]);
    await act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    if (provider === "agentmail") {
      expect(emailControlMock).toHaveBeenCalledWith("chat-1", "remove");
      expect(chatSetupMock).not.toHaveBeenCalled();
    } else {
      expect(chatSetupMock).toHaveBeenCalledWith("chat-1", { action: "remove" });
      expect(emailControlMock).not.toHaveBeenCalled();
    }
    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chatEndpoints.list("company-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["email-inboxes", "company-1"] });
    expect(container.textContent).not.toContain("CEO");
  });

  it("keeps chat removal open for retry when the server rejects removal", async () => {
    chatListMock.mockResolvedValue([{ id: "chat-1", provider: "slack", status: "draft", assignedAgentName: "CEO" }]);
    chatSetupMock.mockRejectedValueOnce(new Error("Connection is busy. Try again."));
    await renderBrowse();
    await act(() => void container.querySelector('button[aria-label="Manage CEO Slack connection"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await flushReact();
    await act(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    await act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", body: "Connection is busy. Try again." }));
    await act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!.click());
    await flushReact();
    expect(chatSetupMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("TECH-7617: shows the real agent name for a resolvable dedicated connection, and a neutral placeholder (not a mangled UUID) when unresolved", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-comms-board", name: "rh-comms-board" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "conn-resolved",
          applicationId: "app-comms-board",
          name: "rh-comms-board:1d37c752-ef9d-4185-bfd5-3249898f6bc2",
          credentialPolicy: "per_agent",
          createdByUserId: null,
        }),
        connection({
          id: "conn-unresolved",
          applicationId: "app-comms-board",
          name: "rh-comms-board:3c59f974-5678-9abc-def0-123456789abc",
          credentialPolicy: "per_agent",
          createdByUserId: null,
        }),
      ],
    });
    listAgentsMock.mockResolvedValue([
      { id: "1d37c752-ef9d-4185-bfd5-3249898f6bc2", name: "Hermes" },
    ]);

    await renderBrowseExpanded();

    expect(
      container.querySelector('button[aria-label="Open Hermes permissions"]'),
    ).toBeTruthy();
    expect(
      container.querySelector(
        'button[aria-label="Open Dedicated agent (unavailable) permissions"]',
      ),
    ).toBeTruthy();
    // The pre-fix failure mode: the trailing UUID title-cased into a mangled string.
    expect(document.body.textContent).not.toContain("3c59f974 5678 9abc");
  });

  it("TECH-7592: displays agent name, trimmed title or role subtitle, and accessible short-8 ID popover without accidental navigation", async () => {
    navigateMock.mockReset();
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({
          id: "app-comms-board",
          name: "rh-comms-board",
          applicationKey: "custom:comms-board",
          metadata: {},
        }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "conn-hermes",
          applicationId: "app-comms-board",
          name: "rh-comms-board:1d37c752-ef9d-4185-bfd5-3249898f6bc2",
          credentialPolicy: "per_agent",
          createdByUserId: null,
          config: {},
        }),
        connection({
          id: "conn-coder",
          applicationId: "app-comms-board",
          name: "rh-comms-board:2b48e863-1234-4567-89ab-cdef01234567",
          credentialPolicy: "per_agent",
          createdByUserId: null,
          config: {},
        }),
      ],
    });
    const HERMES_BOARD_AGENT_ID = "6c8935b2-ef9d-4185-bfd5-3249898f6bc2";
    listAgentsMock.mockResolvedValue([
      {
        id: "1d37c752-ef9d-4185-bfd5-3249898f6bc2",
        name: "Hermes",
        title: "  Lead Architect  ",
        role: "general",
        metadata: {
          defaultMcp: {
            version: 1,
            entries: {
              "comms-board": {
                key: "comms-board",
                templateKey: "rh-comms-board",
                dedicated: true,
                connectionId: "conn-hermes",
                binding: {
                  boardAgentId: HERMES_BOARD_AGENT_ID,
                },
              },
            },
          },
        },
      },
      {
        id: "2b48e863-1234-4567-89ab-cdef01234567",
        name: "Coder",
        title: null,
        role: "engineer",
      },
    ]);

    await renderBrowseExpanded();

    // 1. Primary permissions button displays agent name
    const hermesBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Hermes permissions"]',
    );
    expect(hermesBtn).toBeTruthy();
    expect(hermesBtn?.textContent).toBe("Hermes");

    const coderBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Coder permissions"]',
    );
    expect(coderBtn).toBeTruthy();
    expect(coderBtn?.textContent).toBe("Coder");

    // 2. Subtitle displays trimmed title + app subtitle or role + app subtitle (no JWT subject)
    expect(container.textContent).toContain("Lead Architect · rh-comms-board");
    expect(container.textContent).toContain("engineer · rh-comms-board");
    expect(container.textContent).not.toContain("paperclip-agent");

    // 3. Full comms board agent ID is visible, code/mono, selectable
    const hermesBoardIdElem = container.querySelector(
      `code[aria-label="Comms board agent ID: ${HERMES_BOARD_AGENT_ID}"]`,
    );
    expect(hermesBoardIdElem).toBeTruthy();
    expect(hermesBoardIdElem?.textContent).toBe(HERMES_BOARD_AGENT_ID);
    expect(hermesBoardIdElem?.className).toContain("select-all");
    expect(hermesBoardIdElem?.className).toContain("break-all");

    // Clicking the board ID does NOT navigate
    await act(async () => {
      hermesBoardIdElem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(navigateMock).not.toHaveBeenCalled();

    // Clicking the primary permissions button DOES navigate
    await act(async () => {
      hermesBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(navigateMock).toHaveBeenCalledWith("/apps/conn-hermes/permissions");
  });

  it("TECH-7592: searches connectors by resolved agent name, title, role, and ID", async () => {
    // Distinct from the Paperclip agent id below on purpose: matching on it
    // proves the comms-board agent UUID is itself searchable.
    const HERMES_BOARD_ID = "7e40a2c9-8b1d-4f6e-9a3c-5d2b8e7f4a10";
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({
          id: "app-comms-board",
          name: "rh-comms-board",
          applicationKey: "custom:comms-board",
          metadata: {},
        }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "conn-hermes",
          applicationId: "app-comms-board",
          name: "rh-comms-board:1d37c752-ef9d-4185-bfd5-3249898f6bc2",
          credentialPolicy: "per_agent",
          createdByUserId: null,
          config: {},
        }),
      ],
    });
    listAgentsMock.mockResolvedValue([
      {
        id: "1d37c752-ef9d-4185-bfd5-3249898f6bc2",
        name: "Hermes",
        title: "Lead Architect",
        role: "general",
        metadata: {
          defaultMcp: {
            version: 1,
            entries: {
              "comms-board": {
                key: "comms-board",
                templateKey: "rh-comms-board",
                dedicated: true,
                connectionId: "conn-hermes",
                binding: { boardAgentId: HERMES_BOARD_ID },
              },
            },
          },
        },
      },
    ]);

    await renderBrowseExpanded();

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    expect(searchInput).toBeTruthy();

    const setSearch = async (val: string) => {
      await act(async () => {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        nativeSetter?.call(searchInput, val);
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flushReact();
    };

    // Match by agent name
    await setSearch("Hermes");
    expect(container.textContent).toContain("Hermes");

    // Match by agent title
    await setSearch("Architect");
    expect(container.textContent).toContain("Hermes");

    // Match by agent role
    await setSearch("general");
    expect(container.textContent).toContain("Hermes");

    // Match by agent ID prefix
    await setSearch("1d37c752");
    expect(container.textContent).toContain("Hermes");

    // Match by the full comms-board agent UUID (distinct from the Paperclip
    // agent ID above — proves the board ID itself is searchable, TECH-7592)
    await setSearch(HERMES_BOARD_ID);
    expect(container.textContent).toContain("Hermes");

    // Match by a board agent UUID prefix
    await setSearch(HERMES_BOARD_ID.slice(0, 8));
    expect(container.textContent).toContain("Hermes");

    // A different full UUID matches nothing (search is not "any UUID matches")
    await setSearch("0f1e2d3c-4b5a-4968-8776-655443332211");
    expect(container.textContent).toContain(
      "No connectors match “0f1e2d3c-4b5a-4968-8776-655443332211”",
    );

    // Non-matching term hides row
    await setSearch("completelyunrelated");
    expect(container.textContent).toContain("No connectors match “completelyunrelated”");
  });

  it("TECH-7592: uses resolved agent name in remove connection confirmation dialog", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({
          id: "app-comms-board",
          name: "rh-comms-board",
          applicationKey: "custom:comms-board",
          metadata: {},
        }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "conn-hermes",
          applicationId: "app-comms-board",
          name: "rh-comms-board:1d37c752-ef9d-4185-bfd5-3249898f6bc2",
          credentialPolicy: "per_agent",
          createdByUserId: null,
          config: {},
        }),
      ],
    });
    listAgentsMock.mockResolvedValue([
      {
        id: "1d37c752-ef9d-4185-bfd5-3249898f6bc2",
        name: "Hermes",
        title: "Lead Architect",
        role: "general",
      },
    ]);

    await renderBrowseExpanded();

    const menuTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Manage Hermes connection"]',
    );
    expect(menuTrigger).toBeTruthy();

    await act(async () => {
      menuTrigger?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    await flushReact();

    const removeItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "Remove connection");
    expect(removeItem).toBeTruthy();

    await act(async () => {
      removeItem?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain(
      "Remove Hermes connection?",
    );
  });

  describe("TECH-7592: dedicated-agent identity across roster states", () => {
    const HERMES_ID = "1d37c752-ef9d-4185-bfd5-3249898f6bc2";
    const HERMES_BOARD_AGENT_ID = "6c8935b2-ef9d-4185-bfd5-3249898f6bc2";
    const CODER_ID = "2b48e863-1234-4567-89ab-cdef01234567";
    const DELETED_ID = "3c59f974-5678-9abc-def0-123456789abc";

    const commsBoardApplication = () =>
      application({
        id: "app-comms-board",
        name: "rh-comms-board",
        applicationKey: "custom:comms-board",
        metadata: {},
      });

    const dedicatedConnection = (overrides: Record<string, unknown> = {}) =>
      connection({
        id: "conn-hermes",
        applicationId: "app-comms-board",
        name: `rh-comms-board:${HERMES_ID}`,
        credentialPolicy: "per_agent",
        createdByUserId: null,
        config: {},
        ...overrides,
      });

    // The legitimate server-written comms-board binding shape (entries
    // ["comms-board"], key/templateKey, valid UUID boardAgentId) for an agent
    // that owns the given connection.
    const boardMetadata = (connectionId: string, boardAgentId: string) => ({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId,
            binding: { boardAgentId },
          },
        },
      },
    });

    it("keeps the resolved agent name when a background roster refetch fails on cached data (403)", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [commsBoardApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [dedicatedConnection()],
      });
      listAgentsMock.mockResolvedValueOnce([
        { id: HERMES_ID, name: "Hermes", title: "Lead Architect", role: "general" },
      ]);

      const client = await renderBrowseExpanded();
      expect(
        container.querySelector('button[aria-label="Open Hermes permissions"]'),
      ).toBeTruthy();

      // A 403 on the background refetch must not regress an already-resolved
      // dedicated-agent name: the roster query keeps its last-good data, so
      // resolution keeps working from the cached roster (the data-first
      // semantics resolveAgentFromQuery documents for TECH-7617 round 4).
      listAgentsMock.mockRejectedValueOnce(new Error("403 Forbidden"));
      await act(async () => {
        await client.refetchQueries({
          queryKey: queryKeys.agents.list("company-1"),
        });
      });
      await flushReact();

      // The roster fetch stays company-scoped, and the forced refetch really
      // ran (and failed) — the name below resolves from cached data, not from
      // a refetch that never happened.
      expect(listAgentsMock).toHaveBeenCalledWith("company-1");
      expect(listAgentsMock).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('button[aria-label="Open Hermes permissions"]'),
      ).toBeTruthy();
      expect(
        container.querySelector(
          'button[aria-label="Open Dedicated agent (unavailable) permissions"]',
        ),
      ).toBeNull();
    });

    it("shows the neutral placeholder, never an install identity, while the roster is failed (403) or pending", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [commsBoardApplication()],
      });
      // The dedicated connection names a deleted agent and carries a consumer
      // install for a different one: with no roster data, neither identity may
      // reach the row.
      listConnectionsMock.mockResolvedValue({
        connections: [
          dedicatedConnection({
            id: "conn-unknown",
            name: `rh-comms-board:${DELETED_ID}`,
            installs: [{ id: "inst-1", targetType: "agent", targetId: CODER_ID }],
          }),
        ],
      });

      // Confirmed failed (403) with no data ever loaded: the row cannot resolve
      // or expose any agent identity from the connection alone.
      listAgentsMock.mockRejectedValue(new Error("403 Forbidden"));
      await renderBrowseExpanded();
      expect(listAgentsMock).toHaveBeenCalledWith("company-1");
      expect(
        container.querySelector(
          'button[aria-label="Open Dedicated agent (unavailable) permissions"]',
        ),
      ).toBeTruthy();
      expect(container.textContent).not.toContain("Coder");
      expect(container.textContent).not.toContain("3c59f974 5678");
      expect(
        container.querySelector('button[aria-label^="Show full agent ID"]'),
      ).toBeNull();

      await act(() => {
        root?.unmount();
      });

      // Still pending (the roster fetch never settles): same neutral state,
      // never the mangled-UUID name the pre-TECH-7617 UI produced.
      listAgentsMock.mockImplementation(() => new Promise(() => {}));
      await renderBrowseExpanded();
      expect(
        container.querySelector(
          'button[aria-label="Open Dedicated agent (unavailable) permissions"]',
        ),
      ).toBeTruthy();
      expect(container.textContent).not.toContain("3c59f974 5678");
    });

    it("keeps the deleted comms identity authoritative: no fallback to the installed consumer agent", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [commsBoardApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          dedicatedConnection({
            id: "conn-deleted",
            name: `rh-comms-board:${DELETED_ID}`,
            installs: [{ id: "inst-1", targetType: "agent", targetId: CODER_ID }],
          }),
        ],
      });
      // The roster loaded fine and could name the installed agent — the
      // name-encoded subject is simply gone. The install is a consumer, not a
      // substitute owner, so the connection must stay unresolved.
      listAgentsMock.mockResolvedValue([
        { id: CODER_ID, name: "Coder", title: null, role: "qa" },
      ]);

      await renderBrowseExpanded();

      expect(
        container.querySelector(
          'button[aria-label="Open Dedicated agent (unavailable) permissions"]',
        ),
      ).toBeTruthy();
      expect(container.textContent).not.toContain("Coder");
      expect(
        container.querySelector('button[aria-label^="Show full agent ID"]'),
      ).toBeNull();
      expect(container.textContent).not.toContain("3c59f974 5678");
    });

    it("keeps Connected-by attribution and paused/attention status alongside the resolved identity, with a whitespace title falling back to the role", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [commsBoardApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          dedicatedConnection({
            id: "conn-paused",
            enabled: false,
            createdByUserId: "user-1",
          }),
          dedicatedConnection({
            id: "conn-attention",
            name: `rh-comms-board:${CODER_ID}`,
            healthStatus: "error",
            healthMessage: "The saved sign-in expired.",
            createdByUserId: "user-1",
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        // A whitespace-only title must fall back to the role in the subtitle.
        {
          id: HERMES_ID,
          name: "Hermes",
          title: "   ",
          role: "engineer",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  connectionId: "conn-paused",
                  binding: { boardAgentId: HERMES_BOARD_AGENT_ID },
                },
              },
            },
          },
        },
        { id: CODER_ID, name: "Coder", title: "QA Lead", role: "qa" },
      ]);
      listUserDirectoryMock.mockResolvedValue({
        users: [
          {
            principalId: "user-1",
            status: "active",
            user: {
              id: "user-1",
              name: "Dotta",
              email: "dotta@example.com",
              image: null,
            },
          },
        ],
      });

      await renderBrowseExpanded();

      const pausedRow = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Hermes permissions"]',
      );
      expect(pausedRow).toBeTruthy();
      // Whitespace-only title contributes no parenthesized part to the tooltip.
      expect(pausedRow?.getAttribute("title")).toBe("Hermes");
      expect(container.textContent).toContain("engineer · rh-comms-board");
      // The paused state renders alongside the identity, not instead of it.
      expect(container.textContent).toContain("Paused");
      expect(container.textContent).toContain(
        "Agents can’t use this account right now.",
      );
      expect(
        container.querySelector(
          `code[aria-label="Comms board agent ID: ${HERMES_BOARD_AGENT_ID}"]`,
        ),
      ).toBeTruthy();

      const attentionRow = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Coder permissions"]',
      );
      expect(attentionRow).toBeTruthy();
      expect(attentionRow?.getAttribute("title")).toBe("Coder (QA Lead)");
      expect(container.textContent).toContain("QA Lead · rh-comms-board");
      expect(container.textContent).toContain("Needs attention");
      expect(container.textContent).toContain("The saved sign-in expired.");

      // Creator attribution is preserved next to the agent identity.
      // The shared account row identifies the owner without a "Connected by" label.
      expect(container.textContent).toContain("Dotta");
    });

    it("renders the full Comms Board agent ID directly without popover and never navigates on click", async () => {
      navigateMock.mockReset();
      listApplicationsMock.mockResolvedValue({
        applications: [commsBoardApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [dedicatedConnection()],
      });
      listAgentsMock.mockResolvedValue([
        {
          id: HERMES_ID,
          name: "Hermes",
          title: null,
          role: "general",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  connectionId: "conn-hermes",
                  binding: { boardAgentId: HERMES_BOARD_AGENT_ID },
                },
              },
            },
          },
        },
      ]);

      await renderBrowseExpanded();

      const boardIdElem = container.querySelector(
        `code[aria-label="Comms board agent ID: ${HERMES_BOARD_AGENT_ID}"]`,
      );
      expect(boardIdElem).toBeTruthy();
      expect(boardIdElem?.textContent).toBe(HERMES_BOARD_AGENT_ID);

      await act(async () => {
        boardIdElem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(navigateMock).not.toHaveBeenCalled();
      expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    });

    it("renders only the comms-board agent UUID: no Paperclip agent ID, no 8-char prefix, no popover trigger", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [commsBoardApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [dedicatedConnection()],
      });
      listAgentsMock.mockResolvedValue([
        {
          id: HERMES_ID,
          name: "Hermes",
          title: null,
          role: "general",
          metadata: boardMetadata("conn-hermes", HERMES_BOARD_AGENT_ID),
        },
      ]);

      await renderBrowseExpanded();

      const badge = container.querySelector(
        `code[aria-label="Comms board agent ID: ${HERMES_BOARD_AGENT_ID}"]`,
      );
      expect(badge).toBeTruthy();
      // The full 36-char UUID is the explicit visible text — not only carried
      // in aria/title attributes.
      expect(badge?.textContent).toBe(HERMES_BOARD_AGENT_ID);
      expect(HERMES_BOARD_AGENT_ID).toHaveLength(36);
      expect(container.textContent).toContain(HERMES_BOARD_AGENT_ID);
      // No wrong-domain value leaks into the visible surface: the Paperclip
      // internal agent UUID (full and 8-char prefix — the pre-fix display)
      // and the board JWT subject never appear.
      expect(container.textContent).not.toContain(HERMES_ID);
      expect(container.textContent).not.toContain(HERMES_ID.slice(0, 8));
      expect(container.textContent).not.toContain(`paperclip-agent-${HERMES_ID}`);
      // The retired popover trigger must not come back.
      expect(
        container.querySelector('button[aria-label^="Show full agent ID"]'),
      ).toBeNull();
      // The row title is what truncates first; the ID itself never does
      // (structural classes — jsdom cannot prove real layout).
      const nameButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Hermes permissions"]',
      );
      expect(nameButton?.className).toContain("truncate");
      expect(badge?.className).not.toContain("truncate");
      expect(badge?.className).toContain("break-all");
      expect(badge?.className).toContain("max-w-full");
    });

    it("keeps the full comms-board agent UUID intact when the agent name is very long (the title may truncate, the ID may not)", async () => {
      const longName = `Hermes von Trapp-Schwarzenberg-Wellington-Alexandrovitch-${"the-Unnecessarily-Hyphenated ".repeat(3)}III`;
      listApplicationsMock.mockResolvedValue({
        applications: [commsBoardApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [dedicatedConnection()],
      });
      listAgentsMock.mockResolvedValue([
        {
          id: HERMES_ID,
          name: longName,
          title: null,
          role: "general",
          metadata: boardMetadata("conn-hermes", HERMES_BOARD_AGENT_ID),
        },
      ]);

      await renderBrowseExpanded();

      const badge = container.querySelector(
        `code[aria-label="Comms board agent ID: ${HERMES_BOARD_AGENT_ID}"]`,
      );
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe(HERMES_BOARD_AGENT_ID);
      expect(badge?.textContent).toHaveLength(36);
    });

    it("hides the badge when the board ID is unresolvable (missing or malformed metadata) and preserves name, subtitle, and permissions navigation", async () => {
      const coderBoardId = "7e40a2c9-8b1d-4f6e-9a3c-5d2b8e7f4a10";
      listApplicationsMock.mockResolvedValue({
        applications: [commsBoardApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          dedicatedConnection({ id: "conn-nometa" }),
          dedicatedConnection({
            id: "conn-badmeta",
            name: `rh-comms-board:${CODER_ID}`,
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        // No metadata at all: no badge — but the agent identity itself stays.
        { id: HERMES_ID, name: "Hermes", title: "Lead Architect", role: "general" },
        // Malformed metadata (wrong defaultMcp version): same, no crash.
        {
          id: CODER_ID,
          name: "Coder",
          title: "QA Lead",
          role: "qa",
          metadata: {
            defaultMcp: {
              version: 2,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  binding: { boardAgentId: coderBoardId },
                },
              },
            },
          },
        },
      ]);

      await renderBrowseExpanded();

      // No badge anywhere, and no internal Paperclip-ID fallback (the removed
      // slice(0, 8) display must not resurface for unresolvable rows).
      expect(
        container.querySelectorAll('code[aria-label^="Comms board agent ID:"]').length,
      ).toBe(0);
      expect(container.textContent).not.toContain(coderBoardId);
      expect(container.textContent).not.toContain(HERMES_ID);
      expect(container.textContent).not.toContain(CODER_ID);
      // Row identity is otherwise untouched.
      expect(
        container.querySelector('button[aria-label="Open Hermes permissions"]'),
      ).toBeTruthy();
      expect(container.textContent).toContain("Lead Architect · rh-comms-board");
      expect(
        container.querySelector('button[aria-label="Open Coder permissions"]'),
      ).toBeTruthy();
      expect(container.textContent).toContain("QA Lead · rh-comms-board");
      // Permissions navigation still works for an unresolvable-badge row.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Open Coder permissions"]',
          )
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(navigateMock).toHaveBeenCalledWith("/apps/conn-badmeta/permissions");
    });
  });

  it("keeps an interrupted account visible and resumes setup from its account row", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "conn-draft",
          name: "Notion",
          status: "draft",
          healthStatus: "unchecked",
        }),
      ],
    });

    await renderBrowseExpanded();

    expect(container.textContent).toContain("Setup incomplete");
    const finish = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Finish setup",
    );
    await act(async () => {
      finish?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/apps/connect?source=notion&resume=conn-draft",
    );
  });

  it("resumes a hidden provider only from its existing draft account row", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application({
      id: "app-clickup",
      name: "ClickUp",
      applicationKey: "app-gallery:clickup:one",
      metadata: { sourceTemplateKey: "clickup" },
    })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({
      id: "conn-clickup-draft",
      applicationId: "app-clickup",
      name: "ClickUp",
      status: "draft",
      config: { sourceTemplateKey: "clickup" },
    })] });

    await renderBrowseExpanded();

    const row = container.querySelector('[data-app-slug="clickup"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Setup incomplete");
    const finish = Array.from(row!.querySelectorAll("button")).find(
      (button) => button.textContent === "Finish setup",
    );
    await act(async () => {
      finish?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/apps/connect?source=clickup&resume=conn-clickup-draft",
    );
    expect(getAppStoreDefinition("clickup")).toBeNull();
  });

  it("filters the single list without restoring section chrome", async () => {
    await renderBrowseExpanded();

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search connectors"]',
    );
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "jira");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[aria-label="Connector list"] > [data-app-slug]',
      ),
    );
    expect(rows.map((row) => row.dataset.appSlug)).toEqual(["jira"]);
    expect(container.textContent).not.toContain("Popular");
    expect(container.textContent).not.toContain("All apps");
  });

  describe("TECH-7340: discovery-only seeds and personal instances", () => {
    const googleApplication = () =>
      application({
        id: "app-google",
        name: "RH Google MCP",
        description: "RH Google MCP tools.",
        applicationKey: "default-mcp-rh-google-mcp",
        metadata: {},
      });
    const seedConnection = () =>
      connection({
        id: "seed-google",
        applicationId: "app-google",
        name: "RH Google MCP",
        uid: "rh-google-mcp/default-mcp-seed",
        status: "draft",
        enabled: false,
        createdByUserId: null,
        config: { defaultMcpManaged: "seed", paperclipDefaultMcpEntry: "rh-google-mcp" },
        installs: [],
      });
    const personalInstance = (over: Record<string, unknown> = {}) =>
      connection({
        id: "pi-b",
        applicationId: "app-google",
        name: "RH Google MCP",
        uid: "rh-google-mcp/default-mcp-personal/user-b",
        status: "draft",
        createdByUserId: "user-b",
        config: { defaultMcpManaged: "personal", paperclipDefaultMcpEntry: "rh-google-mcp", identityModel: "personal_only" },
        installs: [],
        ...over,
      });

    it("shows a Connect action for the seed that starts OAuth as the current user (never a URL paste)", async () => {
      listApplicationsMock.mockResolvedValue({ applications: [googleApplication()] });
      listConnectionsMock.mockResolvedValue({
        connections: [seedConnection(), personalInstance()],
      });
      getSessionMock.mockResolvedValue({ user: { id: "user-b" } });

      await renderBrowseExpanded();

      const row = container.querySelector<HTMLElement>('[data-app-slug="default-mcp-rh-google-mcp"]');
      expect(row).toBeTruthy();
      const connect = row!.querySelector<HTMLButtonElement>('button[aria-label="Connect RH Google MCP"]');
      expect(connect).toBeTruthy();
      // The seed connection itself never renders as an account row.
      expect(row!.querySelector('[aria-label="Manage RH Google MCP connection"]')).toBeNull();
      // The personal instance's draft row says Not connected, and its button is Connect (not Finish setup).
      expect(row!.textContent).toContain("Not connected");
      expect(row!.textContent).toContain("Sign in to connect your personal account.");
      const accountConnect = Array.from(row!.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Connect",
      );
      expect(accountConnect).toBeTruthy();

      await act(async () => {
        connect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      await flushReact();
      expect(startOAuthMock).toHaveBeenCalledWith("seed-google", { asCurrentUser: true });
      expect(prepareOAuthNavigationMock).toHaveBeenCalledWith({ authorizationUrl: "https://mcp.example.test/authorize?state=xyz" });
      expect(navigateTopLevelMock).toHaveBeenCalledWith("https://mcp.example.test/authorize?state=xyz");
    });

    it("shows Connected once my own active instance exists, and still Connect for another member's instance", async () => {
      listApplicationsMock.mockResolvedValue({ applications: [googleApplication()] });
      getSessionMock.mockResolvedValue({ user: { id: "user-b" } });

      // Another member's active instance does not block my Connect row; it renders as
      // that member's account (attributed), while MY action is still Connect.
      listConnectionsMock.mockResolvedValue({
        connections: [
          seedConnection(),
          personalInstance({
            id: "pi-a",
            uid: "rh-google-mcp/default-mcp-personal/user-a",
            createdByUserId: "user-a",
            status: "active",
          }),
        ],
      });
      listUserDirectoryMock.mockResolvedValue({
        users: [{ principalId: "user-a", status: "active", user: { name: "Alice Member" } }],
      });
      await renderBrowseExpanded();
      let row = container.querySelector<HTMLElement>('[data-app-slug="default-mcp-rh-google-mcp"]');
      expect(row!.querySelector('button[aria-label="Connect RH Google MCP"]')).toBeTruthy();
      // The shared account row identifies the owner without a "Connected by" label.
      expect(row!.textContent).toContain("Alice Member");
      await act(async () => {
        root?.unmount();
      });

      // My own active instance: the row is Connected (no further Connect action).
      listConnectionsMock.mockResolvedValue({
        connections: [
          seedConnection(),
          personalInstance({ status: "active" }),
        ],
      });
      await renderBrowseExpanded();
      row = container.querySelector<HTMLElement>('[data-app-slug="default-mcp-rh-google-mcp"]');
      // My own active instance: the connector action is Connected (no further Connect).
      expect(row!.querySelector('button[aria-label="Connect RH Google MCP"]')).toBeNull();
      expect(row!.querySelector('button[aria-label="Connected RH Google MCP"]')).toBeTruthy();
    });

    // The initial-connect pathway lives on the ACCOUNT row (own draft personal instance
    // + a row-level seed), not only on the card header.
    const accountRowWithDraft = () => {
      const row = container.querySelector<HTMLElement>('[data-app-slug="default-mcp-rh-google-mcp"]')!;
      const accountRows = Array.from(row.querySelectorAll<HTMLElement>("div.divide-y > div"));
      const draftRow = accountRows.find((element) =>
        element.textContent?.includes("Sign in to connect your personal account."),
      );
      expect(draftRow).toBeTruthy();
      const accountConnect = Array.from(draftRow!.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Connect",
      );
      expect(accountConnect).toBeTruthy();
      return accountConnect!;
    };

    it("the account row's own Connect button starts seed OAuth on the seed id and navigates safely", async () => {
      listApplicationsMock.mockResolvedValue({ applications: [googleApplication()] });
      getSessionMock.mockResolvedValue({ user: { id: "user-b" } });
      // My own DRAFT personal instance next to the row-level seed: the verified owner's
      // initial-connect pathway.
      listConnectionsMock.mockResolvedValue({
        connections: [seedConnection(), personalInstance()],
      });

      await renderBrowseExpanded();

      const accountConnect = accountRowWithDraft();
      // Distinct from the card header's aria-labeled action button.
      expect(accountConnect.getAttribute("aria-label")).toBeNull();

      await act(async () => {
        accountConnect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      await flushReact();
      // The account row starts OAuth on the SEED connection id, as the current user,
      // and navigates to the server-resolved URL (never a pasted one).
      expect(startOAuthMock).toHaveBeenCalledWith("seed-google", { asCurrentUser: true });
      expect(prepareOAuthNavigationMock).toHaveBeenCalledWith({ authorizationUrl: "https://mcp.example.test/authorize?state=xyz" });
      expect(navigateTopLevelMock).toHaveBeenCalledWith("https://mcp.example.test/authorize?state=xyz");
    });

    it("a failed account-row connect shows the sanitized toast, never navigates, and allows retry (OAuth start and handoff failures)", async () => {
      listApplicationsMock.mockResolvedValue({ applications: [googleApplication()] });
      getSessionMock.mockResolvedValue({ user: { id: "user-b" } });
      // My own DRAFT personal instance next to the row-level seed: the verified owner's
      // initial-connect pathway, driven from the ACCOUNT row (not the card header).
      listConnectionsMock.mockResolvedValue({
        connections: [seedConnection(), personalInstance()],
      });

      await renderBrowseExpanded();

      // The OAuth start itself rejects, with the raw error carrying a URL the toast must never show.
      startOAuthMock.mockRejectedValueOnce(new Error("boom https://idp/x?state=leak"));
      await act(async () => {
        accountRowWithDraft().dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      await flushReact();

      expect(startOAuthMock).toHaveBeenCalledTimes(1);
      expect(pushToastMock).toHaveBeenCalledTimes(1);
      expect(pushToastMock).toHaveBeenCalledWith({
        title: "Could not start sign in",
        body: "Couldn't start sign in. Please try again.",
        tone: "error",
      });
      const toastBody = (pushToastMock.mock.calls[0]![0] as { body?: string }).body;
      expect(toastBody).not.toContain("https://idp/x");
      expect(toastBody).not.toContain("state=leak");
      // No handoff and no navigation of either kind: the account row must not fall back to its action href.
      expect(prepareOAuthNavigationMock).not.toHaveBeenCalled();
      expect(navigateTopLevelMock).not.toHaveBeenCalled();
      expect(navigateMock).not.toHaveBeenCalled();

      // The failure resets the row, so the SAME account row retries: the native authorize link navigates.
      await act(async () => {
        accountRowWithDraft().dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      await flushReact();
      expect(startOAuthMock).toHaveBeenCalledTimes(2);
      expect(prepareOAuthNavigationMock).toHaveBeenCalledWith({ authorizationUrl: "https://mcp.example.test/authorize?state=xyz" });
      expect(navigateTopLevelMock).toHaveBeenCalledWith("https://mcp.example.test/authorize?state=xyz");
      expect(pushToastMock).toHaveBeenCalledTimes(1);

      // A handoff-preparation failure on the same pathway: same sanitized toast, still no navigation.
      prepareOAuthNavigationMock.mockRejectedValueOnce(
        new Error("blocked https://mcp.example.test/authorize?token=secret-token-value"),
      );
      await act(async () => {
        accountRowWithDraft().dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      await flushReact();
      expect(startOAuthMock).toHaveBeenCalledTimes(3);
      expect(pushToastMock).toHaveBeenCalledTimes(2);
      expect(pushToastMock).toHaveBeenLastCalledWith({
        title: "Could not start sign in",
        body: "Couldn't start sign in. Please try again.",
        tone: "error",
      });
      const retryToastBody = (pushToastMock.mock.calls[1]![0] as { body?: string }).body;
      expect(retryToastBody).not.toContain("secret-token-value");
      expect(retryToastBody).not.toContain("https://mcp.example.test");
      // Only the one successful handoff above ever navigated.
      expect(navigateTopLevelMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).not.toHaveBeenCalled();
    });

    it("attention rows keep their own action href: Retry access and Reconnect never start seed OAuth", async () => {
      listApplicationsMock.mockResolvedValue({ applications: [googleApplication()] });
      getSessionMock.mockResolvedValue({ user: { id: "user-b" } });
      const attentionInstance = (id: string, requiresReauthorization: boolean) =>
        personalInstance({
          id,
          status: "active",
          healthStatus: "error",
          healthMessage: "The saved sign-in expired.",
          requiresReauthorization,
        });

      // My own personal instance in the attention state: even with the row-level seed
      // present and the instance mine, only the DRAFT row starts seed OAuth.
      listConnectionsMock.mockResolvedValue({
        connections: [seedConnection(), attentionInstance("pi-retry", false)],
      });
      await renderBrowseExpanded();
      let row = container.querySelector<HTMLElement>('[data-app-slug="default-mcp-rh-google-mcp"]')!;
      const retry = Array.from(row.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry access",
      );
      expect(retry).toBeTruthy();
      await act(async () => {
        retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      expect(navigateMock).toHaveBeenLastCalledWith("/apps/pi-retry/permissions");
      expect(startOAuthMock).not.toHaveBeenCalled();

      await act(async () => {
        root?.unmount();
      });

      listConnectionsMock.mockResolvedValue({
        connections: [seedConnection(), attentionInstance("pi-reauth", true)],
      });
      await renderBrowseExpanded();
      row = container.querySelector<HTMLElement>('[data-app-slug="default-mcp-rh-google-mcp"]')!;
      const reconnect = Array.from(row.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Reconnect",
      );
      expect(reconnect).toBeTruthy();
      await act(async () => {
        reconnect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      expect(navigateMock).toHaveBeenLastCalledWith("/apps/pi-reauth/permissions");
      // Retry/Reconnect follow the existing action href: no seed OAuth, no handoff, no top-level navigation.
      expect(startOAuthMock).not.toHaveBeenCalled();
      expect(prepareOAuthNavigationMock).not.toHaveBeenCalled();
      expect(navigateTopLevelMock).not.toHaveBeenCalled();
    });

    it("a foreign-owned draft account row never starts seed OAuth, and an unresolved session disables the draft row", async () => {
      listApplicationsMock.mockResolvedValue({ applications: [googleApplication()] });
      getSessionMock.mockResolvedValue({ user: { id: "user-b" } });
      // Alice's DRAFT personal instance: not the verified owner's initial-connect
      // pathway, so the account button keeps its ordinary action href.
      listConnectionsMock.mockResolvedValue({
        connections: [
          seedConnection(),
          personalInstance({ id: "pi-foreign", uid: "rh-google-mcp/default-mcp-personal/user-a", createdByUserId: "user-a" }),
        ],
      });

      await renderBrowseExpanded();

      const accountConnect = accountRowWithDraft();
      await act(async () => {
        accountConnect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      // The foreign draft follows its own action href; seed OAuth is never started on Alice's behalf.
      expect(navigateMock).toHaveBeenLastCalledWith("/apps/pi-foreign/permissions");
      expect(startOAuthMock).not.toHaveBeenCalled();
      expect(navigateTopLevelMock).not.toHaveBeenCalled();

      await act(async () => {
        root?.unmount();
      });

      // With the session unresolved, ownership cannot be judged: the draft account
      // button is disabled outright and offers no possibly-false connect prompt.
      getSessionMock.mockResolvedValue(null);
      listConnectionsMock.mockResolvedValue({
        connections: [seedConnection(), personalInstance()],
      });
      await renderBrowseExpanded();
      const disabledConnect = accountRowWithDraft();
      expect((disabledConnect as HTMLButtonElement).disabled).toBe(true);
      expect(disabledConnect.getAttribute("title")).toBe("Checking your account…");
    });
  });

  it("shows existing accounts and an actionable warning when the gallery request fails", async () => {
    listGalleryMock.mockRejectedValue(new Error("Gallery unavailable"));
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({
          id: "custom-app",
          name: "Internal search",
          applicationKey: "custom:search",
          metadata: { source: "link" },
        }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "custom-connection",
          applicationId: "custom-app",
          name: "search.internal.example",
          config: {},
        }),
      ],
    });

    await renderBrowseExpanded();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load every connector",
    );
    expect(container.textContent).toContain("Internal search");
    expect(container.textContent).toContain("search.internal.example");
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Try again",
      ),
    ).toBe(true);
  });

  describe("TECH-7673: Arcana brain connection display", () => {
    // Pairwise-distinct identity domains (the same fixture scheme the unit
    // tests use): the internal Paperclip agent UUID (111…, name-encoded in
    // the dedicated connection), the Arcana principal UUID (333…, stored in
    // binding.baseSub), its canonical brain ID form (agent:333…, 42 chars),
    // the comms-board agent UUID (444…), and the dedicated connection UUIDs
    // (555…). A wrong-domain render cannot pass an exact-text assertion.
    const ORACLE_ID = "11111111-1111-4111-8111-111111111111";
    const ARCANA_PRINCIPAL_ID = "33333333-3333-5333-8333-333333333333";
    const CANONICAL_BRAIN_ID = `agent:${ARCANA_PRINCIPAL_ID}`;
    const BOARD_UUID = "44444444-4444-4444-8444-444444444444";
    const ARCANA_CONN_ID = "55555555-5555-4555-8555-555555555555";
    const COMMS_CONN_ID = "55555555-5555-4555-8555-555555555556";

    const arcanaApplication = () =>
      application({
        id: "app-arcana-brain",
        name: "Arcana Brain",
        applicationKey: "custom:arcana-brain",
        metadata: {},
      });
    const commsApplication = () =>
      application({
        id: "app-comms-board-7673",
        name: "ReClaw Comms Board",
        applicationKey: "custom:comms-board-7673",
        metadata: {},
      });

    // The legitimate server-written arcana-brain binding shape
    // (default-mcp-setup.ts arcanaBrainHook): setup.state "ready",
    // binding.boardAgentId null (the board-UUID domain does not apply to
    // Arcana), binding.baseSub carrying the Arcana agent principal, and the
    // dedicated connectionId on both the entry and the binding.
    const arcanaEntryMetadata = (connectionId: string) => ({
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            connectionId,
            setup: {
              state: "ready",
              reason: null,
              attemptCount: 1,
              nextAttemptAt: null,
              leaseUntil: null,
              claimId: null,
              registerAttemptedAt: null,
              mintAttemptedAt: null,
              updatedAt: "2026-01-01T00:00:00Z",
            },
            binding: {
              boardAgentId: null,
              baseSub: ARCANA_PRINCIPAL_ID,
              agentKey: null,
              boardSub: null,
              secretId: "sec-arcana-7673",
              secretVersion: "latest",
              connectionId,
              grantId: "grant-arcana-7673",
              tokenExpiresAt: null,
            },
          },
        },
      },
    });
    const commsEntryMetadata = (connectionId: string) => ({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId,
            binding: { boardAgentId: BOARD_UUID, connectionId },
          },
        },
      },
    });
    // One agent owning BOTH a comms-board and an arcana-brain entry — the
    // realistic same-agent state with two dedicated connections.
    const bothEntriesMetadata = (commsConnectionId: string, arcanaConnectionId: string) => ({
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            templateKey: "rh-comms-board",
            dedicated: true,
            connectionId: commsConnectionId,
            binding: { boardAgentId: BOARD_UUID, connectionId: commsConnectionId },
          },
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            connectionId: arcanaConnectionId,
            setup: { state: "ready" },
            binding: { boardAgentId: null, baseSub: ARCANA_PRINCIPAL_ID, connectionId: arcanaConnectionId },
          },
        },
      },
    });

    const arcanaConnection = (over: Record<string, unknown> = {}) =>
      connection({
        id: ARCANA_CONN_ID,
        applicationId: "app-arcana-brain",
        name: `rh-arcana-brain:${ORACLE_ID}`,
        credentialPolicy: "per_agent",
        createdByUserId: null,
        config: {},
        ...over,
      });
    const commsConnection = () =>
      connection({
        id: COMMS_CONN_ID,
        applicationId: "app-comms-board-7673",
        name: `rh-comms-board:${ORACLE_ID}`,
        credentialPolicy: "per_agent",
        createdByUserId: null,
        config: {},
      });

    const oracleAgent = (metadata: unknown) => ({
      id: ORACLE_ID,
      name: "Oracle",
      title: "Chief Brain Officer",
      role: "general",
      metadata,
    });

    it("renders the exact full 42-char canonical brain ID with the agent name and role, never the internal agent UUID, connection UUID, or JWT subject", async () => {
      listApplicationsMock.mockResolvedValue({ applications: [arcanaApplication()] });
      listConnectionsMock.mockResolvedValue({ connections: [arcanaConnection()] });
      listAgentsMock.mockResolvedValue([
        oracleAgent(arcanaEntryMetadata(ARCANA_CONN_ID)),
      ]);

      await renderBrowseExpanded();

      const badge = container.querySelector(
        `code[aria-label="Arcana brain ID: ${CANONICAL_BRAIN_ID}"]`,
      );
      expect(badge).toBeTruthy();
      // The explicit, fully visible text — the exact server-defined canonical
      // format "agent:<principal UUID>", 42 chars: not a shortened form, and
      // not only carried in aria/title attributes.
      expect(badge?.textContent).toBe(CANONICAL_BRAIN_ID);
      expect(badge?.textContent).toHaveLength(42);
      expect(badge?.getAttribute("title")).toBe(`Arcana brain ID: ${CANONICAL_BRAIN_ID}`);
      // The ID wraps (break-all, max-w-full, select-all) instead of
      // clipping; the row title is what truncates first.
      expect(badge?.className).toContain("break-all");
      expect(badge?.className).toContain("max-w-full");
      expect(badge?.className).toContain("select-all");
      expect(badge?.className).not.toContain("truncate");
      // Agent name and role subtitle are preserved next to the badge.
      const nameButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Oracle brain permissions"]',
      );
      expect(nameButton).toBeTruthy();
      expect(nameButton?.textContent).toBe("Oracle brain");
      expect(nameButton?.className).toContain("truncate");
      expect(container.textContent).toContain("Chief Brain Officer");
      expect(container.textContent).not.toContain("Chief Brain Officer · Arcana Brain");
      // No wrong-domain leak in the visible surface: the internal Paperclip
      // agent UUID (full and 8-char prefix), the dedicated connection UUID,
      // and the board JWT subject never appear.
      expect(container.textContent).not.toContain(ORACLE_ID);
      expect(container.textContent).not.toContain(ORACLE_ID.slice(0, 8));
      expect(container.textContent).not.toContain(ARCANA_CONN_ID);
      expect(container.textContent).not.toContain(`paperclip-agent-${ORACLE_ID}`);
      // Clicking the badge never navigates; the permissions button does.
      navigateMock.mockClear();
      await act(async () => {
        badge?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(navigateMock).not.toHaveBeenCalled();
      await act(async () => {
        nameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(navigateMock).toHaveBeenCalledWith(`/apps/${ARCANA_CONN_ID}/permissions`);
    });

    it("keeps the full canonical brain ID intact when the agent name is very long (the name truncates first, the ID never)", async () => {
      const longName = `Oracle von Trapp-Schwarzenberg-Wellington-${"the-Unnecessarily-Hyphenated ".repeat(3)}III`;
      listApplicationsMock.mockResolvedValue({ applications: [arcanaApplication()] });
      listConnectionsMock.mockResolvedValue({ connections: [arcanaConnection()] });
      listAgentsMock.mockResolvedValue([
        {
          id: ORACLE_ID,
          name: longName,
          title: null,
          role: "general",
          metadata: arcanaEntryMetadata(ARCANA_CONN_ID),
        },
      ]);

      await renderBrowseExpanded();

      const badge = container.querySelector(
        `code[aria-label="Arcana brain ID: ${CANONICAL_BRAIN_ID}"]`,
      );
      expect(badge).toBeTruthy();
      // A long title truncates first (structural class — jsdom cannot prove
      // real layout); the canonical ID is never shortened by it.
      expect(badge?.textContent).toBe(CANONICAL_BRAIN_ID);
      expect(badge?.textContent).toHaveLength(42);
      expect(container.textContent).toContain(longName);
    });

    it("hides the badge when metadata is missing, malformed, or setup is not ready, and preserves name, role, and permissions navigation", async () => {
      const PENDING_ID = "22222222-2222-4222-8222-222222222222";
      const BAD_META_ID = "66666666-6666-4666-8666-666666666666";
      listApplicationsMock.mockResolvedValue({ applications: [arcanaApplication()] });
      listConnectionsMock.mockResolvedValue({
        connections: [
          arcanaConnection({ id: "55555555-5555-4555-8555-555555555555" }),
          arcanaConnection({
            id: "55555555-5555-4555-8555-555555555556",
            name: `rh-arcana-brain:${PENDING_ID}`,
          }),
          arcanaConnection({
            id: "55555555-5555-4555-8555-555555555557",
            name: `rh-arcana-brain:${BAD_META_ID}`,
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        // No metadata at all: no badge — but the agent identity stays.
        { id: ORACLE_ID, name: "No Meta Agent", title: "Ops Lead", role: "operations" },
        // Setup pending with a VALID baseSub present: the principal exists,
        // but provisioning has not reached "ready" — the sharpest non-leak
        // case: the would-be principal must not surface anywhere.
        {
          id: PENDING_ID,
          name: "Pending Agent",
          title: "Provisioning Lead",
          role: "general",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "arcana-brain": {
                  key: "arcana-brain",
                  templateKey: "rh-arcana-brain",
                  dedicated: true,
                  setup: { state: "pending" },
                  binding: { baseSub: ARCANA_PRINCIPAL_ID },
                },
              },
            },
          },
        },
        // Malformed metadata (wrong defaultMcp version): same, no crash.
        {
          id: BAD_META_ID,
          name: "Bad Meta Agent",
          title: null,
          role: "data",
          metadata: {
            defaultMcp: {
              version: 2,
              entries: {
                "arcana-brain": {
                  key: "arcana-brain",
                  templateKey: "rh-arcana-brain",
                  dedicated: true,
                  setup: { state: "ready" },
                  binding: { baseSub: ARCANA_PRINCIPAL_ID },
                },
              },
            },
          },
        },
      ]);

      await renderBrowseExpanded();

      // No Arcana badge anywhere, and no internal-Paperclip-ID, principal,
      // or connection-ID fallback in its place.
      expect(
        container.querySelectorAll('code[aria-label^="Arcana brain ID:"]').length,
      ).toBe(0);
      expect(container.textContent).not.toContain(CANONICAL_BRAIN_ID);
      expect(container.textContent).not.toContain(ARCANA_PRINCIPAL_ID);
      expect(container.textContent).not.toContain(ORACLE_ID);
      expect(container.textContent).not.toContain(ORACLE_ID.slice(0, 8));
      expect(container.textContent).not.toContain("55555555-5555");
      // Row identity (name, role) is otherwise untouched.
      expect(container.textContent).toContain("No Meta Agent brain");
      expect(container.textContent).toContain("Ops Lead");
      expect(container.textContent).not.toContain("Ops Lead · Arcana Brain");
      expect(container.textContent).toContain("Pending Agent brain");
      expect(container.textContent).toContain("Provisioning Lead");
      expect(container.textContent).not.toContain("Provisioning Lead · Arcana Brain");
      expect(container.textContent).toContain("Bad Meta Agent brain");
      expect(container.textContent).toContain("data");
      expect(container.textContent).not.toContain("data · Arcana Brain");
      // Permissions navigation still works for a setup-not-ready row.
      navigateMock.mockClear();
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Open Pending Agent brain permissions"]',
          )
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(navigateMock).toHaveBeenCalledWith(
        "/apps/55555555-5555-4555-8555-555555555556/permissions",
      );
    });

    it("falls back to the role alone for whitespace-only and absent titles, keeping the Arcana subtitle connector-free (TECH-7710)", async () => {
      const WHITESPACE_TITLE_ID = "77777777-7777-4777-8777-777777777777";
      const NO_TITLE_ID = "88888888-8888-4888-8888-888888888888";
      listApplicationsMock.mockResolvedValue({ applications: [arcanaApplication()] });
      listConnectionsMock.mockResolvedValue({
        connections: [
          arcanaConnection({
            id: "55555555-5555-4555-8555-555555555559",
            name: `rh-arcana-brain:${WHITESPACE_TITLE_ID}`,
          }),
          arcanaConnection({
            id: "55555555-5555-4555-8555-55555555555a",
            name: `rh-arcana-brain:${NO_TITLE_ID}`,
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        // A whitespace-only title falls back to the role in the subtitle and
        // contributes no parenthetical to the name tooltip.
        {
          id: WHITESPACE_TITLE_ID,
          name: "Sage",
          title: "   ",
          role: "security",
          metadata: arcanaEntryMetadata("55555555-5555-4555-8555-555555555559"),
        },
        // An absent title does the same.
        {
          id: NO_TITLE_ID,
          name: "Nova",
          title: null,
          role: "operations",
          metadata: arcanaEntryMetadata("55555555-5555-4555-8555-55555555555a"),
        },
      ]);

      await renderBrowseExpanded();

      // Display names keep the "<agent name> brain" form, and both badges
      // still render; the fallback is a subtitle concern, not a badge one.
      const sageNameButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Sage brain permissions"]',
      );
      expect(sageNameButton?.textContent).toBe("Sage brain");
      expect(sageNameButton?.getAttribute("title")).toBe("Sage brain");
      expect(
        container.querySelector('button[aria-label="Open Nova brain permissions"]')
          ?.textContent,
      ).toBe("Nova brain");
      expect(
        container.querySelectorAll(
          `code[aria-label="Arcana brain ID: ${CANONICAL_BRAIN_ID}"]`,
        ).length,
      ).toBe(2);

      // The subtitle carries the role alone: no " · " separator and no
      // repeated connector ("Arcana Brain") segment.
      const text = container.textContent ?? "";
      expect(text).toContain("security");
      expect(text).not.toContain("security ·");
      expect(text).toContain("operations");
      expect(text).not.toContain("operations ·");
    });

    it("renders no copy control while the authoritative brain metadata is unresolved, not ready, or mismatched (TECH-7710)", async () => {
      const PENDING_ID = "22222222-2222-4222-8222-222222222222";
      const MISMATCH_ID = "66666666-6666-4666-8666-666666666666";
      listApplicationsMock.mockResolvedValue({ applications: [arcanaApplication()] });
      listConnectionsMock.mockResolvedValue({
        connections: [
          // Agent resolves (the row shows "<agent name> brain") but the agent
          // carries no defaultMcp metadata at all: nothing authoritative.
          arcanaConnection(),
          // Setup not ready: the principal exists (baseSub) but provisioning
          // has not reached "ready", so no badge and no copy control.
          arcanaConnection({
            id: "55555555-5555-4555-8555-555555555556",
            name: `rh-arcana-brain:${PENDING_ID}`,
          }),
          // Authoritative metadata written for a different connection: the
          // entry/binding connectionId never matches this row's connection,
          // so the binding is not this row's to read or copy from.
          arcanaConnection({
            id: "55555555-5555-4555-8555-555555555557",
            name: `rh-arcana-brain:${MISMATCH_ID}`,
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        { id: ORACLE_ID, name: "No Meta Agent", title: "Ops Lead", role: "operations" },
        {
          id: PENDING_ID,
          name: "Pending Agent",
          title: "Provisioning Lead",
          role: "general",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "arcana-brain": {
                  key: "arcana-brain",
                  templateKey: "rh-arcana-brain",
                  dedicated: true,
                  setup: { state: "pending" },
                  binding: { baseSub: ARCANA_PRINCIPAL_ID },
                },
              },
            },
          },
        },
        {
          id: MISMATCH_ID,
          name: "Mismatch Agent",
          title: "Data Lead",
          role: "data",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "arcana-brain": {
                  key: "arcana-brain",
                  templateKey: "rh-arcana-brain",
                  dedicated: true,
                  connectionId: "55555555-5555-4555-8555-555555555599",
                  setup: { state: "ready" },
                  binding: {
                    baseSub: ARCANA_PRINCIPAL_ID,
                    connectionId: "55555555-5555-4555-8555-555555555599",
                  },
                },
              },
            },
          },
        },
      ]);

      await renderBrowseExpanded();

      // No badge, and therefore no copy button and no copy status region.
      // The copy control only exists alongside a resolved authoritative
      // brain ID (it lives inside the badge).
      expect(
        container.querySelectorAll('code[aria-label^="Arcana brain ID:"]').length,
      ).toBe(0);
      expect(
        container.querySelector('button[aria-label^="Copy Arcana brain ID"]'),
      ).toBeNull();
      // The catalog pagination summary is also a status region; only a copy confirmation would be another.
      expect(
        Array.from(container.querySelectorAll('[role="status"]')).filter((el) => !/connectors$/.test(el.textContent?.trim() ?? "")),
      ).toHaveLength(0);
      // The would-be principal never surfaces anywhere on the page.
      expect(container.textContent).not.toContain(CANONICAL_BRAIN_ID);
      expect(container.textContent).not.toContain(ARCANA_PRINCIPAL_ID);
      // Row identity is otherwise intact on every row.
      const text = container.textContent ?? "";
      expect(text).toContain("No Meta Agent brain");
      expect(text).toContain("Pending Agent brain");
      expect(text).toContain("Mismatch Agent brain");
    });

    it("renders the comms badge and the Arcana badge for the same agent's two dedicated connections, each on its own row with no cross-entry leak", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [commsApplication(), arcanaApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [commsConnection(), arcanaConnection()],
      });
      listAgentsMock.mockResolvedValue([
        oracleAgent(bothEntriesMetadata(COMMS_CONN_ID, ARCANA_CONN_ID)),
      ]);

      await renderBrowseExpanded();

      // Both dedicated connections resolve to the same agent; each row shows
      // its own domain's badge, at its own domain's exact value.
      const brainBadge = container.querySelector(
        `code[aria-label="Arcana brain ID: ${CANONICAL_BRAIN_ID}"]`,
      );
      const boardBadge = container.querySelector(
        `code[aria-label="Comms board agent ID: ${BOARD_UUID}"]`,
      );
      expect(brainBadge).toBeTruthy();
      expect(brainBadge?.textContent).toBe(CANONICAL_BRAIN_ID);
      expect(boardBadge).toBeTruthy();
      expect(boardBadge?.textContent).toBe(BOARD_UUID);
      // Row-scoped: the Arcana row carries no comms badge and no board UUID;
      // the comms row carries no Arcana badge and no brain ID or principal.
      const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-app-slug]"));
      const arcanaRow = rows.find((row) =>
        row.querySelector(`code[aria-label="Arcana brain ID: ${CANONICAL_BRAIN_ID}"]`),
      );
      const commsRow = rows.find((row) =>
        row.querySelector(`code[aria-label="Comms board agent ID: ${BOARD_UUID}"]`),
      );
      expect(arcanaRow).toBeTruthy();
      expect(commsRow).toBeTruthy();
      expect(arcanaRow?.querySelector('code[aria-label^="Comms board agent ID:"]')).toBeNull();
      expect(arcanaRow?.textContent).not.toContain(BOARD_UUID);
      expect(commsRow?.querySelector('code[aria-label^="Arcana brain ID:"]')).toBeNull();
      expect(commsRow?.textContent).not.toContain(CANONICAL_BRAIN_ID);
      expect(commsRow?.textContent).not.toContain(ARCANA_PRINCIPAL_ID);
      // The copy control is Arcana-row-only: the Arcana row carries the
      // accessible copy button, while the same agent's sibling comms
      // connector stays copy-free (no button, no copy status region).
      expect(
        arcanaRow?.querySelector('button[aria-label="Copy Arcana brain ID"]'),
      ).toBeTruthy();
      expect(
        commsRow?.querySelector('button[aria-label="Copy Arcana brain ID"]'),
      ).toBeNull();
      expect(commsRow?.querySelector('[role="status"]')).toBeNull();
      // The internal Paperclip agent UUID never renders on either row.
      expect(container.textContent).not.toContain(ORACLE_ID);
      expect(container.textContent).not.toContain(ORACLE_ID.slice(0, 8));
    });

    it("searches connectors by the full canonical brain ID and Arcana principal UUID prefix, and a wrong-domain or unknown ID matches nothing", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [commsApplication(), arcanaApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [commsConnection(), arcanaConnection()],
      });
      listAgentsMock.mockResolvedValue([
        oracleAgent(bothEntriesMetadata(COMMS_CONN_ID, ARCANA_CONN_ID)),
      ]);

      await renderBrowseExpanded();

      const searchInput = container.querySelector<HTMLInputElement>(
        'input[type="search"]',
      )!;
      expect(searchInput).toBeTruthy();

      const setSearch = async (val: string) => {
        await act(async () => {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          nativeSetter?.call(searchInput, val);
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          searchInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await flushReact();
      };
      const arcanaBadgeVisible = () =>
        container.querySelector(`code[aria-label="Arcana brain ID: ${CANONICAL_BRAIN_ID}"]`);

      // The full canonical brain ID (42 chars) finds the Arcana row.
      await setSearch(CANONICAL_BRAIN_ID);
      expect(arcanaBadgeVisible()).toBeTruthy();
      // A canonical-format prefix finds it too.
      await setSearch("agent:33333333");
      expect(arcanaBadgeVisible()).toBeTruthy();
      // The Arcana principal UUID and its prefix find the row through the
      // resolved brain ID — 33333333… is NOT the internal agent id (111…),
      // so this can only match via the canonical ID, never via agent.id.
      await setSearch(ARCANA_PRINCIPAL_ID);
      expect(arcanaBadgeVisible()).toBeTruthy();
      await setSearch("33333333-3333");
      expect(arcanaBadgeVisible()).toBeTruthy();

      // The canonical format does not cross-match the comms-board badge:
      // "agent:44444444" is not a substring of the board UUID, so nothing
      // matches — the comms row must not be hit by an Arcana-shaped query.
      await setSearch("agent:44444444");
      expect(arcanaBadgeVisible()).toBeNull();
      expect(container.textContent).toContain("No connectors match");

      // A fully unknown UUID matches nothing.
      await setSearch("22222222-2222-4222-8222-222222222222");
      expect(arcanaBadgeVisible()).toBeNull();
      expect(container.textContent).toContain("No connectors match");
    });

    it("searches connectors by the '<agent name> brain' display name, filtering out the same agent's non-Arcana connector (TECH-7710)", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [commsApplication(), arcanaApplication()],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [commsConnection(), arcanaConnection()],
      });
      listAgentsMock.mockResolvedValue([
        oracleAgent(bothEntriesMetadata(COMMS_CONN_ID, ARCANA_CONN_ID)),
      ]);

      await renderBrowseExpanded();

      const searchInput = container.querySelector<HTMLInputElement>(
        'input[type="search"]',
      )!;
      const setSearch = async (val: string) => {
        await act(async () => {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          nativeSetter?.call(searchInput, val);
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          searchInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await flushReact();
      };
      const arcanaBadgeVisible = () =>
        container.querySelector(`code[aria-label="Arcana brain ID: ${CANONICAL_BRAIN_ID}"]`);
      const commsBadgeVisible = () =>
        container.querySelector(`code[aria-label="Comms board agent ID: ${BOARD_UUID}"]`);

      // Both of the same agent's dedicated connectors start visible.
      expect(arcanaBadgeVisible()).toBeTruthy();
      expect(commsBadgeVisible()).toBeTruthy();

      // The Arcana display name "Oracle brain" finds the Arcana row, and
      // only it: no other field on the comms row contains "oracle brain"
      // (its display name is "Oracle" with no " brain" suffix, its connector
      // is "ReClaw Comms Board"), so the irrelevant sibling filters out
      // while the list stays non-empty.
      await setSearch("Oracle brain");
      expect(arcanaBadgeVisible()).toBeTruthy();
      expect(commsBadgeVisible()).toBeNull();
      expect(container.textContent).not.toContain("No connectors match");

      // The bare agent name still finds both rows: non-Arcana dedicated
      // connectors keep matching by their plain agent name.
      await setSearch("Oracle");
      expect(arcanaBadgeVisible()).toBeTruthy();
      expect(commsBadgeVisible()).toBeTruthy();
    });

    it("uses the resolved agent name (never the brain ID or connection UUID) in the remove-connection confirmation", async () => {
      listApplicationsMock.mockResolvedValue({ applications: [arcanaApplication()] });
      listConnectionsMock.mockResolvedValue({ connections: [arcanaConnection()] });
      listAgentsMock.mockResolvedValue([
        oracleAgent(arcanaEntryMetadata(ARCANA_CONN_ID)),
      ]);

      await renderBrowseExpanded();

      const menuTrigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Manage Oracle brain connection"]',
      );
      expect(menuTrigger).toBeTruthy();

      await act(async () => {
        menuTrigger?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      await flushReact();

      const removeItem = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((item) => item.textContent?.trim() === "Remove connection");
      expect(removeItem).toBeTruthy();

      await act(async () => {
        removeItem?.dispatchEvent(new Event("click", { bubbles: true }));
      });
      await flushReact();

      // The destructive confirmation dialog names the agent — never the
      // canonical brain ID or the dedicated connection UUID. Scoped to the
      // dialog itself: the row behind it legitimately keeps its badge.
      const dialog = document.body.querySelector<HTMLElement>(
        '[data-slot="alert-dialog-content"]',
      );
      expect(dialog).toBeTruthy();
      expect(dialog?.textContent).toContain("Remove Oracle brain connection?");
      expect(dialog?.textContent).not.toContain(CANONICAL_BRAIN_ID);
      expect(dialog?.textContent).not.toContain(ARCANA_CONN_ID);
      expect(dialog?.textContent).not.toContain(ARCANA_PRINCIPAL_ID);
    });
  });
});

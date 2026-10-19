// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse } from "./Browse";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const archiveConnectionMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const startOAuthMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const prepareOAuthNavigationMock = vi.hoisted(() => vi.fn());
const navigateTopLevelMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const experimentalMock = vi.hoisted(() => vi.fn());
const chatListMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: experimentalMock } }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { list: chatListMock } }));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    archiveConnection: (
      connectionId: string,
      options?: { confirmComposioChildren?: boolean },
    ) => archiveConnectionMock(connectionId, options),
    startOAuth: (connectionId: string, input: Record<string, unknown>) =>
      startOAuthMock(connectionId, input),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
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
    experimentalMock.mockResolvedValue({ enableChatConnectors: true });
    chatListMock.mockResolvedValue([]);
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
    listAgentsMock.mockResolvedValue([]);
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
    vi.clearAllMocks();
  });

  async function renderBrowse() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Browse />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return client;
  }

  it("defaults to tools-only GitHub and hides chat-only catalog and existing chat accounts", async () => {
    experimentalMock.mockResolvedValue({});
    listGalleryMock.mockResolvedValue({ apps: ["github", "discord", "telegram", "microsoft-teams"].map(getAppStoreDefinition) });
    listApplicationsMock.mockResolvedValue({ applications: [application({
      id: "chat-app", type: "chat", name: "Private bot", applicationKey: "chat:github:endpoint-1", metadata: { purpose: "channel" },
    })] });
    await renderBrowse();
    expect(chatListMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-app-slug="github"]')).not.toBeNull();
    for (const slug of ["discord", "telegram", "microsoft-teams", "slack"]) {
      expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
    }
    expect(container.textContent).not.toContain("Private bot");
    expect(container.textContent).not.toContain("Chat with agents");
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github");
  });

  it("restores the GitHub intent chooser when enabled and hides cached chat rows immediately when disabled", async () => {
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("github")] });
    chatListMock.mockResolvedValue([{ id: "endpoint-1", provider: "github", status: "active", assignedAgentName: "Chat agent", botLabel: "Chat bot", assignedAgentId: "agent-1" }]);
    const client = await renderBrowse();
    expect(chatListMock).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-app-slug="telegram"]')).not.toBeNull();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Add connection GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/connect?provider=github&toolHref=%2Fapps%2Fconnect%3Fsource%3Dgithub");
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: false }); });
    await flushReact();
    expect(container.querySelector('[data-app-slug="telegram"]')).toBeNull();
    expect(container.textContent).not.toContain("Chat agent");
    expect(container.querySelector('a[href*="/apps/chat/"]')).toBeNull();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github");
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
      "justify-start",
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
      "discord",
      "github",
      "gmail",
      "imessage-photon",
      "jira",
      "microsoft-teams",
      "notion",
      "slack",
      "telegram",
      "custom-mcp",
    ]);
    expect(
      container.querySelector('button[aria-label="Connect Jira"]'),
    ).toBeTruthy();
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Unavailable Gmail"]',
      )?.disabled,
    ).toBe(true);
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
    expect(rows[0]?.dataset.appSlug).toBe("notion");
    const notion = rows[0]!;
    expect(notion.textContent).toContain("devinfoley@gmail.com");
    expect(notion.textContent).toContain("ops@example.com");
    expect(notion.textContent).toContain("Connected by");
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

    expect(archiveConnectionMock).toHaveBeenCalledWith("conn-notion", {
      confirmComposioChildren: false,
    });
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connection removed",
        tone: "success",
      }),
    );
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

    await renderBrowse();

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

    await renderBrowse();

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

    await renderBrowse();

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

    await renderBrowse();

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

      const client = await renderBrowse();
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
      await renderBrowse();
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
      await renderBrowse();
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

      await renderBrowse();

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

      await renderBrowse();

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
      expect(container.textContent).toContain("Connected by");
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

      await renderBrowse();

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

      await renderBrowse();

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

      await renderBrowse();

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

      await renderBrowse();

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

    await renderBrowse();

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

  it("filters the single list without restoring section chrome", async () => {
    await renderBrowse();

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

      await renderBrowse();

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
      await renderBrowse();
      let row = container.querySelector<HTMLElement>('[data-app-slug="default-mcp-rh-google-mcp"]');
      expect(row!.querySelector('button[aria-label="Connect RH Google MCP"]')).toBeTruthy();
      expect(row!.textContent).toContain("Connected by");
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
      await renderBrowse();
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

      await renderBrowse();

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

      await renderBrowse();

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
      await renderBrowse();
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
      await renderBrowse();
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

      await renderBrowse();

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
      await renderBrowse();
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

    await renderBrowse();

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

      await renderBrowse();

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

      await renderBrowse();

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

      await renderBrowse();

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

      await renderBrowse();

      // Display names keep the "<agent name> brain" form, and both badges
      // still render — the fallback is a subtitle concern, not a badge one.
      const sageNameButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Sage brain permissions"]',
      );
      expect(sageNameButton?.textContent).toBe("Sage brain");
      expect(sageNameButton?.getAttribute("title")).toBe("Sage");
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
          // has not reached "ready" — no badge, no copy control.
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

      await renderBrowse();

      // No badge — and therefore no copy button and no copy status region.
      // The copy control only exists alongside a resolved authoritative
      // brain ID (it lives inside the badge).
      expect(
        container.querySelectorAll('code[aria-label^="Arcana brain ID:"]').length,
      ).toBe(0);
      expect(
        container.querySelector('button[aria-label^="Copy Arcana brain ID"]'),
      ).toBeNull();
      expect(container.querySelector('[role="status"]')).toBeNull();
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

      await renderBrowse();

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

      await renderBrowse();

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

      await renderBrowse();

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

      // The Arcana display name "Oracle brain" finds the Arcana row — and
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

      await renderBrowse();

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

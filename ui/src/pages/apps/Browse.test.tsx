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
});

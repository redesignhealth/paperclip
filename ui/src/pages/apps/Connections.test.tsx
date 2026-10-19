// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connections } from "./Connections";

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listAppsAttentionMock = vi.hoisted(() => vi.fn());
const listProfilesMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const archiveConnectionMock = vi.hoisted(() => vi.fn());
const getCloudConnectorEnrollmentMock = vi.hoisted(() => vi.fn());
const startCloudConnectorEnrollmentMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    listAppsAttention: (companyId: string) => listAppsAttentionMock(companyId),
    listProfiles: (companyId: string) => listProfilesMock(companyId),
    archiveConnection: (connectionId: string, options?: { confirmComposioChildren?: boolean }) =>
      archiveConnectionMock(connectionId, options),
    getCloudConnectorEnrollment: () => getCloudConnectorEnrollmentMock(),
    startCloudConnectorEnrollment: (companyId: string, label?: string) => startCloudConnectorEnrollmentMock(companyId, label),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// React 19 does not export a usable `act` in this vitest/jsdom setup; use the
// flushSync-based helper the sibling apps tests use (PAP-12371 gotcha).
async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function application(overrides: Record<string, unknown>) {
  return {
    id: "app-x",
    companyId: "company-1",
    applicationKey: undefined,
    name: "GitHub",
    description: null,
    type: "mcp_http",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: null,
    metadata: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown>) {
  return {
    id: "conn-x",
    companyId: "company-1",
    applicationId: "app-x",
    name: "GitHub",
    connectionKind: "managed",
    transport: "mcp_remote",
    status: "active",
    transportConfig: {},
    config: {},
    credentialSecretRefs: [],
    healthStatus: "healthy",
    healthCheckedAt: null,
    lastError: null,
    credentialPolicy: "shared",
    enabled: true,
    lastUsedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function profile(connectionId: string, includedEntryIds: string[]) {
  return {
    id: `profile-${connectionId}`,
    companyId: "company-1",
    profileKey: `app:${connectionId}`,
    name: connectionId,
    description: null,
    status: "active",
    defaultAction: "deny",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    entries: includedEntryIds.map((catalogEntryId, index) => ({
      id: `entry-${connectionId}-${index}`,
      companyId: "company-1",
      profileId: `profile-${connectionId}`,
      selectorType: "catalog_entry",
      effect: "include",
      applicationId: null,
      connectionId,
      catalogEntryId,
      toolName: null,
      riskLevel: null,
      conditions: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })),
    bindings: [],
  };
}

function mockAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "1d37c752-ef9d-4185-bfd5-3249898f6bc2",
    companyId: "company-1",
    name: "General Counsel",
    urlKey: "general-counsel",
    role: "general",
    title: "Chief Legal Officer",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Install row shape returned by GET /tool-connections (listConnections
 * populates `installs` for every connection). A "Who can use it" agent
 * toggle writes exactly this row on ordinary shared/personal connections —
 * see server default-mcp-hardening tests ("ordinary OAuth entry: normal
 * toggle").
 */
function agentInstall(connectionId: string, agentId: string) {
  return {
    id: `inst-${connectionId}-${agentId}`,
    companyId: "company-1",
    connectionId,
    targetType: "agent",
    targetId: agentId,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("Connections table (M1b / PAP-13254 door 2)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    listGalleryMock.mockResolvedValue({ apps: [] });
    listAppsAttentionMock.mockResolvedValue({ apps: [] });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    listProfilesMock.mockResolvedValue({ profiles: [] });
    listUserDirectoryMock.mockResolvedValue({ users: [] });
    listAgentsMock.mockResolvedValue([]);
    archiveConnectionMock.mockResolvedValue(connection({ id: "c-deleted", status: "archived" }));
    getCloudConnectorEnrollmentMock.mockResolvedValue({
      configured: true,
      status: "active",
      brokerBaseUrl: "https://my.paperclip.app",
      instanceId: "instance-test",
      environment: "development",
      origins: ["http://localhost:3100"],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderApps() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Connections />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders applications without connections as not connected with a Connect action", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });

    await renderApps();

    const text = container.textContent ?? "";
    expect(text).toContain("All (1)");
    expect(text).toContain("GitHub");
    expect(text).toContain("Not connected");
    expect(text).toContain("Connect it so agents can use it.");
    expect(text).toContain("Connect");

    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      tr.textContent?.includes("GitHub"),
    );
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/app/app-github/permissions");

    mockNavigate.mockClear();
    const connectButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Connect") && !button.textContent.includes("Connect an app"),
    );
    connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/app/app-github/permissions");
  });

  it("renders every account with its owner, status, actions, and direct edit navigation", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({ id: "app-github", name: "GitHub" }),
        application({ id: "app-slack", name: "Slack" }),
        application({ id: "app-notion", name: "Notion" }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "c-connected",
          applicationId: "app-github",
          name: "GitHub",
          healthStatus: "healthy",
          createdByUserId: "user-1",
          credentialPolicy: "per_user",
        }),
        connection({
          id: "c-attention",
          applicationId: "app-slack",
          name: "Slack",
          healthStatus: "error",
          lastUsedAt: new Date("2026-06-09T00:00:00Z"),
        }),
        connection({ id: "c-attention-2", applicationId: "app-slack", name: "Slack Team", healthStatus: "healthy" }),
        connection({ id: "c-paused", applicationId: "app-notion", name: "Notion", enabled: false }),
      ],
    });
    listAppsAttentionMock.mockResolvedValue({
      apps: [
        {
          connection: connection({ id: "c-attention", applicationId: "app-slack", name: "Slack", healthStatus: "error" }),
          healthNeedsAttention: true,
          quarantinedCatalogEntryCount: 0,
          pendingActionRequestCount: 0,
          reasons: ["health"],
        },
        {
          connection: connection({ id: "c-attention-2", applicationId: "app-slack", name: "Slack Team", healthStatus: "healthy" }),
          healthNeedsAttention: false,
          quarantinedCatalogEntryCount: 1,
          pendingActionRequestCount: 0,
          reasons: ["quarantined_catalog_entries"],
        },
      ],
    });
    listProfilesMock.mockResolvedValue({
      profiles: [
        profile("c-connected", ["a", "b", "c"]),
        profile("c-attention", ["a"]),
        profile("c-attention-2", ["b", "c"]),
      ],
    });
    listUserDirectoryMock.mockResolvedValue({
      users: [{
        principalId: "user-1",
        status: "active",
        user: {
          id: "user-1",
          name: "Dotta",
          email: "dotta@example.com",
          image: "https://example.com/dotta.png",
        },
      }],
    });

    await renderApps();

    const text = container.textContent ?? "";
    // 1. Connected rows lose the repeated hint.
    expect(text).not.toContain("Connected and ready");
    // 2. Attention + Paused rows keep their explanatory hint.
    expect(text).toContain("The key stopped working");
    expect(text).toContain("Paused — agents can");
    // 3. Every account has its own filterable row and health signal.
    expect(text).toContain("All (4)");
    expect(text).toContain("Needs attention (1)");
    expect(text).toContain("1 connection needs attention");
    // 3. New header columns are present.
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(headers).toEqual(["Connection", "Type", "Connected by", "Status", "Actions", "Last used", ""]);
    expect(text).toContain("Personal");
    expect(text).toContain("Company");
    // 4. Actions column reflects enabled catalog entries per account; missing profile => 0 on.
    expect(text).toContain("3 on");
    expect(text).toContain("0 on");
    // 5. Last used renders a relative timestamp when present, dash when absent.
    expect(text).toContain("—");
    // 6. Multi-account apps appear once per connection and edit the selected account directly.
    expect(Array.from(container.querySelectorAll("tbody tr")).filter((tr) => tr.textContent?.includes("Slack"))).toHaveLength(2);
    const slackRow = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      tr.textContent?.includes("Slack"),
    );
    slackRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/c-attention/permissions");
    // 7. Button labels are honest: broken health says Reconnect, healthy/paused say Edit.
    const rowButtonLabel = (name: string, exact = false) =>
      Array.from(container.querySelectorAll("tbody tr"))
        .find((tr) => exact ? tr.textContent?.includes(name) && !tr.textContent?.includes("Slack Team") : tr.textContent?.includes(name))
        ?.querySelector("td:last-child button")?.textContent;
    expect(rowButtonLabel("GitHub")).toBe("Permissions");
    expect(rowButtonLabel("Slack", true)).toBe("Reconnect");
    expect(rowButtonLabel("Notion")).toBe("Permissions");
    // 8. Generic connection names inherit the originating user's first name.
    expect(text).toContain("Dotta’s GitHub");
    expect(text).toContain("Slack for the company");
    expect(text).toContain("Slack Team for the company");
    expect(container.querySelector('[title="Dotta"] [data-slot="avatar"]')).toBeTruthy();
    // Custom account labels remain untouched.
    expect(text).toContain("Slack Team");
  });

  // F6 (PAP-13254 §4): the row highlight and the Status pill derive from ONE
  // health signal, so they can never disagree. A healthy connection stays
  // "Healthy" / "Edit" and is not amber-highlighted, even if the broader
  // attention endpoint would once have flagged it (quarantine/new-tools review
  // now live on the app detail + Review door, not the Connections highlight).
  it("keeps a healthy app un-highlighted and editable — pill and highlight agree (F6)", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [connection({ id: "c-healthy", applicationId: "app-github", healthStatus: "healthy" })],
    });
    listAppsAttentionMock.mockResolvedValue({
      apps: [
        {
          connection: connection({ id: "c-healthy", applicationId: "app-github", healthStatus: "healthy" }),
          healthNeedsAttention: false,
          quarantinedCatalogEntryCount: 2,
          pendingActionRequestCount: 0,
          reasons: ["quarantined_catalog_entries"],
        },
      ],
    });

    await renderApps();

    expect(container.textContent).toContain("Healthy");
    // No attention: the danger banner and attention filter chip are inert.
    expect(container.textContent).not.toContain("needs attention");
    expect(container.textContent).toContain("Needs attention (0)");
    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      tr.textContent?.includes("GitHub"),
    );
    expect(row?.className).not.toContain("amber");
    const button = row?.querySelector("td:last-child button");
    expect(button?.textContent).toBe("Permissions");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/c-healthy/permissions");
  });

  it("deletes a connection only after trash-can confirmation", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [connection({ id: "c-github", applicationId: "app-github", name: "GitHub" })],
    });

    await renderApps();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete GitHub for the company connection"]',
    );
    expect(deleteButton).toBeTruthy();

    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Delete GitHub connection?");

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete connection",
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("c-github", {
      confirmComposioChildren: false,
    });
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connection deleted",
        body: "GitHub is no longer available to agents and its credentials are deleted. Connecting it again needs a new sign-in or key.",
        tone: "success",
      }),
    );
  });

  it("confirms that deleting a Composio parent removes its child services", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-composio", name: "Composio" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "composio-parent",
          applicationId: "app-composio",
          name: "Composio",
          config: { sourceTemplateKey: "composio" },
        }),
        connection({
          id: "composio-github",
          applicationId: "app-composio",
          name: "GitHub (via Composio)",
          config: { provider: "composio", parentConnectionId: "composio-parent", toolkitSlug: "github" },
        }),
      ],
    });

    await renderApps();
    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Composio for the company connection"]',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("This also removes 1 connected service");
    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete connection",
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("composio-parent", {
      confirmComposioChildren: true,
    });
  });

  it("reports the remaining active connections after deleting one", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({ id: "c-github-primary", applicationId: "app-github", name: "GitHub" }),
        connection({ id: "c-github-secondary", applicationId: "app-github", name: "GitHub Team" }),
      ],
    });

    await renderApps();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete GitHub for the company connection"]',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain(
      "Agents can still use GitHub through 1 other active connection.",
    );

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete connection",
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("c-github-primary", {
      confirmComposioChildren: false,
    });
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connection deleted",
        body: "GitHub still has 1 active connection available to agents.",
        tone: "success",
      }),
    );
  });

  it("does not count disabled connections as available after deletion", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({ id: "c-github-primary", applicationId: "app-github", name: "GitHub" }),
        connection({
          id: "c-github-disabled",
          applicationId: "app-github",
          name: "GitHub Disabled",
          status: "disabled",
          enabled: false,
        }),
      ],
    });

    await renderApps();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete GitHub for the company connection"]',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain(
      "The saved credentials are deleted and agents lose access immediately.",
    );
    expect(document.body.textContent).toContain("needs a new sign-in or key");
    expect(document.body.textContent).not.toContain("Agents can still use GitHub");

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete connection",
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "GitHub is no longer available to agents and its credentials are deleted. Connecting it again needs a new sign-in or key.",
      }),
    );
  });

  describe("agent dedicated connections (TECH-7592)", () => {
    it("renders human-readable agent name, short ID with full ID accessible, and title with app name", async () => {
      const agentId = "1d37c752-ef9d-4185-bfd5-3249898f6bc2";
      const boardAgentId = "6c8935b2-ef9d-4185-bfd5-3249898f6bc2";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms",
            applicationId: "app-comms",
            name: `rh-comms-board:${agentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: agentId,
          name: "Legal Agent",
          title: "General Counsel",
          role: "general",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  connectionId: "c-comms",
                  binding: { boardAgentId },
                },
              },
            },
          },
        }),
      ]);

      await renderApps();

      const text = container.textContent ?? "";
      // Primary display name is agent.name
      expect(text).toContain("Legal Agent");
      // Full comms board agent ID is visible
      expect(text).toContain(boardAgentId);
      // Secondary subtitle shows title and application name
      expect(text).toContain("General Counsel · ReClaw Comms Board");
      // Full ID accessible via code badge
      const idElem = container.querySelector(`code[aria-label="Comms board agent ID: ${boardAgentId}"]`);
      expect(idElem).toBeTruthy();
      expect(idElem?.textContent).toBe(boardAgentId);
      // The explicit fully-visible text is the whole 36-char UUID — never a
      // shortened or prefixed display, and never only in aria/title.
      expect(idElem?.textContent).toHaveLength(36);
      expect(idElem?.getAttribute("title")).toBe(`Comms board agent ID: ${boardAgentId}`);
      // Explicitly NOT the Paperclip internal agent ID (full or 8-char
      // prefix) and NOT the board JWT subject.
      expect(text).not.toContain(agentId);
      expect(text).not.toContain(agentId.slice(0, 8));
      expect(text).not.toContain(`paperclip-agent-${agentId}`);
      // The retired popover trigger must not come back.
      expect(
        container.querySelector('button[aria-label^="Show full agent ID"]'),
      ).toBeNull();
      // The ID wraps (break-all) instead of clipping; the row title is what
      // truncates first (structural classes — jsdom cannot prove layout).
      expect(idElem?.className).toContain("max-w-full");
      expect(idElem?.className).toContain("break-all");
      expect(idElem?.className).toContain("select-all");
      expect(idElem?.className).not.toContain("truncate");
      const nameSpan = container.querySelector('span[title="Legal Agent (General Counsel)"]');
      expect(nameSpan?.className).toContain("truncate");
    });

    it("keeps the full comms-board agent ID intact when the agent name is very long (the name may truncate, the ID may not)", async () => {
      const agentId = "4d6e8f01-1234-4567-89ab-cdef01234576";
      const boardAgentId = "8f01a2b3-4c5d-4e6f-9a8b-7c6d5e4f3a2b";
      const longName = `Legal Ops Agent von Trapp-Schwarzenberg-Wellington-${"the-Unnecessarily-Hyphenated ".repeat(3)}III`;
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-long",
            applicationId: "app-comms",
            name: `rh-comms-board:${agentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: agentId,
          name: longName,
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
                  connectionId: "c-comms-long",
                  binding: { boardAgentId },
                },
              },
            },
          },
        }),
      ]);

      await renderApps();

      const idElem = container.querySelector(`code[aria-label="Comms board agent ID: ${boardAgentId}"]`);
      expect(idElem).toBeTruthy();
      // A long title truncates first; the ID is never shortened by it.
      expect(idElem?.textContent).toBe(boardAgentId);
      expect(idElem?.textContent).toHaveLength(36);
      const text = container.textContent ?? "";
      expect(text).toContain(longName);
      expect(text).not.toContain(agentId);
    });

    it("hides the badge when the board ID is unresolvable (missing or malformed metadata) and preserves name, subtitle, and permissions navigation", async () => {
      const noMetaAgentId = "5e71b196-1234-4567-89ab-cdef01234577";
      const badMetaAgentId = "6f81c207-1234-4567-89ab-cdef01234578";
      const hiddenBoardId = "9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-nometa",
            applicationId: "app-comms",
            name: `rh-comms-board:${noMetaAgentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
          connection({
            id: "c-badmeta",
            applicationId: "app-comms",
            name: `rh-comms-board:${badMetaAgentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        // No metadata at all (mockAgent default): no badge, identity intact.
        mockAgent({ id: noMetaAgentId, name: "Ops Agent", title: "Head of Ops", role: "operations" }),
        // Malformed metadata (wrong defaultMcp version): same, no crash.
        mockAgent({
          id: badMetaAgentId,
          name: "Data Agent",
          title: "Chief Data Officer",
          role: "data",
          metadata: {
            defaultMcp: {
              version: 2,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  binding: { boardAgentId: hiddenBoardId },
                },
              },
            },
          },
        }),
      ]);

      await renderApps();

      // No badge anywhere, and no internal Paperclip-ID fallback (the
      // removed slice(0, 8) display must not resurface for these rows).
      expect(container.querySelectorAll("code").length).toBe(0);
      const text = container.textContent ?? "";
      expect(text).not.toContain(hiddenBoardId);
      expect(text).not.toContain(noMetaAgentId);
      expect(text).not.toContain(noMetaAgentId.slice(0, 8));
      expect(text).not.toContain(badMetaAgentId);
      // Row identity and subtitles are otherwise untouched.
      expect(text).toContain("Ops Agent");
      expect(text).toContain("Head of Ops · ReClaw Comms Board");
      expect(text).toContain("Data Agent");
      expect(text).toContain("Chief Data Officer · ReClaw Comms Board");
      // Permissions navigation is preserved on an unresolvable-badge row.
      const dataRow = Array.from(container.querySelectorAll("tr")).find((row) =>
        row.textContent?.includes("Data Agent"),
      );
      expect(dataRow).toBeTruthy();
      const manageButton = Array.from(dataRow?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent?.trim() === "Permissions",
      );
      expect(manageButton).toBeTruthy();
      await act(async () => {
        manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(mockNavigate).toHaveBeenCalledWith("/apps/c-badmeta/permissions");
    });

    it("falls back to role in secondary subtitle when agent title is absent", async () => {
      const agentId = "2b48e863-1234-4567-89ab-cdef01234567";
      const boardAgentId = "7d9046c3-1234-4567-89ab-cdef01234567";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-2",
            applicationId: "app-comms",
            name: `rh-comms-board:${agentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: agentId,
          name: "Security Bot",
          title: null,
          role: "security",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  connectionId: "c-comms-2",
                  binding: { boardAgentId },
                },
              },
            },
          },
        }),
      ]);

      await renderApps();

      const text = container.textContent ?? "";
      expect(text).toContain("Security Bot");
      expect(text).toContain(boardAgentId);
      expect(text).toContain("security · ReClaw Comms Board");
      expect(text).not.toContain(`paperclip-agent-${agentId}`);
    });

    it("falls back to humanized connection name when agent is not in directory (missing / deleted)", async () => {
      const missingAgentId = "3c59f974-5678-9abc-def0-123456789abc";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-missing",
            applicationId: "app-comms",
            name: `rh-comms-board:${missingAgentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([]);

      await renderApps();

      const text = container.textContent ?? "";
      // Does not show raw JWT subject
      expect(text).not.toContain(`paperclip-agent-${missingAgentId}`);
      // Subtitle is the application name since displayName !== application.name
      expect(text).toContain("ReClaw Comms Board");
      // No agent ID trigger rendered
      expect(container.querySelector(`button[title="${missingAgentId}"]`)).toBeNull();
    });

    it("does not leak agents from other companies", async () => {
      const otherCompanyAgentId = "4d60a085-6789-0abc-def1-23456789abcd";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-other",
            applicationId: "app-comms",
            name: `rh-comms-board:${otherCompanyAgentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
        ],
      });
      // Selected company is company-1, so listAgentsMock only returns company-1 agents
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: "different-agent-id",
          companyId: "company-1",
          name: "Company-1 Agent",
        }),
      ]);

      await renderApps();

      // The agents request itself is scoped to the selected company — the
      // company boundary is enforced by that call, not by post-hoc filtering.
      expect(listAgentsMock).toHaveBeenCalledWith("company-1");
      const text = container.textContent ?? "";
      expect(text).not.toContain("Company-1 Agent");
      expect(text).not.toContain(`paperclip-agent-${otherCompanyAgentId}`);
    });

    it("falls back while the agents list is loading and upgrades the row once it resolves", async () => {
      const agentId = "5e71b196-1234-4567-89ab-cdef01234567";
      const boardAgentId = "8e0157d4-1234-4567-89ab-cdef01234567";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-loading",
            applicationId: "app-comms",
            name: `rh-comms-board:${agentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
        ],
      });
      let resolveAgents: (agents: unknown[]) => void = () => {};
      listAgentsMock.mockImplementation(
        () => new Promise((resolve) => { resolveAgents = resolve; }),
      );

      await renderApps();

      // The table renders without waiting for the agents query: the row falls
      // back to the humanized connection name, shows the application subtitle,
      // and renders no agent identity yet.
      const loadingText = container.textContent ?? "";
      expect(loadingText).toContain("All (1)");
      expect(loadingText).not.toContain("Ops Agent");
      expect(container.querySelector(`code[aria-label="Comms board agent ID: ${boardAgentId}"]`)).toBeNull();

      await act(async () => {
        resolveAgents([
          mockAgent({
            id: agentId,
            name: "Ops Agent",
            title: "Head of Ops",
            metadata: {
              defaultMcp: {
                version: 1,
                entries: {
                  "comms-board": {
                    key: "comms-board",
                    templateKey: "rh-comms-board",
                    dedicated: true,
                    connectionId: "c-comms-loading",
                    binding: { boardAgentId },
                  },
                },
              },
            },
          }),
        ]);
      });
      await flushReact();

      // Once the agents query resolves, the row upgrades to the agent
      // identity: name, comms board agent ID, title subtitle.
      const upgradedText = container.textContent ?? "";
      expect(upgradedText).toContain("Ops Agent");
      const idElem = container.querySelector(`code[aria-label="Comms board agent ID: ${boardAgentId}"]`);
      expect(idElem?.textContent).toBe(boardAgentId);
      expect(upgradedText).toContain("Head of Ops · ReClaw Comms Board");
    });

    it("keeps company and personal connections unchanged when installed on an agent (resolver policy gating)", async () => {
      const agentId = "6f82c397-1234-4567-89ab-cdef01234568";
      listApplicationsMock.mockResolvedValue({
        applications: [
          application({ id: "app-slack", name: "Slack" }),
          application({ id: "app-notion", name: "Notion" }),
        ],
      });
      // Ordinary connections carrying a "Who can use it" agent install — the
      // exact state the normal install toggle writes for shared/personal
      // connections (see the server default-mcp-hardening "normal toggle" case).
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-slack-company",
            applicationId: "app-slack",
            name: "Slack",
            credentialPolicy: "shared",
            installs: [
              {
                id: "inst-company-slack",
                companyId: "company-1",
                connectionId: "c-slack-company",
                targetType: "company",
                targetId: "company-1",
                createdByAgentId: null,
                createdByUserId: "user-1",
                createdAt: new Date("2026-01-01T00:00:00Z"),
              },
              agentInstall("c-slack-company", agentId),
            ],
          }),
          connection({
            id: "c-notion-personal",
            applicationId: "app-notion",
            name: "Notion",
            credentialPolicy: "per_user",
            createdByUserId: "user-1",
            installs: [agentInstall("c-notion-personal", agentId)],
          }),
        ],
      });
      listUserDirectoryMock.mockResolvedValue({
        users: [{
          principalId: "user-1",
          status: "active",
          user: {
            id: "user-1",
            name: "Dotta",
            email: "dotta@example.com",
            image: "https://example.com/dotta.png",
          },
        }],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({ id: agentId, name: "Board Ops Agent", title: "Chief Ops Officer" }),
      ]);

      await renderApps();

      const text = container.textContent ?? "";
      // A shared connection keeps its "for the company" display name …
      expect(text).toContain("Slack for the company");
      // … and a personal connection keeps its owner-possessive display name …
      expect(text).toContain("Dotta’s Notion");
      // … even though both are installed on an agent. Agent identity is only
      // for per_agent (dedicated) connections; an install row alone must not
      // rename a company/personal connection.
      expect(text).not.toContain("Board Ops Agent");
      expect(container.querySelector(`button[title="${agentId}"]`)).toBeNull();
      expect(text).not.toContain("Chief Ops Officer · Slack");
      expect(text).not.toContain("Chief Ops Officer · Notion");
    });

    it("trims padded agent titles and falls back to the role for whitespace-only titles", async () => {
      const whitespaceAgentId = "7a93d4a8-1234-4567-89ab-cdef01234569";
      const paddedAgentId = "8b04e5b9-1234-4567-89ab-cdef01234570";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-whitespace",
            applicationId: "app-comms",
            name: `rh-comms-board:${whitespaceAgentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
          connection({
            id: "c-comms-padded",
            applicationId: "app-comms",
            name: `rh-comms-board:${paddedAgentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({ id: whitespaceAgentId, name: "Security Bot", title: "   ", role: "security" }),
        mockAgent({ id: paddedAgentId, name: "Ops Bot", title: "  Head of Ops  ", role: "operations" }),
      ]);

      await renderApps();

      const text = container.textContent ?? "";
      // A whitespace-only title falls back to the role in the subtitle …
      expect(text).toContain("security · ReClaw Comms Board");
      // … and the name tooltip carries no parenthetical title.
      const whitespaceNameSpan = container.querySelector('span[title="Security Bot"]');
      expect(whitespaceNameSpan?.textContent).toBe("Security Bot");
      // A padded title is trimmed in the subtitle …
      expect(text).toContain("Head of Ops · ReClaw Comms Board");
      expect(text).not.toContain("  Head of Ops  ");
      // … and in the parenthetical of the name tooltip.
      const paddedNameSpan = container.querySelector('span[title="Ops Bot (Head of Ops)"]');
      expect(paddedNameSpan?.textContent).toBe("Ops Bot");
    });

    it("keeps paused and needs-attention hints on agent rows, with connected-by retained", async () => {
      const pausedAgentId = "9c15f6ca-1234-4567-89ab-cdef01234571";
      const pausedBoardId = "9f1268e5-1234-4567-89ab-cdef01234567";
      const attentionAgentId = "0d26a7db-1234-4567-89ab-cdef01234572";
      const attentionBoardId = "a02379f6-1234-4567-89ab-cdef01234567";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-paused",
            applicationId: "app-comms",
            name: `rh-comms-board:${pausedAgentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "healthy",
            enabled: false,
            createdByUserId: "user-1",
          }),
          connection({
            id: "c-comms-attention",
            applicationId: "app-comms",
            name: `rh-comms-board:${attentionAgentId}`,
            credentialPolicy: "per_agent",
            healthStatus: "error",
            authKind: "api_key",
          }),
        ],
      });
      listUserDirectoryMock.mockResolvedValue({
        users: [{
          principalId: "user-1",
          status: "active",
          user: {
            id: "user-1",
            name: "Dotta",
            email: "dotta@example.com",
            image: "https://example.com/dotta.png",
          },
        }],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: pausedAgentId,
          name: "Legal Ops Agent",
          title: "General Counsel",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  connectionId: "c-comms-paused",
                  binding: { boardAgentId: pausedBoardId },
                },
              },
            },
          },
        }),
        mockAgent({
          id: attentionAgentId,
          name: "Sec Ops Agent",
          title: "Security Lead",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  connectionId: "c-comms-attention",
                  binding: { boardAgentId: attentionBoardId },
                },
              },
            },
          },
        }),
      ]);

      await renderApps();

      const rows = Array.from(container.querySelectorAll("tbody tr"));
      const pausedRow = rows.find((tr) => tr.textContent?.includes("Legal Ops Agent"));
      const attentionRow = rows.find((tr) => tr.textContent?.includes("Sec Ops Agent"));
      expect(pausedRow).toBeTruthy();
      expect(attentionRow).toBeTruthy();
      // Pause and health hints are preserved on agent rows — agent identity
      // renders alongside them, never instead of them.
      expect(pausedRow?.textContent).toContain("General Counsel · ReClaw Comms Board");
      expect(pausedRow?.textContent).toContain("Paused — agents can’t use it right now.");
      expect(attentionRow?.textContent).toContain("Security Lead · ReClaw Comms Board");
      expect(attentionRow?.textContent).toContain("The key stopped working — reconnect to fix.");
      // The comms board agent ID itself renders on each row.
      expect(pausedRow?.textContent).toContain(pausedBoardId);
      expect(attentionRow?.textContent).toContain(attentionBoardId);
      // Attention semantics survive agent resolution: pill, amber highlight,
      // filter chip, and the honest Reconnect button.
      expect(attentionRow?.textContent).toContain("Needs attention");
      expect(attentionRow?.className).toContain("amber");
      expect(container.textContent).toContain("Needs attention (1)");
      expect(attentionRow?.querySelector("td:last-child button")?.textContent).toBe("Reconnect");
      // Connected By semantics are retained: the creating board member still
      // shows on an agent-dedicated row.
      expect(pausedRow?.textContent).toContain("Dotta");
    });

    it("resolves the name-encoded agent over a conflicting install (the name is authoritative)", async () => {
      const encodedAgentId = "be48f9ad-1234-4567-89ab-cdef01234574";
      const boardAgentId = "b13480a7-1234-4567-89ab-cdef01234567";
      const installAgentId = "cf59a0be-1234-4567-89ab-cdef01234575";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      // The name encodes one agent while the install row names another: the
      // server's dedicatedConnectionName subject wins over the consumer row.
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-conflict",
            applicationId: "app-comms",
            name: `rh-comms-board:${encodedAgentId}`,
            credentialPolicy: "per_agent",
            installs: [agentInstall("c-comms-conflict", installAgentId)],
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: encodedAgentId,
          name: "Encoded Agent",
          title: "Encoded Title",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  connectionId: "c-comms-conflict",
                  binding: { boardAgentId },
                },
              },
            },
          },
        }),
        mockAgent({ id: installAgentId, name: "Install Agent", title: "Install Title" }),
      ]);

      await renderApps();

      const text = container.textContent ?? "";
      expect(text).toContain("Encoded Agent");
      expect(text).toContain("Encoded Title · ReClaw Comms Board");
      const boardIdElem = container.querySelector(`code[aria-label="Comms board agent ID: ${boardAgentId}"]`);
      expect(boardIdElem).toBeTruthy();
      expect(boardIdElem?.textContent).toBe(boardAgentId);
      // The install row is a consumer, never the identity.
      expect(text).not.toContain("Install Agent");
      expect(text).not.toContain("Install Title");
      expect(container.querySelector(`button[title="${installAgentId}"]`)).toBeNull();
    });

    it("does not fall back to the installed agent when the name-encoded agent is missing", async () => {
      const installAgentId = "d06ab1cf-1234-4567-89ab-cdef01234576";
      const deletedAgentId = "e17bc2d0-1234-4567-89ab-cdef01234577";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-missing-install",
            applicationId: "app-comms",
            name: `rh-comms-board:${deletedAgentId}`,
            credentialPolicy: "per_agent",
            installs: [agentInstall("c-comms-missing-install", installAgentId)],
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({ id: installAgentId, name: "Install Fallback Agent", title: null }),
      ]);

      await renderApps();

      // The encoded subject is gone from the company: no install row may
      // substitute for it — the row keeps a non-agent identity.
      const text = container.textContent ?? "";
      expect(text).not.toContain("Install Fallback Agent");
      expect(container.querySelector(`button[title="${installAgentId}"]`)).toBeNull();
      expect(container.querySelector(`button[title="${deletedAgentId}"]`)).toBeNull();
      expect(text).toContain("ReClaw Comms Board");
    });

    it("resolves a generic prefix:<agentId> name and stays unresolved when the UUID is unknown", async () => {
      const genericAgentId = "f28cd3e1-1234-4567-89ab-cdef01234578";
      const installAgentId = "039de4f2-1234-4567-89ab-cdef01234579";
      const unknownAgentId = "14aee503-1234-4567-89ab-cdef01234580";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-jira", name: "Jira Boards" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-generic-known",
            applicationId: "app-jira",
            name: `jira-boards:${genericAgentId}`,
            credentialPolicy: "per_agent",
          }),
          connection({
            id: "c-generic-unknown",
            applicationId: "app-jira",
            name: `jira-boards:${unknownAgentId}`,
            credentialPolicy: "per_agent",
            installs: [agentInstall("c-generic-unknown", installAgentId)],
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({ id: genericAgentId, name: "Generic Name Agent", title: "Ops Lead" }),
        mockAgent({ id: installAgentId, name: "Install Fallback Agent", title: null }),
      ]);

      await renderApps();

      // A known UUID suffix resolves through the generic dedicated name …
      expect(container.textContent).toContain("Generic Name Agent");
      expect(container.querySelector("code")).toBeNull();
      // … but an unknown UUID suffix is terminal: the sole install cannot
      // substitute for the unresolved encoded subject.
      const text = container.textContent ?? "";
      expect(text).not.toContain("Install Fallback Agent");
      expect(container.querySelector(`button[title="${installAgentId}"]`)).toBeNull();
      expect(container.querySelector(`button[title="${unknownAgentId}"]`)).toBeNull();
    });

    it("resolves a sole agent install, and no agent when installs are ambiguous", async () => {
      const soleAgentId = "25bfa614-1234-4567-89ab-cdef01234581";
      const firstAmbiguousId = "36c0b725-1234-4567-89ab-cdef01234582";
      const secondAmbiguousId = "47d1c836-1234-4567-89ab-cdef01234583";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-linear", name: "Linear" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          // No name-encoded subject: exactly one agent install (the company
          // install does not count) is unambiguous …
          connection({
            id: "c-linear-sole",
            applicationId: "app-linear",
            name: "Linear",
            credentialPolicy: "per_agent",
            installs: [
              {
                id: "inst-company-linear",
                companyId: "company-1",
                connectionId: "c-linear-sole",
                targetType: "company",
                targetId: "company-1",
                createdByAgentId: null,
                createdByUserId: "user-1",
                createdAt: new Date("2026-01-01T00:00:00Z"),
              },
              agentInstall("c-linear-sole", soleAgentId),
            ],
          }),
          // … two agent installs are not — that row resolves no agent.
          connection({
            id: "c-linear-ambiguous",
            applicationId: "app-linear",
            name: "Linear Team",
            credentialPolicy: "per_agent",
            installs: [
              agentInstall("c-linear-ambiguous", firstAmbiguousId),
              agentInstall("c-linear-ambiguous", secondAmbiguousId),
            ],
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({ id: soleAgentId, name: "Sole Install Agent", title: "Ops" }),
        mockAgent({ id: firstAmbiguousId, name: "First Ambiguous Agent", title: null }),
        mockAgent({ id: secondAmbiguousId, name: "Second Ambiguous Agent", title: null }),
      ]);

      await renderApps();

      const text = container.textContent ?? "";
      // The sole agent install resolves to an agent identity …
      expect(text).toContain("Sole Install Agent");
      expect(container.querySelector("code")).toBeNull();
      // … while the ambiguous row keeps a non-agent identity.
      expect(text).not.toContain("First Ambiguous Agent");
      expect(text).not.toContain("Second Ambiguous Agent");
      expect(container.querySelector(`button[title="${firstAmbiguousId}"]`)).toBeNull();
      expect(container.querySelector(`button[title="${secondAmbiguousId}"]`)).toBeNull();
    });

    it("does not resolve the creating agent for a dedicated connection (creator is not an owner)", async () => {
      const creatorAgentId = "58e2d947-1234-4567-89ab-cdef01234584";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-linear", name: "Linear" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-linear-creator",
            applicationId: "app-linear",
            name: "Linear",
            credentialPolicy: "per_agent",
            createdByAgentId: creatorAgentId,
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({ id: creatorAgentId, name: "Creator Agent", title: "Made This" }),
      ]);

      await renderApps();

      // The creator wired the connection up; that does not make the
      // connection theirs, so no agent identity renders for the row.
      const text = container.textContent ?? "";
      expect(text).not.toContain("Creator Agent");
      expect(text).not.toContain("Made This");
      expect(container.querySelector(`button[title="${creatorAgentId}"]`)).toBeNull();
    });

    it("exposes the full agent UUID to keyboard and screen reader users", async () => {
      const agentId = "69f3ea58-1234-4567-89ab-cdef01234585";
      const boardAgentId = "c24591b8-1234-4567-89ab-cdef01234567";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-comms", name: "ReClaw Comms Board" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          connection({
            id: "c-comms-a11y",
            applicationId: "app-comms",
            name: `rh-comms-board:${agentId}`,
            credentialPolicy: "per_agent",
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: agentId,
          name: "A11y Agent",
          title: "Accessibility",
          metadata: {
            defaultMcp: {
              version: 1,
              entries: {
                "comms-board": {
                  key: "comms-board",
                  templateKey: "rh-comms-board",
                  dedicated: true,
                  connectionId: "c-comms-a11y",
                  binding: { boardAgentId },
                },
              },
            },
          },
        }),
      ]);

      await renderApps();

      const code = container.querySelector<HTMLElement>(
        `code[aria-label="Comms board agent ID: ${boardAgentId}"]`,
      );
      expect(code).toBeTruthy();
      expect(code?.textContent).toBe(boardAgentId);
      expect(code?.getAttribute("title")).toBe(`Comms board agent ID: ${boardAgentId}`);
      expect(code?.className).toContain("select-all");
      expect(code?.className).toContain("break-all");

      mockNavigate.mockClear();
      await act(async () => {
        code?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      // Clicking the code stops propagation and does not navigate
      expect(mockNavigate).not.toHaveBeenCalled();

      // Clicking the table row DOES navigate
      await act(async () => {
        container.querySelector("tbody tr")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(mockNavigate).toHaveBeenCalledWith("/apps/c-comms-a11y/permissions");
    });
  });

  describe("Arcana brain dedicated connections (TECH-7673)", () => {
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

    // The legitimate server-written arcana-brain binding shape
    // (default-mcp-setup.ts arcanaBrainHook): setup.state "ready",
    // binding.boardAgentId null, binding.baseSub carrying the Arcana agent
    // principal, and the dedicated connectionId on entry and binding.
    const arcanaMetadata = (connectionId: string) => ({
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
    const commsMetadata = (connectionId: string) => ({
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

    const arcanaConnectionRow = (over: Record<string, unknown> = {}) =>
      connection({
        id: ARCANA_CONN_ID,
        applicationId: "app-arcana",
        name: `rh-arcana-brain:${ORACLE_ID}`,
        credentialPolicy: "per_agent",
        healthStatus: "healthy",
        ...over,
      });
    const commsConnectionRow = () =>
      connection({
        id: COMMS_CONN_ID,
        applicationId: "app-comms-7673",
        name: `rh-comms-board:${ORACLE_ID}`,
        credentialPolicy: "per_agent",
        healthStatus: "healthy",
      });

    it("renders the exact full 42-char canonical brain ID with the agent name and title, never the internal UUID, board UUID, connection UUID, or JWT subject", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [
          application({ id: "app-arcana", name: "Arcana Brain" }),
        ],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [arcanaConnectionRow()],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: ORACLE_ID,
          name: "Oracle",
          title: "Chief Brain Officer",
          role: "general",
          metadata: arcanaMetadata(ARCANA_CONN_ID),
        }),
      ]);

      await renderApps();

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
      // Agent name and title subtitle are preserved next to the badge.
      const text = container.textContent ?? "";
      expect(text).toContain("Oracle brain");
      expect(text).toContain("Chief Brain Officer");
      expect(text).not.toContain("Chief Brain Officer · Arcana Brain");
      // No wrong-domain leak: the internal Paperclip agent UUID (full and
      // 8-char prefix), the dedicated connection UUID, and the board JWT
      // subject never appear.
      expect(text).not.toContain(ORACLE_ID);
      expect(text).not.toContain(ORACLE_ID.slice(0, 8));
      expect(text).not.toContain(ARCANA_CONN_ID);
      expect(text).not.toContain(`paperclip-agent-${ORACLE_ID}`);
      // The comms sibling's badge never renders for an Arcana connection.
      expect(
        container.querySelector(`code[aria-label="Comms board agent ID: ${BOARD_UUID}"]`),
      ).toBeNull();

      // Clicking the badge stops propagation and does not navigate; clicking
      // the table row DOES navigate to the connection's permissions.
      mockNavigate.mockClear();
      await act(async () => {
        badge?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(mockNavigate).not.toHaveBeenCalled();
      await act(async () => {
        badge?.closest("tr")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(mockNavigate).toHaveBeenCalledWith(`/apps/${ARCANA_CONN_ID}/permissions`);
    });

    it("keeps the full canonical brain ID intact when the agent name is very long (the name truncates first, the ID never)", async () => {
      const longName = `Oracle von Trapp-Schwarzenberg-Wellington-${"the-Unnecessarily-Hyphenated ".repeat(3)}III`;
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-arcana", name: "Arcana Brain" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [arcanaConnectionRow()],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: ORACLE_ID,
          name: longName,
          title: null,
          role: "general",
          metadata: arcanaMetadata(ARCANA_CONN_ID),
        }),
      ]);

      await renderApps();

      const badge = container.querySelector(
        `code[aria-label="Arcana brain ID: ${CANONICAL_BRAIN_ID}"]`,
      );
      expect(badge).toBeTruthy();
      // A long title truncates first; the canonical ID is never shortened.
      expect(badge?.textContent).toBe(CANONICAL_BRAIN_ID);
      expect(badge?.textContent).toHaveLength(42);
      const text = container.textContent ?? "";
      expect(text).toContain(longName);
      expect(text).not.toContain(ORACLE_ID);
    });

    it("hides the badge when metadata is missing or setup is not ready, and preserves name, subtitle, and permissions navigation", async () => {
      const PENDING_ID = "22222222-2222-4222-8222-222222222222";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-arcana", name: "Arcana Brain" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          arcanaConnectionRow(),
          arcanaConnectionRow({
            id: "55555555-5555-4555-8555-555555555556",
            name: `rh-arcana-brain:${PENDING_ID}`,
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        // No metadata at all (mockAgent default): no badge, identity intact.
        mockAgent({ id: ORACLE_ID, name: "No Meta Agent", title: "Head of Ops", role: "operations" }),
        // Setup pending with a VALID baseSub present: the principal exists,
        // but provisioning has not reached "ready" — the would-be principal
        // must not surface anywhere.
        mockAgent({
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
        }),
      ]);

      await renderApps();

      // No badge anywhere, and no internal-ID, principal, or connection-ID
      // fallback in its place.
      expect(container.querySelectorAll("code").length).toBe(0);
      const text = container.textContent ?? "";
      expect(text).not.toContain(CANONICAL_BRAIN_ID);
      expect(text).not.toContain(ARCANA_PRINCIPAL_ID);
      expect(text).not.toContain(ORACLE_ID);
      expect(text).not.toContain(ORACLE_ID.slice(0, 8));
      expect(text).not.toContain(PENDING_ID);
      expect(text).not.toContain("55555555-5555");
      // Row identity and subtitles are otherwise untouched.
      expect(text).toContain("No Meta Agent brain");
      expect(text).toContain("Head of Ops");
      expect(text).not.toContain("Head of Ops · Arcana Brain");
      expect(text).toContain("Pending Agent brain");
      expect(text).toContain("Provisioning Lead");
      expect(text).not.toContain("Provisioning Lead · Arcana Brain");
      // Permissions navigation is preserved on a setup-not-ready row.
      const pendingRow = Array.from(container.querySelectorAll("tr")).find((row) =>
        row.textContent?.includes("Pending Agent brain"),
      );
      expect(pendingRow).toBeTruthy();
      const manageButton = Array.from(pendingRow?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent?.trim() === "Permissions",
      );
      expect(manageButton).toBeTruthy();
      await act(async () => {
        manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      expect(mockNavigate).toHaveBeenCalledWith(
        "/apps/55555555-5555-4555-8555-555555555556/permissions",
      );
    });

    it("falls back to the role alone for whitespace-only and absent titles, keeping the Arcana subtitle connector-free (TECH-7710)", async () => {
      const WHITESPACE_TITLE_ID = "77777777-7777-4777-8777-777777777777";
      const NO_TITLE_ID = "88888888-8888-4888-8888-888888888888";
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-arcana", name: "Arcana Brain" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          arcanaConnectionRow({
            id: "55555555-5555-4555-8555-555555555559",
            name: `rh-arcana-brain:${WHITESPACE_TITLE_ID}`,
          }),
          arcanaConnectionRow({
            id: "55555555-5555-4555-8555-55555555555a",
            name: `rh-arcana-brain:${NO_TITLE_ID}`,
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        // A whitespace-only title falls back to the role in the subtitle and
        // contributes no parenthetical to the name tooltip.
        mockAgent({
          id: WHITESPACE_TITLE_ID,
          name: "Sage",
          title: "   ",
          role: "security",
          metadata: arcanaMetadata("55555555-5555-4555-8555-555555555559"),
        }),
        // An absent title does the same.
        mockAgent({
          id: NO_TITLE_ID,
          name: "Nova",
          title: null,
          role: "operations",
          metadata: arcanaMetadata("55555555-5555-4555-8555-55555555555a"),
        }),
      ]);

      await renderApps();

      // Display names keep the "<agent name> brain" form, and both badges
      // still render; the fallback is a subtitle concern, not a badge one.
      const sageSpan = container.querySelector('span[title="Sage brain"]');
      expect(sageSpan?.textContent).toBe("Sage brain");
      const novaSpan = container.querySelector('span[title="Nova brain"]');
      expect(novaSpan?.textContent).toBe("Nova brain");
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
      listApplicationsMock.mockResolvedValue({
        applications: [application({ id: "app-arcana", name: "Arcana Brain" })],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [
          // Agent resolves (the row shows "<agent name> brain") but the agent
          // carries no defaultMcp metadata at all: nothing authoritative.
          arcanaConnectionRow(),
          // Setup not ready: the principal exists (baseSub) but provisioning
          // has not reached "ready", so no badge and no copy control.
          arcanaConnectionRow({
            id: "55555555-5555-4555-8555-555555555556",
            name: `rh-arcana-brain:${PENDING_ID}`,
          }),
          // Authoritative metadata written for a different connection: the
          // entry/binding connectionId never matches this row's connection,
          // so the binding is not this row's to read or copy from.
          arcanaConnectionRow({
            id: "55555555-5555-4555-8555-555555555557",
            name: `rh-arcana-brain:${MISMATCH_ID}`,
          }),
        ],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({ id: ORACLE_ID, name: "No Meta Agent", title: "Head of Ops", role: "operations" }),
        mockAgent({
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
        }),
        mockAgent({
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
        }),
      ]);

      await renderApps();

      // No badge, and therefore no copy button and no copy status region.
      // The copy control only exists alongside a resolved authoritative
      // brain ID (it lives inside the badge).
      expect(container.querySelectorAll("code").length).toBe(0);
      expect(
        container.querySelector('button[aria-label^="Copy Arcana brain ID"]'),
      ).toBeNull();
      expect(container.querySelector('[role="status"]')).toBeNull();
      // The would-be principal never surfaces anywhere on the page.
      const text = container.textContent ?? "";
      expect(text).not.toContain(CANONICAL_BRAIN_ID);
      expect(text).not.toContain(ARCANA_PRINCIPAL_ID);
      // Row identity is otherwise intact on every row.
      expect(text).toContain("No Meta Agent brain");
      expect(text).toContain("Pending Agent brain");
      expect(text).toContain("Mismatch Agent brain");
    });

    it("renders the comms badge and the Arcana badge for the same agent's two dedicated connections, each on its own row with no cross-entry leak", async () => {
      listApplicationsMock.mockResolvedValue({
        applications: [
          application({ id: "app-comms-7673", name: "ReClaw Comms Board" }),
          application({ id: "app-arcana", name: "Arcana Brain" }),
        ],
      });
      listConnectionsMock.mockResolvedValue({
        connections: [commsConnectionRow(), arcanaConnectionRow()],
      });
      listAgentsMock.mockResolvedValue([
        mockAgent({
          id: ORACLE_ID,
          name: "Oracle",
          title: "Chief Brain Officer",
          role: "general",
          metadata: bothEntriesMetadata(COMMS_CONN_ID, ARCANA_CONN_ID),
        }),
      ]);

      await renderApps();

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
      const rows = Array.from(container.querySelectorAll("tbody tr"));
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
  });
});

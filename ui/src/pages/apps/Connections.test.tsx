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
        }),
      ]);

      await renderApps();

      const text = container.textContent ?? "";
      // Primary display name is agent.name
      expect(text).toContain("Legal Agent");
      // Visible short ID
      expect(text).toContain("1d37c752");
      // Secondary subtitle shows title and application name
      expect(text).toContain("General Counsel · ReClaw Comms Board");
      // Full ID accessible via title attribute
      const idSpan = container.querySelector(`span[title="${agentId}"]`);
      expect(idSpan).toBeTruthy();
      expect(idSpan?.textContent).toBe("1d37c752");
      // Explicitly NOT JWT subject
      expect(text).not.toContain(`paperclip-agent-${agentId}`);
    });

    it("falls back to role in secondary subtitle when agent title is absent", async () => {
      const agentId = "2b48e863-1234-4567-89ab-cdef01234567";
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
        }),
      ]);

      await renderApps();

      const text = container.textContent ?? "";
      expect(text).toContain("Security Bot");
      expect(text).toContain("2b48e863");
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
      // No agent short ID span rendered
      expect(container.querySelector(`span[title="${missingAgentId}"]`)).toBeNull();
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
      expect(container.querySelector(`span[title="${agentId}"]`)).toBeNull();

      await act(async () => {
        resolveAgents([mockAgent({ id: agentId, name: "Ops Agent", title: "Head of Ops" })]);
      });
      await flushReact();

      // Once the agents query resolves, the row upgrades to the agent
      // identity: name, short ID with the full ID accessible, title subtitle.
      const upgradedText = container.textContent ?? "";
      expect(upgradedText).toContain("Ops Agent");
      const idSpan = container.querySelector(`span[title="${agentId}"]`);
      expect(idSpan?.textContent).toBe(agentId.slice(0, 8));
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
      expect(container.querySelector(`span[title="${agentId}"]`)).toBeNull();
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
      const attentionAgentId = "0d26a7db-1234-4567-89ab-cdef01234572";
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
        mockAgent({ id: pausedAgentId, name: "Legal Ops Agent", title: "General Counsel" }),
        mockAgent({ id: attentionAgentId, name: "Sec Ops Agent", title: "Security Lead" }),
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
      // The agent identity itself still renders on each row.
      expect(pausedRow?.textContent).toContain(pausedAgentId.slice(0, 8));
      expect(attentionRow?.textContent).toContain(attentionAgentId.slice(0, 8));
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
  });
});

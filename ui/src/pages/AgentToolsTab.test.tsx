// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ToolCatalogEntry,
  ToolPolicy,
  ToolProfileEffectiveSummary,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { ApiError } from "../api/client";

const mockToolsApi = vi.hoisted(() => ({
  getEffectiveProfilesForAgent: vi.fn(),
  listConnections: vi.fn(),
  listPolicies: vi.fn(),
  listCatalog: vi.fn(),
  listConnectionGrants: vi.fn(),
  listAudit: vi.fn(),
  putConnectionInstalls: vi.fn(),
  startOAuth: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));
const mockPrepareOAuthNavigation = vi.hoisted(() => vi.fn());
const mockNavigateTopLevel = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("../api/tools", () => ({ toolsApi: mockToolsApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../lib/oauthHandoff", () => ({ prepareOAuthNavigation: mockPrepareOAuthNavigation }));
vi.mock("../lib/browserNavigation", () => ({ navigateTopLevel: mockNavigateTopLevel }));
// The Tools tab toasts through useOptionalToastActions; surface its calls while keeping
// every other ToastContext export real (the shape matches ToastActionsContextValue).
vi.mock("@/context/ToastContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/context/ToastContext")>()),
  useOptionalToastActions: () => ({
    pushToast: pushToastMock,
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
  }),
}));

// Render the company-aware Link as a plain anchor so we don't need a Router.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact(cycles = 4) {
  // Multiple cycles let dependent query waves settle (connections → per-connection catalog).
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function makeCatalogEntry(overrides: Partial<ToolCatalogEntry>): ToolCatalogEntry {
  return {
    id: "cat-1",
    companyId: "company-1",
    applicationId: "app-1",
    connectionId: "conn-1",
    entryKind: "tool",
    toolName: "github.read_repo",
    title: "Read repo",
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: "read",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    status: "active",
    addedAt: new Date("2026-06-01T00:00:00Z"),
    version: null,
    schemaHash: null,
    firstSeenAt: new Date("2026-06-01T00:00:00Z"),
    lastSeenAt: new Date("2026-06-01T00:00:00Z"),
    reviewedAt: null,
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makePolicy(overrides: Partial<ToolPolicy>): ToolPolicy {
  return {
    id: "pol-1",
    companyId: "company-1",
    name: "Require approval for writes",
    description: "All write tools need board approval",
    policyType: "require_approval",
    priority: 100,
    enabled: true,
    selectors: {},
    conditions: null,
    config: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("AgentToolsTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockToolsApi.getEffectiveProfilesForAgent.mockReset();
    mockToolsApi.listConnections.mockReset();
    mockToolsApi.listPolicies.mockReset();
    mockToolsApi.listCatalog.mockReset();
    mockToolsApi.listConnectionGrants.mockReset();
    mockToolsApi.putConnectionInstalls.mockReset();
    mockToolsApi.listConnectionGrants.mockResolvedValue({
      connection: { id: "conn-1", uid: "conn-1" },
      grants: [],
      currentUserId: "user-1",
      members: [],
      capabilities: {},
    });
    mockToolsApi.putConnectionInstalls.mockResolvedValue({ connectionId: "conn-1", installs: [] });
    mockToolsApi.startOAuth.mockReset();
    mockToolsApi.startOAuth.mockResolvedValue({ authorizationUrl: "https://mcp.example.test/authorize?state=xyz" });
    mockAuthApi.getSession.mockReset();
    mockAuthApi.getSession.mockResolvedValue(null);
    mockAccessApi.listUserDirectory.mockReset();
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockPrepareOAuthNavigation.mockReset();
    mockPrepareOAuthNavigation.mockImplementation(async (start: { authorizationUrl: string }) => ({
      kind: "authorization" as const,
      url: start.authorizationUrl,
      host: "mcp.example.test",
    }));
    mockNavigateTopLevel.mockReset();
    pushToastMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function renderTab(agentOverrides: Record<string, unknown> = {}) {
    const { AgentToolsTab } = await import("./AgentToolsTab");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const agent = { id: "agent-1", name: "Coder", ...agentOverrides } as never;
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(AgentToolsTab, { agent, companyId: "company-1" }),
        ),
      );
    });
    await flushReact();
  }

  it("preserves checkbox changes made after the last saved install state", async () => {
    const { mergeInstallDraft } = await import("./AgentToolsTab");

    expect(
      mergeInstallDraft(
        { "conn-1": true, "conn-2": false },
        { "conn-1": true, "conn-2": true },
        { "conn-1": false, "conn-2": false },
      ),
    ).toEqual({
      draft: { "conn-1": true, "conn-2": true },
      hasPendingChanges: true,
    });
  });

  it("renders effective access, access profiles, governing policy, and unavailable tools", async () => {
    const allowed = makeCatalogEntry({ id: "cat-allow", toolName: "github.read_repo" });
    const denied = makeCatalogEntry({
      id: "cat-deny",
      toolName: "github.delete_repo",
      riskLevel: "critical",
      isReadOnly: false,
      isWrite: true,
      isDestructive: true,
    });

    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [
        {
          id: "prof-1",
          companyId: "company-1",
          profileKey: "github-safe",
          name: "GitHub safe",
          description: null,
          status: "active",
          defaultAction: "deny",
          newToolsReviewedAt: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          entries: [],
          bindings: [],
          summary: {
            accessMode: "selected",
            allowedToolCount: 1,
            allowedApplicationCount: 1,
            excludedToolCount: 0,
            totalToolCount: 1,
            assignmentCount: 1,
            appliesToAgentCount: 1,
            isCompanyDefault: true,
          },
        },
      ],
      entries: [],
      bindings: [
        {
          id: "bind-1",
          companyId: "company-1",
          profileId: "prof-1",
          targetType: "agent",
          targetId: "agent-1",
          priority: 100,
          metadata: null,
          createdByAgentId: null,
          createdByUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      allowedTools: [allowed],
      allowedToolNames: ["github.read_repo"],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);

    mockToolsApi.listConnections.mockResolvedValue({
      connections: [{ id: "conn-1", name: "Production GitHub" }],
    });
    mockToolsApi.listPolicies.mockResolvedValue({
      policies: [
        makePolicy({ id: "pol-1", name: "Require approval for writes" }),
        makePolicy({
          id: "pol-2",
          name: "Block other agent",
          enabled: true,
          selectors: { agentId: "someone-else" },
        }),
      ],
    });
    mockToolsApi.listCatalog.mockResolvedValue({ catalog: [allowed, denied] });

    await renderTab();

    const text = container.textContent ?? "";
    expect(text).toContain("Effective access");
    expect(text).toContain("github.read_repo");
    expect(text).toContain("Production GitHub");
    expect(text).toContain("GitHub safe");
    expect(text).toContain("Access profiles");
    expect(text).toContain("Organization default");
    expect(container.querySelector('a[href="/apps/advanced/profiles/prof-1"]')?.textContent).toBe("GitHub safe");
    expect(container.querySelector('a[href="/apps/advanced/profiles?check=1"]')?.textContent).toBe("Check access");
    // Governing policy #1 is the company-wide require_approval rule.
    expect(text).toContain("#1 Require approval for writes");
    // The policy that targets a different agent must NOT appear.
    expect(text).not.toContain("Block other agent");
    // Unavailable tool surfaced from the full tool list minus allowed.
    expect(text).toContain("github.delete_repo");
  });

  it("shows the empty allow-list message when no profile applies", async () => {
    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [],
      entries: [],
      bindings: [],
      allowedTools: [],
      allowedToolNames: [],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);
    mockToolsApi.listConnections.mockResolvedValue({ connections: [] });
    mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });

    await renderTab();

    const text = container.textContent ?? "";
    expect(text).toContain("No tools are allowed for this agent");
    expect(text).toContain("No active profile applies");
    expect(text).toContain("Use responsible person's GitHub");
    expect(container.querySelector('a[href="/apps/connect?source=github"]')?.textContent).toBe("Connect my GitHub");
  });

  it("shows an active dedicated GitHub identity as the agent override", async () => {
    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [],
      entries: [],
      bindings: [],
      allowedTools: [],
      allowedToolNames: [],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);
    mockToolsApi.listConnections.mockResolvedValue({
      connections: [{
        id: "conn-github",
        companyId: "company-1",
        name: "Agent GitHub",
        enabled: true,
        status: "active",
        config: { sourceTemplateKey: "github" },
        transportConfig: {},
        installs: [{ targetType: "company", targetId: "company-1" }],
      }],
    });
    mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
    mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
    mockToolsApi.listConnectionGrants.mockResolvedValue({
      connection: { id: "conn-github", uid: "conn-github" },
      grants: [{
        id: "grant-agent",
        kind: "agent",
        subjectAgentId: "agent-1",
        subjectUserId: null,
        status: "active",
        providerTenant: {
          github: {
            userId: "123",
            login: "dottabot",
            installationCount: 1,
            repositoryCount: 1,
            repositorySelection: "selected",
            installationIds: ["456"],
            installationOwnerLogins: ["paperclipai"],
          },
        },
      }],
      currentUserId: "user-1",
      members: [],
      capabilities: {},
    });

    await renderTab();

    const text = container.textContent ?? "";
    expect(text).toContain("@dottabot");
    expect(text).toContain("takes precedence over the responsible person's GitHub");
    expect(container.querySelector('a[href="/apps/conn-github/permissions"]')?.textContent).toBe("Manage GitHub identity");
    expect(text).not.toContain("Connect my GitHub");
  });

  it("does not display a grant from a disabled or uninstalled GitHub connection", async () => {
    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [],
      entries: [],
      bindings: [],
      allowedTools: [],
      allowedToolNames: [],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);
    mockToolsApi.listConnections.mockResolvedValue({
      connections: [{
        id: "conn-github",
        companyId: "company-1",
        name: "Disabled GitHub",
        enabled: false,
        status: "active",
        config: { sourceTemplateKey: "github" },
        transportConfig: {},
        installs: [{ targetType: "company", targetId: "company-1" }],
      }],
    });
    mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
    mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });

    await renderTab();

    const text = container.textContent ?? "";
    expect(mockToolsApi.listConnectionGrants).not.toHaveBeenCalled();
    expect(text).toContain("Use responsible person's GitHub");
    expect(text).not.toContain("@dottabot");
  });

  it("shows a retryable error instead of connection setup when grants cannot be loaded", async () => {
    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [],
      entries: [],
      bindings: [],
      allowedTools: [],
      allowedToolNames: [],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);
    mockToolsApi.listConnections.mockResolvedValue({
      connections: [{
        id: "conn-github",
        companyId: "company-1",
        name: "Agent GitHub",
        enabled: true,
        status: "active",
        config: { sourceTemplateKey: "github" },
        transportConfig: {},
        installs: [{ targetType: "company", targetId: "company-1" }],
      }],
    });
    mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
    mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
    mockToolsApi.listConnectionGrants.mockRejectedValue(new Error("temporary failure"));

    await renderTab();

    const text = container.textContent ?? "";
    expect(text).toContain("Could not load GitHub identity");
    expect(text).toContain("Your existing setup was not changed");
    expect(text).not.toContain("Connect my GitHub");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Retry")).toBe(true);
  });

  it("autosaves installed apps for the current agent", async () => {
    const allowed = makeCatalogEntry({ id: "cat-allow", toolName: "github.read_repo" });
    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [],
      entries: [],
      bindings: [],
      allowedTools: [allowed],
      allowedToolNames: ["github.read_repo"],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);
    mockToolsApi.listConnections.mockResolvedValue({
      connections: [{ id: "conn-1", companyId: "company-1", name: "Production GitHub", installs: [] }],
    });
    mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
    mockToolsApi.listCatalog.mockResolvedValue({ catalog: [allowed] });

    await renderTab();

    expect(container.textContent).toContain("Installed apps");
    expect(container.textContent).toContain("Permitted only");
    expect(container.textContent).toContain("Permitted but not installed — tools will not appear in runs.");
    expect(container.querySelector('a[href="/apps/conn-1/permissions"]')?.textContent).toBe("Open permissions");
    const installCheckbox = container.querySelector<HTMLElement>('[aria-label="Install Production GitHub on Coder"]');
    expect(installCheckbox).toBeTruthy();
    await act(async () => {
      installCheckbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
    await flushReact();

    expect(mockToolsApi.putConnectionInstalls).toHaveBeenCalledWith("conn-1", [
      { targetType: "agent", targetId: "agent-1" },
    ]);
  });

  describe("default MCP apps (managed by server-written agent metadata)", () => {
    const entry = (over: Record<string, unknown>) => ({ connectionId: null, templateConnectionId: null, templateKey: null, dedicated: false, setup: { state: "ready", reason: null }, ...over });
    const connection = (id: string, name: string, installs: unknown[] = []) => ({ id, companyId: "company-1", name, status: "active", installs });
    const emptyEffective = (extra: Partial<ToolProfileEffectiveSummary> = {}) => ({
      agentId: "agent-1", profiles: [], entries: [], bindings: [], allowedTools: [], allowedToolNames: [], installedConnections: [], ...extra,
    }) satisfies ToolProfileEffectiveSummary;
    const rowFor = (label: string) => container.querySelector<HTMLElement>(`[aria-label="Install ${label} on Coder"]`);

    it("lists the agent's own default apps OFF (unchecked) even when no profile permits them, and hides the provisioning-only template and another agent's dedicated connection", async () => {
      const metadata = { defaultMcp: { version: 1, entries: {
        comms: entry({ key: "comms", templateKey: "rh-comms-board", dedicated: true, templateConnectionId: "t-comms", connectionId: "d-own" }),
        google: entry({ key: "google", templateKey: "rh-google-mcp", templateConnectionId: "g-1", connectionId: "g-1" }),
      } } };
      // The org installed the comms template company-wide and a company profile permits it: still not offered.
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective({
        entries: [{ id: "e1", profileId: "p1", effect: "include", selectorType: "connection", connectionId: "t-comms" }] as never,
      }));
      mockToolsApi.listConnections.mockResolvedValue({ connections: [
        connection("t-comms", "rh-comms-board", [{ targetType: "company", targetId: "company-1" }]),
        connection("d-own", "rh-comms-board:agent-1"),
        connection("d-other", "rh-comms-board:agent-2"),
        connection("g-1", "rh-google-mcp", [{ targetType: "company", targetId: "company-1" }]),
        connection("plain", "Plain company app"),
      ] });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });

      await renderTab({ companyId: "company-1", metadata });

      for (const label of ["rh-comms-board:agent-1", "rh-google-mcp"]) {
        const checkbox = rowFor(label);
        expect(checkbox, label).toBeTruthy();
        expect(checkbox!.getAttribute("data-state")).toBe("unchecked"); // OFF, and a company-wide install does not tick it
        expect((checkbox as HTMLButtonElement).disabled).toBe(false); // the normal control stays usable
      }
      expect(rowFor("rh-comms-board")).toBeNull(); // the org template is provisioning-only
      expect(rowFor("rh-comms-board:agent-2")).toBeNull(); // another agent's dedicated connection
      expect(rowFor("Plain company app")).toBeNull(); // unrelated and unpermitted: unchanged behaviour
      expect(container.textContent).not.toContain("Installed for all");
    });

    it.each([
      ["owner_required", "Being set up for this agent (owner required)"],
      ["provisioner_config_invalid", "Being set up for this agent (provisioner config invalid)"],
    ])("shows a dedicated entry that is still being set up as a disabled pending row with reason %s", async (reason, expectedText) => {
      const metadata = { defaultMcp: { version: 1, entries: {
        comms: entry({ key: "comms", templateKey: "rh-comms-board", dedicated: true, templateConnectionId: "t-comms", connectionId: null, setup: { state: "pending", reason } }),
      } } };
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({ connections: [connection("t-comms", "rh-comms-board", [{ targetType: "company", targetId: "company-1" }])] });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });

      await renderTab({ companyId: "company-1", metadata });

      const pending = rowFor("rh-comms-board");
      expect(pending).toBeTruthy();
      expect((pending as HTMLButtonElement).disabled).toBe(true);
      expect(pending!.getAttribute("data-state")).toBe("unchecked");
      expect(container.textContent).toContain(expectedText);
      expect(mockToolsApi.putConnectionInstalls).not.toHaveBeenCalled();
    });

    it("the normal checkbox installs only the agent's own connection and keeps an unrelated company install row intact", async () => {
      const metadata = { defaultMcp: { version: 1, entries: {
        google: entry({ key: "google", templateKey: "rh-google-mcp", templateConnectionId: "g-1", connectionId: "g-1" }),
      } } };
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({ connections: [connection("g-1", "rh-google-mcp", [{ targetType: "company", targetId: "company-1" }])] });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });

      await renderTab({ companyId: "company-1", metadata });
      await act(async () => {
        rowFor("rh-google-mcp")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      });
      await flushReact();

      expect(mockToolsApi.putConnectionInstalls).toHaveBeenCalledWith("g-1", [
        { targetType: "company", targetId: "company-1" },
        { targetType: "agent", targetId: "agent-1" },
      ]);
    });

    // ---- TECH-7340: discovery-only seeds and strict personal instances ----

    const seedConnection = {
      id: "seed-google",
      companyId: "company-1",
      applicationId: "app-google",
      name: "RH Google MCP",
      uid: "rh-google-mcp/default-mcp-seed",
      status: "draft",
      enabled: false,
      createdByUserId: null,
      config: { defaultMcpManaged: "seed", paperclipDefaultMcpEntry: "rh-google-mcp" },
      installs: [],
    };
    const personalInstance = (over: Record<string, unknown> = {}) => ({
      id: "pi-1",
      companyId: "company-1",
      applicationId: "app-google",
      name: "RH Google MCP",
      uid: "rh-google-mcp/default-mcp-personal/user-a",
      status: "active",
      createdByUserId: "user-a",
      config: { defaultMcpManaged: "personal", paperclipDefaultMcpEntry: "rh-google-mcp", identityModel: "personal_only" },
      installs: [],
      ...over,
    });
    const seedMetadata = (googleConnectionId: string | null) => ({
      defaultMcp: { version: 1, entries: {
        google: entry({ key: "rh-google-mcp", templateKey: "rh-google-mcp", templateConnectionId: googleConnectionId, connectionId: googleConnectionId, setup: { state: "not_required", reason: null } }),
      } },
    });
    const connectButton = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Connect your account RH Google MCP"]');

    it("offers one Connect-your-account row per seed entry and starts OAuth as the current user (no URL paste surface)", async () => {
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({
        connections: [seedConnection, personalInstance({ id: "pi-a" })],
      });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-b" } });
      mockAccessApi.listUserDirectory.mockResolvedValue({
        users: [{ principalId: "user-a", status: "active", user: { name: "Alice Member" } }],
      });

      await renderTab({ companyId: "company-1", metadata: seedMetadata(null) });

      // One LOGICAL Connect row for the entry (not one per human's instance). The row is
      // labeled with the app's display name (S21), never the technical entry key.
      expect(container.querySelectorAll('[aria-label="Connect your account RH Google MCP"]')).toHaveLength(1);
      // The pending ghost is hidden behind the valid seed, and there is no URL input to paste into.
      expect(container.textContent).not.toContain("Not available yet");
      expect(container.querySelector("input:not([type=checkbox]), textarea")).toBeNull();
      const button = connectButton();
      expect(button).toBeTruthy();
      expect(button!.textContent).toContain("Connect your account");

      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      await flushReact();

      // The click asks the server to start OAuth as the signed-in user on the SEED id,
      // and navigates to the server-resolved authorization URL (never a pasted one).
      expect(mockToolsApi.startOAuth).toHaveBeenCalledWith("seed-google", { asCurrentUser: true });
      expect(mockPrepareOAuthNavigation).toHaveBeenCalledWith({ authorizationUrl: "https://mcp.example.test/authorize?state=xyz" });
      expect(mockNavigateTopLevel).toHaveBeenCalledWith("https://mcp.example.test/authorize?state=xyz");
    });

    it("two humans: another member's installed instance is read-only-labeled and removable; my own Connect row still appears", async () => {
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({
        connections: [
          seedConnection,
          // Alice's instance IS installed on this agent: visible to Bob, checked, labeled.
          personalInstance({ id: "pi-a", installs: [{ targetType: "agent", targetId: "agent-1" }] }),
          // Alice's second, uninstalled instance: hidden from Bob entirely.
          personalInstance({ id: "pi-a2", uid: "rh-google-mcp/default-mcp-personal/user-a-2" }),
        ],
      });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-b" } });
      mockAccessApi.listUserDirectory.mockResolvedValue({
        users: [{ principalId: "user-a", status: "active", user: { name: "Alice Member" } }],
      });

      await renderTab({ companyId: "company-1", metadata: seedMetadata("pi-a") });

      // Bob's own Connect-your-account row is NOT blocked by Alice's existing instance.
      expect(connectButton()).toBeTruthy();
      // Alice's installed instance row: checked, attributed, and usable only to remove.
      const otherOwnerRow = container.querySelector<HTMLElement>('[aria-label="Install RH Google MCP on Coder"]');
      expect(otherOwnerRow).toBeTruthy();
      expect(otherOwnerRow!.getAttribute("data-state")).toBe("checked");
      expect(container.textContent).toContain("Connected by Alice Member");
      expect(container.textContent).not.toContain("Connected by user-a");
      // Alice's uninstalled duplicate instance row is hidden from Bob.
      expect(container.querySelectorAll('[aria-label="Install RH Google MCP on Coder"]')).toHaveLength(1);
    });

    it("my own active instance renders its live checkbox from the actual install state (OFF, not auto-checked)", async () => {
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({
        connections: [
          seedConnection,
          personalInstance({ id: "pi-b", uid: "rh-google-mcp/default-mcp-personal/user-b", createdByUserId: "user-b", installs: [] }),
        ],
      });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-b" } });
      mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });

      await renderTab({ companyId: "company-1", metadata: seedMetadata("pi-b") });

      // My active instance is offered with its checkbox OFF: nothing is installed yet.
      const ownRow = container.querySelector<HTMLElement>('[aria-label="Install RH Google MCP on Coder"]');
      expect(ownRow).toBeTruthy();
      expect(ownRow!.getAttribute("data-state")).toBe("unchecked");
      expect((ownRow as HTMLButtonElement).disabled).toBe(false);
      // No Connect-your-account row for me: I already have my own active instance.
      expect(connectButton()).toBeNull();
    });

    it("an unowned personal instance row is disabled and unchecked even for a resolved session, and can never be switched on", async () => {
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({
        connections: [
          seedConnection,
          // A personal instance with NO owner recorded: not "mine" for any resolved session
          // user, and not server-installed, so its row fails closed.
          personalInstance({ id: "pi-x", createdByUserId: null, installs: [] }),
        ],
      });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-b" } });
      mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });

      await renderTab({ companyId: "company-1", metadata: seedMetadata("pi-x") });

      const row = container.querySelector<HTMLElement>('[aria-label="Install RH Google MCP on Coder"]');
      expect(row).toBeTruthy();
      expect(row!.getAttribute("data-state")).toBe("unchecked");
      expect((row as HTMLButtonElement).disabled).toBe(true);
      expect(mockToolsApi.putConnectionInstalls).not.toHaveBeenCalled();
    });

    it("the pending ghost reappears for a wrong-tag seed or a manual same-name connection; a valid seed hides it", async () => {
      const cases: Array<[string, unknown[]]> = [
        ["wrong-tag seed", [{ ...seedConnection, id: "seed-wrong", config: { defaultMcpManaged: "seed", paperclipDefaultMcpEntry: "rh-mcp" } }]],
        ["manual same-name connection", [{ id: "manual-1", companyId: "company-1", name: "RH Google MCP", status: "active", installs: [] }]],
      ];
      for (const [label, connections] of cases) {
        mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
        mockToolsApi.listConnections.mockResolvedValue({ connections });
        mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
        mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
        mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-b" } });
        mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });

        await renderTab({ companyId: "company-1", metadata: seedMetadata(null) });
        expect(container.textContent, label).toContain("Not available yet: your organization has not set this app up.");
        await act(async () => {
          root?.unmount();
        });
      }
    });

    it("an unresolved session offers no fake own Connect row and never mutates the personal instance", async () => {
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({
        connections: [
          seedConnection,
          // A personal instance the SERVER still has installed on this agent; its owner
          // cannot be verified until the session identity resolves.
          personalInstance({ id: "pi-a", installs: [{ targetType: "agent", targetId: "agent-1" }] }),
        ],
      });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
      mockAuthApi.getSession.mockResolvedValue(null);
      mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });

      await renderTab({ companyId: "company-1", metadata: seedMetadata("pi-a") });

      // No Connect-your-account prompt: without a session there is no way to tell
      // whether the viewer already has an instance (it would be a false prompt).
      expect(connectButton()).toBeNull();
      // The installed instance row stays visible from the real server install state...
      const row = container.querySelector<HTMLElement>('[aria-label="Install RH Google MCP on Coder"]');
      expect(row).toBeTruthy();
      expect(row!.getAttribute("data-state")).toBe("checked");
      // ...but it can never be mutated while ownership is unverified.
      expect((row as HTMLButtonElement).disabled).toBe(true);
      expect(mockToolsApi.putConnectionInstalls).not.toHaveBeenCalled();
    });

    it("a rejected OAuth start shows a sanitized toast, never navigates, blocks duplicate clicks while pending, and allows retry", async () => {
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({ connections: [seedConnection] });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-b" } });
      mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
      // A controllable pending start: held until the test releases it.
      let rejectStart!: (reason?: unknown) => void;
      let resolveStart!: (value: { authorizationUrl: string }) => void;
      mockToolsApi.startOAuth.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            resolveStart = resolve;
            rejectStart = reject;
          }),
      );

      await renderTab({ companyId: "company-1", metadata: seedMetadata(null) });

      const button = connectButton();
      expect(button).toBeTruthy();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      // While the start is pending, a duplicate click is blocked: exactly one call.
      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(mockToolsApi.startOAuth).toHaveBeenCalledTimes(1);
      expect(connectButton()!.textContent).toContain("Connecting…");

      // The rejection surfaces only the sanitized, fixed-status toast text.
      const secretError = new ApiError("upstream rejected sk-live-SECRETsentinel77", 503, {
        error: "sk-live-SECRETsentinel77",
      });
      await act(async () => {
        rejectStart(secretError);
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      await flushReact();
      expect(pushToastMock).toHaveBeenCalledTimes(1);
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not start sign in", tone: "error" }),
      );
      const toastBody = (pushToastMock.mock.calls[0]![0] as { body?: string }).body;
      expect(toastBody).toBe("Paperclip couldn't start sign in. Please try again.");
      expect(toastBody).not.toContain("sk-live-SECRETsentinel77");
      // Navigation never happens, and the pending state reset unblocks the row.
      expect(mockPrepareOAuthNavigation).not.toHaveBeenCalled();
      expect(mockNavigateTopLevel).not.toHaveBeenCalled();
      expect(connectButton()!.textContent).toContain("Connect your account");

      // A retry goes through and completes the safe navigation.
      mockToolsApi.startOAuth.mockResolvedValue({ authorizationUrl: "https://mcp.example.test/authorize?state=retry" });
      await act(async () => {
        connectButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      await flushReact();
      expect(mockToolsApi.startOAuth).toHaveBeenCalledTimes(2);
      expect(mockPrepareOAuthNavigation).toHaveBeenCalledWith({ authorizationUrl: "https://mcp.example.test/authorize?state=retry" });
      expect(mockNavigateTopLevel).toHaveBeenCalledWith("https://mcp.example.test/authorize?state=retry");
    });

    it("a rejected handoff preparation shows the sanitized toast and never navigates", async () => {
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      mockToolsApi.listConnections.mockResolvedValue({ connections: [seedConnection] });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-b" } });
      mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
      mockToolsApi.startOAuth.mockResolvedValue({ authorizationUrl: "https://mcp.example.test/authorize?state=xyz" });
      // The handoff navigation itself rejects (the URL never passes the safety gate).
      mockPrepareOAuthNavigation.mockReset();
      mockPrepareOAuthNavigation.mockRejectedValue(
        new Error("blocked https://mcp.example.test/authorize?token=secret-token-value"),
      );

      await renderTab({ companyId: "company-1", metadata: seedMetadata(null) });

      await act(async () => {
        connectButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      await flushReact();

      expect(mockToolsApi.startOAuth).toHaveBeenCalledWith("seed-google", { asCurrentUser: true });
      expect(mockNavigateTopLevel).not.toHaveBeenCalled();
      expect(pushToastMock).toHaveBeenCalledTimes(1);
      const toastBody = (pushToastMock.mock.calls[0]![0] as { body?: string }).body;
      expect(toastBody).toBe("Couldn't start sign in. Please try again.");
      expect(toastBody).not.toContain("secret-token-value");
      expect(toastBody).not.toContain("https://mcp.example.test");
      // The reset allows another attempt instead of sticking on "Connecting…".
      expect(connectButton()!.textContent).toContain("Connect your account");
    });

    it("a failed removal of a server-installed peer instance restores the server ON state and keeps the row recoverable", async () => {
      mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue(emptyEffective());
      // Alice's personal instance, INSTALLED on this agent by the server.
      const installedInstance = personalInstance({
        id: "pi-a",
        uid: "rh-google-mcp/default-mcp-personal/user-a",
        createdByUserId: "user-a",
        installs: [{ targetType: "agent", targetId: "agent-1" }],
      });
      mockToolsApi.listConnections.mockResolvedValue({ connections: [seedConnection, installedInstance] });
      mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
      mockToolsApi.listCatalog.mockResolvedValue({ catalog: [] });
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-b" } });
      mockAccessApi.listUserDirectory.mockResolvedValue({
        users: [{ principalId: "user-a", status: "active", user: { name: "Alice Member" } }],
      });

      await renderTab({ companyId: "company-1", metadata: seedMetadata("pi-a") });

      const row = container.querySelector<HTMLElement>('[aria-label="Install RH Google MCP on Coder"]');
      expect(row).toBeTruthy();
      expect(row!.getAttribute("data-state")).toBe("checked"); // the server has it ON

      // Bob tries to remove Alice's instance; the server rejects the save.
      mockToolsApi.putConnectionInstalls.mockReset();
      mockToolsApi.putConnectionInstalls.mockRejectedValue(new Error("temporary failure"));
      await act(async () => {
        row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      });
      await flushReact();

      expect(mockToolsApi.putConnectionInstalls).toHaveBeenCalledWith("pi-a", []);
      // The row stays visible and the draft/lastSaved restore the authoritative
      // server ON state, so the UI never claims OFF while the backend is ON.
      const restored = container.querySelector<HTMLElement>('[aria-label="Install RH Google MCP on Coder"]');
      expect(restored).toBeTruthy();
      expect(restored!.getAttribute("data-state")).toBe("checked");
      expect((restored as HTMLButtonElement).disabled).toBe(false); // recoverable: the row can be retried
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't update the connection", tone: "error" }),
      );

      // The retried removal succeeds server-side: the refetched server state now
      // reports the instance uninstalled, and a newly uninstalled foreign instance
      // is never offered (let alone enabled) again.
      let removed = false;
      mockToolsApi.putConnectionInstalls.mockReset();
      mockToolsApi.putConnectionInstalls.mockImplementation(async () => {
        removed = true;
        return { connectionId: "pi-a", installs: [] };
      });
      mockToolsApi.listConnections.mockReset();
      mockToolsApi.listConnections.mockImplementation(async () => ({
        connections: [
          seedConnection,
          personalInstance({
            id: "pi-a",
            uid: "rh-google-mcp/default-mcp-personal/user-a",
            createdByUserId: "user-a",
            installs: removed ? [] : [{ targetType: "agent", targetId: "agent-1" }],
          }),
        ],
      }));
      await act(async () => {
        restored!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      });
      await flushReact();
      await flushReact();

      expect(
        container.querySelector<HTMLElement>('[aria-label="Install RH Google MCP on Coder"]'),
      ).toBeNull();
      // Bob's own Connect-your-account row legitimately reappears for the seed.
      expect(connectButton()).toBeTruthy();
    });
  });
});

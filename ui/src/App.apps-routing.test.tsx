// @vitest-environment jsdom

// Regression guard for TECH-7592: the apps landing route must mount the real
// <Browse> surface — the single connector catalog whose account rows carry
// dedicated-agent identity, including the full comms-board agent UUID
// rendered inline — and the retired /apps/browse and /apps/connections URLs
// must keep redirecting to it. App.test.tsx pins the same facts as a static
// source contract; this drives the real <App> route table so a future
// route-table edit that drops or shadows the Browse route fails on
// behavior, not just on source text.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const streamlinedUiState = vi.hoisted(() => ({ enabled: true, loaded: true }));

vi.mock("./hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => streamlinedUiState,
}));

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
// (sandpack itself is never exercised by the routing under test.)
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papAppsRoutingPatched?: boolean;
  };
  if (!sheetProto.__papAppsRoutingPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap-apps-routing-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papAppsRoutingPatched = true;
  }
});

// Real Layout renders the full authenticated shell (sidebar, data queries) and
// owns the "No company matches prefix" NotFound. For routing we only need it to
// resolve the :companyPrefix segment and render its nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/Layout.production", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

// Rendered by <App> outside <Routes> and needs DialogProvider; irrelevant here.
vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

// Cloud access is unrelated to the route-table regression. Let it fall through
// synchronously so this test does not poll its query transitions.
vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

// The prefix resolver + redirect logic both read the active company.
const PAP_COMPANY = {
  id: "company-1",
  name: "Paperclip",
  issuePrefix: "PAP",
  status: "active",
};
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Browse's landing surface is rendered for real (not a sentinel page), so its
// own data queries need hermetic mocks. Minimal fixtures: one custom
// comms-board application with one resolvable dedicated connection.
const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const getExperimentalMock = vi.hoisted(() => vi.fn());
const chatListMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
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

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: () => getExperimentalMock() },
}));

vi.mock("@/api/chatEndpoints", () => ({
  chatEndpointsApi: {
    list: (companyId: string) => chatListMock(companyId),
  },
}));

// The breadcrumb and toast providers live in the real Layout shell this routing
// harness stubs out, but Browse still calls their hooks.
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

const HERMES_ID = "1d37c752-ef9d-4185-bfd5-3249898f6bc2";
// The comms-board registered agent UUID from Hermes's defaultMcp binding —
// deliberately distinct from HERMES_ID (Paperclip internal agent UUID),
// the connection id ("conn-hermes"), and the board JWT subject
// ("paperclip-agent-<HERMES_ID>"), so a wrong-domain render cannot pass.
const HERMES_BOARD_AGENT_ID = "b1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

// TECH-7673 fixtures — the same pairwise-distinct identity-domain scheme the
// unit and page tests use: the internal Paperclip agent UUID (111…), the
// Arcana principal UUID (333…, stored in binding.baseSub), its canonical
// brain ID form (agent:333…, 42 chars), the comms-board agent UUID domain
// (444…, unused here — Arcana's binding.boardAgentId is null), and the
// dedicated Arcana connection UUID (555…).
const ORACLE_ID = "11111111-1111-4111-8111-111111111111";
const ARCANA_PRINCIPAL_ID = "33333333-3333-5333-8333-333333333333";
const ARCANA_BRAIN_ID = `agent:${ARCANA_PRINCIPAL_ID}`;
const ARCANA_CONN_ID = "55555555-5555-4555-8555-555555555555";

function commsBoardApplication() {
  return {
    id: "app-comms-board",
    name: "rh-comms-board",
    description: "Comms board tools.",
    status: "active",
    applicationKey: "custom:comms-board",
    metadata: {},
  };
}

function dedicatedCommsConnection() {
  return {
    id: "conn-hermes",
    applicationId: "app-comms-board",
    name: `rh-comms-board:${HERMES_ID}`,
    status: "active",
    enabled: true,
    authKind: "api_key",
    healthStatus: "ok",
    healthMessage: null,
    lastError: null,
    createdByUserId: null,
    credentialPolicy: "per_agent",
    config: {},
    transportConfig: {},
  };
}

// The legitimate server-written comms-board binding (entries["comms-board"]
// with key/templateKey and a UUID boardAgentId) for the dedicated connection
// above: what makes the board ID render on the routed landing.
function hermesAgent() {
  return {
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
  };
}

function arcanaBrainApplication() {
  return {
    id: "app-arcana-brain",
    name: "Arcana Brain",
    description: "Arcana brain tools.",
    status: "active",
    applicationKey: "custom:arcana-brain",
    metadata: {},
  };
}

function dedicatedArcanaConnection() {
  return {
    id: ARCANA_CONN_ID,
    applicationId: "app-arcana-brain",
    name: `rh-arcana-brain:${ORACLE_ID}`,
    status: "active",
    enabled: true,
    authKind: "api_key",
    healthStatus: "ok",
    healthMessage: null,
    lastError: null,
    createdByUserId: null,
    credentialPolicy: "per_agent",
    config: {},
    transportConfig: {},
  };
}

// The legitimate server-written arcana-brain binding (default-mcp-setup.ts
// arcanaBrainHook): setup.state "ready" (the hook's terminal state),
// binding.boardAgentId null (the board-UUID domain does not apply to Arcana),
// and binding.baseSub carrying the Arcana agent principal whose canonical
// identity is "agent:<principal>" (arcana-provisioner-client.ts
// composeArcanaBrainIdentity).
function oracleAgent() {
  return {
    id: ORACLE_ID,
    name: "Oracle",
    title: null,
    role: "general",
    metadata: {
      defaultMcp: {
        version: 1,
        entries: {
          "arcana-brain": {
            key: "arcana-brain",
            templateKey: "rh-arcana-brain",
            dedicated: true,
            connectionId: ARCANA_CONN_ID,
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
              secretId: "sec-arcana-oracle",
              secretVersion: "latest",
              connectionId: ARCANA_CONN_ID,
              grantId: "grant-arcana-oracle",
              tokenExpiresAt: null,
            },
          },
        },
      },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function renderAppAt(container: HTMLElement, path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  return root;
}

/**
 * Asserts the *real* Browse landing mounted — its search input, its custom
 * connector card, a resolved dedicated-agent account row, and that row's
 * full comms-board agent UUID rendered inline — so a route resolving to any
 * other surface (or nothing) fails structurally, not by brittle
 * source-text negation.
 */
async function expectBrowseLanding(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Hermes permissions"]',
      ),
    ).toBeTruthy(),
  );
  expect(
    container.querySelector('input[aria-label="Search connectors"]'),
  ).toBeTruthy();
  expect(container.textContent).toContain("Connect your own tool");
  expect(container.textContent).toContain("Hermes");
  // TECH-7592 board-ID regression, through the real <App> route table: the
  // full comms-board agent UUID (36 chars) is the explicit visible text.
  const boardBadge = container.querySelector(
    `code[aria-label="Comms board agent ID: ${HERMES_BOARD_AGENT_ID}"]`,
  );
  expect(boardBadge).toBeTruthy();
  expect(boardBadge?.textContent).toBe(HERMES_BOARD_AGENT_ID);
  expect(boardBadge?.textContent).toHaveLength(36);
  expect(container.textContent).toContain(HERMES_BOARD_AGENT_ID);
  // No wrong-domain leak: the Paperclip internal agent UUID and the board
  // JWT subject never appear in the visible surface.
  expect(container.textContent).not.toContain(HERMES_ID);
  expect(container.textContent).not.toContain(`paperclip-agent-${HERMES_ID}`);
}

describe("App Apps routing (TECH-7592)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    listGalleryMock.mockResolvedValue({ apps: [] });
    listApplicationsMock.mockResolvedValue({
      applications: [commsBoardApplication()],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [dedicatedCommsConnection()],
    });
    listUserDirectoryMock.mockResolvedValue({ users: [] });
    listAgentsMock.mockResolvedValue([hermesAgent()]);
    getSessionMock.mockResolvedValue(null);
    getExperimentalMock.mockResolvedValue({});
    chatListMock.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("mounts the real Browse landing at /:company/apps with dedicated-agent identity", async () => {
    root = await renderAppAt(container, "/PAP/apps");
    await expectBrowseLanding(container);
    // The roster fetch Browse resolves identity against is company-scoped.
    expect(listAgentsMock).toHaveBeenCalledWith("company-1");
  });

  it("redirects the retired /:company/apps/browse URL to the Browse landing", async () => {
    root = await renderAppAt(container, "/PAP/apps/browse");
    await expectBrowseLanding(container);
  });

  it("redirects the retired /:company/apps/connections URL to the Browse landing", async () => {
    root = await renderAppAt(container, "/PAP/apps/connections");
    await expectBrowseLanding(container);
  });

  it("mounts the Arcana brain dedicated row alongside the comms row (TECH-7673 canonical brain ID through the real route)", async () => {
    // Arcana row plus the comms row simultaneously, through the real <App>
    // route table — no modal/menu interactions, only the routed landing's
    // own structural surface.
    listApplicationsMock.mockResolvedValue({
      applications: [commsBoardApplication(), arcanaBrainApplication()],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [dedicatedCommsConnection(), dedicatedArcanaConnection()],
    });
    listAgentsMock.mockResolvedValue([hermesAgent(), oracleAgent()]);

    root = await renderAppAt(container, "/PAP/apps");
    // The comms landing (TECH-7592) still mounts intact alongside the new row.
    await expectBrowseLanding(container);

    // TECH-7673: the full canonical brain ID ("agent:<principal UUID>", 42
    // chars) is the explicit visible text on the Arcana row — not only in
    // aria/title, and never a shortened form.
    const brainBadge = container.querySelector(
      `code[aria-label="Arcana brain ID: ${ARCANA_BRAIN_ID}"]`,
    );
    expect(brainBadge).toBeTruthy();
    expect(brainBadge?.textContent).toBe(ARCANA_BRAIN_ID);
    expect(brainBadge?.textContent).toHaveLength(42);
    expect(brainBadge?.getAttribute("title")).toBe(`Arcana brain ID: ${ARCANA_BRAIN_ID}`);
    expect(container.textContent).toContain("Oracle");
    expect(container.textContent).toContain("general · Arcana Brain");
    // Row-scoped: the Arcana row carries no comms badge, and the comms row
    // carries no Arcana badge — the two identity domains stay separate.
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-app-slug]"));
    const arcanaRow = rows.find((row) =>
      row.querySelector(`code[aria-label="Arcana brain ID: ${ARCANA_BRAIN_ID}"]`),
    );
    const commsRow = rows.find((row) =>
      row.querySelector(`code[aria-label="Comms board agent ID: ${HERMES_BOARD_AGENT_ID}"]`),
    );
    expect(arcanaRow).toBeTruthy();
    expect(commsRow).toBeTruthy();
    expect(arcanaRow?.querySelector('code[aria-label^="Comms board agent ID:"]')).toBeNull();
    expect(arcanaRow?.textContent).not.toContain(HERMES_BOARD_AGENT_ID);
    expect(commsRow?.querySelector('code[aria-label^="Arcana brain ID:"]')).toBeNull();
    expect(commsRow?.textContent).not.toContain(ARCANA_BRAIN_ID);
    expect(commsRow?.textContent).not.toContain(ARCANA_PRINCIPAL_ID);
    // No wrong-domain leak on the routed surface: the internal Paperclip
    // agent UUID (full and 8-char prefix), the dedicated Arcana connection
    // UUID, and the board JWT subject never appear.
    expect(container.textContent).not.toContain(ORACLE_ID);
    expect(container.textContent).not.toContain(ORACLE_ID.slice(0, 8));
    expect(container.textContent).not.toContain(ARCANA_CONN_ID);
    expect(container.textContent).not.toContain(`paperclip-agent-${ORACLE_ID}`);
  });
});

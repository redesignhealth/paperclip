// @vitest-environment jsdom

// Regression guard for TECH-7592: the apps landing route must mount the real
// <Browse> surface — the single connector catalog whose account rows carry
// dedicated-agent identity — and the retired /apps/browse and
// /apps/connections URLs must keep redirecting to it. App.test.tsx pins the
// same facts as a static source contract; this drives the real <App> route
// table so a future route-table edit that drops or shadows the Browse route
// fails on behavior, not just on source text.

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
 * connector card, and a resolved dedicated-agent account row — so a route
 * resolving to any other surface (or nothing) fails structurally, not by
 * brittle source-text negation.
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
    listAgentsMock.mockResolvedValue([
      { id: HERMES_ID, name: "Hermes", title: null, role: "general" },
    ]);
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
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatEndpointSetup } from "./ChatEndpointSetup";

const api = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), create: vi.fn(), slackSetupOptions: vi.fn(),
  test: vi.fn(), finishSlackSetup: vi.fn(),
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: api }));
vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn(async () => [{ id: "agent-a", name: "Maya", status: "idle" }]) },
}));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({})) },
}));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company" }),
}));
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast }) }));
// Step navigation is not under test: expose its selector as plain buttons.
vi.mock("@/components/chat/ChatSetupNavigation", () => ({
  ChatSetupNavigation: ({ labels, onSelect }: { labels?: string[]; onSelect: (step: number) => void }) =>
    <nav>{(labels ?? []).map((label, index) => (
      <button key={label} type="button" onClick={() => onSelect(index)}>{label}</button>
    ))}</nav>,
}));
// The provider step is not under test and needs its own Slack APIs.
vi.mock("./slack/SlackSetup", () => ({ SlackSetup: () => null }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

const baseSetup = {
  step: "provider_setup",
  slackSetupMethod: "managed" as const,
  slackApp: { appName: "maya-paperclip", botName: "maya", command: "/maya" },
};

function draft(overrides: Partial<ChatEndpoint> = {}) {
  return {
    id: "endpoint-a", companyId: "company", provider: "slack", status: "draft",
    assignedAgentId: "agent-a", assignedAgentName: "Maya",
    allowUnlinkedPeople: false, trustUnlinkedPeople: false,
    setup: { ...baseSetup, slackOptInScopeGroups: [] },
    ...overrides,
  } as unknown as ChatEndpoint;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(draft());
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, defaultMethod: "managed", workspaces: [] });
  api.update.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({
    ...draft(), setup: { ...draft().setup, ...input },
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function render(search = "provider=slack&purpose=chat&agentId=agent-a") {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/apps/chat/connect?${search}`]}>
          <Routes><Route path="/apps/chat/connect" element={<ChatEndpointSetup />} /></Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  ));
  await vi.waitFor(() => expect(api.slackSetupOptions).toHaveBeenCalled());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

async function openAgentStep() {
  // Purpose "choice" renders first; pick the chat action.
  const chat = [...container.querySelectorAll("button")]
    .find((node) => node.textContent?.includes("Chat with an agent"));
  if (chat) await act(async () => chat.click());
  // A resumed endpoint opens on a later step; go back to Choose agent.
  const chooseAgent = [...container.querySelectorAll("button")]
    .find((node) => node.textContent === "Choose agent");
  if (chooseAgent) await act(async () => chooseAgent.click());
  // The opt-in controls live inside the Choose-agent step's Advanced section.
  const advanced = [...container.querySelectorAll("summary")]
    .find((node) => node.textContent?.includes("Advanced"));
  if (advanced) await act(async () => advanced.click());
}

function optInCheckbox(label: string) {
  const row = [...container.querySelectorAll("label")]
    .find((item) => item.textContent === label)!;
  return container.querySelector<HTMLButtonElement>(`#${row.htmlFor}`)!;
}

describe("Slack opt-ins on the Choose-agent step", () => {
  it("shows all three groups off for a new agent", async () => {
    await render();
    await openAgentStep();
    expect(container.textContent).toContain("Extra Slack permissions");
    for (const label of ["Channel management", "Proactive DMs", "File upload"]) {
      expect(optInCheckbox(label).getAttribute("aria-checked")).toBe("false");
    }
  });

  it("creates the endpoint with an explicit empty opt-in list by default", async () => {
    api.create.mockResolvedValue(draft());
    await render();
    await openAgentStep();
    const continueButton = [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Continue");
    expect(continueButton).toBeDefined();
    await act(async () => continueButton!.click());
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    const [, input] = api.create.mock.calls[0]!;
    expect(input.slackOptInScopeGroups).toEqual([]);
  });

  it("creates the endpoint with the chosen group when selected before creation", async () => {
    api.create.mockResolvedValue(draft());
    await render();
    await openAgentStep();
    await act(async () => optInCheckbox("File upload").click());
    const continueButton = [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Continue");
    await act(async () => continueButton!.click());
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    const [, input] = api.create.mock.calls[0]!;
    expect(input.slackOptInScopeGroups).toEqual(["file_upload"]);
  });

  it("persists a toggle on an existing draft with only the opt-in field", async () => {
    api.get.mockResolvedValue(draft({ id: "endpoint-a" }));
    await render("provider=slack&purpose=chat&resume=endpoint-a&agentId=agent-a");
    await openAgentStep();
    await act(async () => optInCheckbox("Proactive DMs").click());
    await vi.waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("endpoint-a", { slackOptInScopeGroups: ["proactive_dms"] }));
    // The app-details save path must never carry opt-ins.
    for (const [, payload] of api.update.mock.calls) {
      if (payload.slackApp) expect(payload.slackOptInScopeGroups).toBeUndefined();
    }
  });

  it("serializes rapid toggles and sends the newest selection", async () => {
    api.get.mockResolvedValue(draft());
    await render("provider=slack&purpose=chat&resume=endpoint-a&agentId=agent-a");
    await openAgentStep();
    await act(async () => optInCheckbox("File upload").click());
    await act(async () => optInCheckbox("Proactive DMs").click());
    await vi.waitFor(() => expect(api.update).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    const optInCalls = api.update.mock.calls.filter(
      ([, payload]) => payload.slackOptInScopeGroups !== undefined,
    );
    expect(optInCalls.at(-1)![1].slackOptInScopeGroups)
      .toEqual(["proactive_dms", "file_upload"]);
    for (const call of optInCalls) {
      expect(Object.keys(call[1])).toEqual(["slackOptInScopeGroups"]);
    }
  });

  it("rolls back a rejected save and reports it without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      api.get.mockResolvedValue(draft());
      api.update.mockRejectedValueOnce(new Error("Slack permissions were rejected"));
      await render("provider=slack&purpose=chat&resume=endpoint-a&agentId=agent-a");
      await openAgentStep();
      await act(async () => optInCheckbox("File upload").click());
      await vi.waitFor(() => expect(api.update).toHaveBeenCalled());
      await vi.waitFor(() =>
        expect(optInCheckbox("File upload").getAttribute("aria-checked")).toBe("false"));
      expect(container.textContent).toContain("Couldn't save the Slack permission groups");
      expect(pushToast).toHaveBeenCalledWith({
        title: "Couldn't update Slack permissions",
        body: "Your selection was not saved. Try again.",
        tone: "error",
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("sends a pending installed change to the Connect step from the opt-in panel", async () => {
    api.get.mockResolvedValue(draft({
      id: "endpoint-a",
      botExternalId: "B123",
      setup: {
        ...baseSetup,
        slackOptInScopeGroups: ["file_upload"],
        slackInstalledOptInScopeGroups: [],
      },
    }));
    await render("provider=slack&purpose=chat&resume=endpoint-a&agentId=agent-a&reconnect=1");
    await openAgentStep();
    // The panel owns the reinstall action while on the Choose-agent step.
    const reinstall = [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Reinstall in Slack");
    expect(reinstall).toBeDefined();
    await act(async () => reinstall!.click());
    // The reinstall lives on the Connect step, which is where it must land.
    expect(container.textContent).toContain("Connect to Slack");
    expect(container.textContent).not.toContain("Which agent do you want to chat with?");
  });

  it("shows the saved request and a pending prompt for a changed installed agent", async () => {
    api.get.mockResolvedValue(draft({
      botExternalId: "B123",
      setup: {
        ...baseSetup,
        slackOptInScopeGroups: ["file_upload"],
        slackInstalledOptInScopeGroups: [],
      },
    }));
    await render("provider=slack&purpose=chat&resume=endpoint-a&agentId=agent-a");
    await openAgentStep();
    expect(optInCheckbox("File upload").getAttribute("aria-checked")).toBe("true");
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("differs from what Slack granted");
  });
});

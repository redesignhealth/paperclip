// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatEndpointSetup } from "./ChatEndpointSetup";

const api = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), create: vi.fn(), slackSetupOptions: vi.fn(),
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: api }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => [{ id: "agent-a", name: "Maya", status: "idle" }]) } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn(async () => ({})) } }));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
// Step navigation is not under test: expose its selector as plain buttons.
vi.mock("@/components/chat/ChatSetupNavigation", () => ({
  ChatSetupNavigation: ({ labels, onSelect }: { labels?: string[]; onSelect: (step: number) => void }) =>
    <nav>{(labels ?? []).map((label, index) => <button key={label} type="button" onClick={() => onSelect(index)}>{label}</button>)}</nav>,
}));
// The provider step is not under test and needs its own Slack APIs.
vi.mock("./slack/SlackSetup", () => ({ SlackSetup: () => null }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const draft = {
  id: "endpoint-a", companyId: "company", provider: "slack", status: "draft",
  assignedAgentId: "agent-a", assignedAgentName: "Maya", allowUnlinkedPeople: false, trustUnlinkedPeople: false,
  setup: { step: "provider_setup", slackSetupMethod: "managed", slackApp: { appName: "maya-paperclip", botName: "maya", command: "/maya" }, slackOptInScopeGroups: [] },
} as unknown as ChatEndpoint;

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(draft);
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, defaultMethod: "managed", workspaces: [] });
  api.update.mockImplementation(async (_id: string, input: { slackOptInScopeGroups?: string[] }) => ({
    ...draft, setup: { ...draft.setup, ...input },
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function openAgentStep() {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint-a"]}>
          <Routes><Route path="/apps/chat/connect" element={<ChatEndpointSetup />} /></Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  ));
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Choose agent")!.click());
  // The opt-ins live under the agent step's Advanced section.
  await act(async () => container.querySelector("details")!.setAttribute("open", ""));
}

function optIn(label: string) {
  const row = Array.from(container.querySelectorAll("label")).find(item => item.textContent?.includes(label))!;
  return row.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
}

it("shows the three Slack permission opt-ins off by default with admin-review guidance", async () => {
  await openAgentStep();
  expect(container.textContent).toContain("Extra Slack permissions");
  for (const label of ["Channel management", "Proactive DMs", "File upload"]) {
    expect(optIn(label).getAttribute("aria-checked")).toBe("false");
  }
  expect(container.textContent?.match(/admin review/g)?.length).toBe(3);
});

it("persists an enabled group on the endpoint", async () => {
  await openAgentStep();
  await act(async () => optIn("File upload").click());
  await vi.waitFor(() => expect(api.update).toHaveBeenCalledWith("endpoint-a", { slackOptInScopeGroups: ["file_upload"] }));
  await vi.waitFor(() => expect(optIn("File upload").getAttribute("aria-checked")).toBe("true"));
});

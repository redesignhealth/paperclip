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
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast }) }));
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

it("handles the final rejected save without an unhandled rejection and preserves rollback/toast", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  window.addEventListener("unhandledrejection", unhandled);
  try {
    await openAgentStep();
    api.update.mockRejectedValueOnce(new Error("Slack permissions were rejected"));
    await act(async () => optIn("File upload").click());
    await vi.waitFor(() => expect(api.update).toHaveBeenCalled());
    await vi.waitFor(() => expect(optIn("File upload").getAttribute("aria-checked")).toBe("false"));
    expect(container.textContent).toContain("Couldn't save the Slack permission groups");
    expect(container.textContent).not.toContain("Couldn't save the Slack app details");
    expect(pushToast).toHaveBeenCalledWith({
      title: "Couldn't update Slack permissions",
      body: "Your selection was not saved. Try again.",
      tone: "error",
    });
    // Leave the rejected save as the last queue item. A subsequent toggle must
    // not be necessary to consume its rejection; allow an event-loop turn for
    // Node/browser unhandled-rejection reporting (Vitest also detects it).
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
    window.removeEventListener("unhandledrejection", unhandled);
  }
});

it("does not resend opt-ins from the app-details save and keeps the newest toggle (S23)", async () => {
  await openAgentStep();
  api.update.mockResolvedValue(draft);
  // Two rapid toggles must not resolve out of order.
  await act(async () => { optIn("File upload").click(); optIn("Proactive DMs").click(); });
  await vi.waitFor(() => expect(api.update).toHaveBeenCalled());
  for (const [endpointId, payload] of api.update.mock.calls) {
    expect(endpointId).toBe("endpoint-a");
    expect(Object.keys(payload)).toEqual(["slackOptInScopeGroups"]);
  }
  // The app-details path never carries opt-ins.
  const detailsBlur = Array.from(container.querySelectorAll("input")).find(input => input.id === "slack-appName");
  await act(async () => detailsBlur?.dispatchEvent(new Event("blur", { bubbles: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  for (const [, payload] of api.update.mock.calls) {
    if (payload.slackApp) expect(payload.slackOptInScopeGroups).toBeUndefined();
  }
});

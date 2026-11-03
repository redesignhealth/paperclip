// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAccessSection } from "./PermissionsPanel";
import { installStateFrom } from "@/lib/tool-installs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP" } }),
}));

let container: HTMLDivElement | null = null;

afterEach(() => {
  container?.remove();
  container = null;
});

const agent = { id: "agent-1", name: "Chief of Staff", status: "idle", title: null };

function renderSection(props: { mode: "all" | "specific"; anyAgentUnavailableReason?: string }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AgentAccessSection
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agents={[agent] as any}
            access={{ mode: props.mode, agentIds: new Set() }}
            install={installStateFrom([])}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            capabilities={{ canConfigure: true } as any}
            disabled={false}
            anyAgentUnavailableReason={props.anyAgentUnavailableReason}
            onSave={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return container;
}

const radios = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="radio"]')];
const anyAgentRadio = (el: HTMLElement) => radios(el).find((r) => r.textContent?.includes("Any agent"));
const isDisabled = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

describe("agent access choice", () => {
  it("offers 'Any agent' for an ordinary connection", () => {
    const el = renderSection({ mode: "all" });
    const radio = anyAgentRadio(el);
    expect(radio).toBeTruthy();
    expect(isDisabled(radio!)).toBe(false);
    expect(radio!.getAttribute("aria-checked")).toBe("true");
  });

  it("greys out 'Any agent', says why, and shows the agent picker for a personal sign-in connection, even if the draft says all", () => {
    const reason = "This connection runs as one person's own sign-in, so it can't be shared with every agent.";
    const el = renderSection({ mode: "all", anyAgentUnavailableReason: reason });
    const radio = anyAgentRadio(el);
    expect(radio).toBeTruthy();
    expect(isDisabled(radio!)).toBe(true);
    expect(radio!.getAttribute("aria-checked")).not.toBe("true");
    expect(el.textContent).toContain(reason);
    expect(el.textContent).toContain("Choose agents");
  });
});

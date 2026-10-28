// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { SlackAutomaticSetup } from "./SlackAutomaticSetup";

const api = vi.hoisted(() => ({ createSlackApp: vi.fn(), installSlackApp: vi.fn(), get: vi.fn(), resumeSlackInstallation: vi.fn(), saveSlackConfigurationCredential: vi.fn(), forgetSlackConfigurationCredential: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: api }));

const draft = { id: "endpoint-a", setup: { slackSetupMethod: "automatic" } } as ChatEndpoint;
const created = { ...draft, setup: { ...draft.setup, slackRegistration: { status: "install", appId: "ATEST" } } } as ChatEndpoint;

describe("automatic Slack installation handoff", () => {
  let root: Root;
  let container: HTMLDivElement;
  let popup: { opener: unknown; closed: boolean; document: { title: string; body: { textContent: string } }; location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> };
  const onSaved = vi.fn();
  const onContinue = vi.fn();
  beforeEach(async () => {
    vi.resetAllMocks();
    popup = { opener: window, closed: false, document: { title: "", body: { textContent: "" } }, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    api.createSlackApp.mockResolvedValue(created);
    api.installSlackApp.mockResolvedValue({ authorizationUrl: "https://slack.com/oauth/v2/authorize?state=fixture" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<SlackAutomaticSetup endpoint={draft} stage="app" disabled={false}
      saveDetails={async () => {}} onSaved={onSaved} onContinue={onContinue} onBusy={() => {}}
      onManual={async () => {}} onSaveExit={() => {}} />));
    await act(async () => {
      const input = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-config-token");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  async function submit() {
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Create Slack app")!.click());
  }
  it("opens a window during the click and navigates it only after saved creation and authorization", async () => {
    let resolve!: (value: ChatEndpoint) => void;
    api.createSlackApp.mockReturnValue(new Promise<ChatEndpoint>(done => { resolve = done; }));
    await submit();
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(popup.opener).toBeNull();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(api.installSlackApp).not.toHaveBeenCalled();
    expect(container.querySelector("input")!.value).toBe("");
    await act(async () => resolve(created));
    expect(onSaved).toHaveBeenCalledWith(created);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(api.installSlackApp).toHaveBeenCalledExactlyOnceWith(draft.id);
    expect(popup.location.replace).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?state=fixture");
    expect(popup.close).not.toHaveBeenCalled();
  });
  it("keeps the saved app and offers installation when the popup is blocked", async () => {
    vi.mocked(window.open).mockReturnValue(null);
    await submit();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(api.installSlackApp).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Select Install in Slack");
  });
  it("closes the placeholder and keeps installation retryable when authorization fails", async () => {
    api.installSlackApp.mockRejectedValue(new Error("Installation unavailable"));
    await submit();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(api.createSlackApp).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it.each(["uncertain", "pending configuration"])("does not install on %s creation", async status => {
    const saved = status === "uncertain"
      ? { ...draft, setup: { ...draft.setup, slackRegistration: { status: "uncertain" } } }
      : { ...created, setup: { ...created.setup, slackRegistration: { ...created.setup!.slackRegistration, errorCode: "slack_manifest_update_pending" } } };
    api.createSlackApp.mockResolvedValue(saved);
    await submit();
    expect(api.installSlackApp).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost creation response using saved state without creating another app", async () => {
    api.createSlackApp.mockRejectedValue(new Error("Lost response"));
    api.get.mockResolvedValue(created);
    await submit();
    expect(api.createSlackApp).toHaveBeenCalledTimes(1);
    expect(api.installSlackApp).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
  it("closes the waiting window and does not install after leaving setup", async () => {
    let resolve!: (value: ChatEndpoint) => void;
    api.createSlackApp.mockReturnValue(new Promise<ChatEndpoint>(done => { resolve = done; }));
    await submit();
    await act(async () => root.unmount());
    await act(async () => resolve(created));
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(api.installSlackApp).not.toHaveBeenCalled();
  });
});

describe("automatic Slack setup actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const endpoint: ChatEndpoint = { id: "endpoint", companyId: "company", provider: "slack", status: "draft", assignedAgentId: "agent", assignedAgentName: "Maya", allowUnlinkedPeople: false, trustUnlinkedPeople: false, setup: { step: "provider_setup", slackSetupMethod: "automatic" } };
  const saved: ChatEndpoint = { ...endpoint, setup: { ...endpoint.setup!, slackRegistration: { status: "install", appId: "AEXAMPLE" } } };
  const onSaved = vi.fn(), onContinue = vi.fn(), onManual = vi.fn(), saveDetails = vi.fn(), onBusy = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, "open").mockReturnValue(null);
    localStorage.clear(); sessionStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    api.createSlackApp.mockResolvedValue(saved); api.get.mockResolvedValue(endpoint); saveDetails.mockResolvedValue(undefined);
  });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  function render(value = endpoint, stage: "app" | "credentials" = "app") {
    flushSync(() => root.render(<SlackAutomaticSetup endpoint={value} stage={stage} disabled={false} saveDetails={saveDetails}
      onSaved={onSaved} onContinue={onContinue} onManual={onManual} onBusy={onBusy} onSaveExit={() => {}} />));
  }
  function enter(value: string) {
    const field = container.querySelector("input[type=password]")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!;
    expect(button).toBeDefined(); flushSync(() => button.click());
  }
  it("clears the token, prevents duplicate clicks, and advances only from saved app identity", async () => {
    let complete!: (value: ChatEndpoint) => void;
    api.createSlackApp.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(container.querySelector<HTMLInputElement>("input[type=password]")!.value).toBe("");
    click("Create Slack app"); expect(api.createSlackApp).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    complete(saved); await settle();
    expect(onContinue).toHaveBeenCalledTimes(1); expect(onSaved).toHaveBeenCalledWith(saved);
    expect(saveDetails.mock.invocationCallOrder[0]).toBeLessThan(api.createSlackApp.mock.invocationCallOrder[0]);
    expect(container.innerHTML).not.toContain("configuration-canary");
  });
  it("recovers a lost response by reading saved state without another creation request", async () => {
    api.createSlackApp.mockRejectedValue(new Error("lost response")); api.get.mockResolvedValue(saved);
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(api.createSlackApp).toHaveBeenCalledTimes(1); expect(onContinue).toHaveBeenCalledTimes(1);
  });
  it("redacts error echoes and clears the token when creation fails", async () => {
    api.createSlackApp.mockRejectedValue(new Error("Provider echoed configuration-canary"));
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(container.textContent).toContain("[redacted]"); expect(container.innerHTML).not.toContain("configuration-canary");
    expect(onContinue).not.toHaveBeenCalled();
  });
  it("requires an explicit checked-no-app confirmation before retrying an uncertain result", async () => {
    render({ ...endpoint, setup: { ...endpoint.setup!, slackRegistration: { status: "uncertain", errorCode: "slack_creation_uncertain" } } });
    expect(container.querySelector("input[type=password]")).toBeNull();
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    enter("new-token"); click("Create Slack app"); await settle();
    expect(api.createSlackApp.mock.calls[0][1]).toMatchObject({ confirmedNoAppCreated: true });
  });
  it("keeps both manual paths explicit and resumes saved installation credentials", async () => {
    render(); click("Use an existing app"); await settle(); expect(onManual).toHaveBeenCalledWith(true);
    render({ ...saved, setup: { ...saved.setup!, slackRegistration: { status: "credentials_saved", appId: "AEXAMPLE" } } }, "credentials");
    api.resumeSlackInstallation.mockResolvedValue(saved);
    click("Retry connecting"); await settle();
    expect(api.resumeSlackInstallation).toHaveBeenCalledWith("endpoint"); expect(api.createSlackApp).not.toHaveBeenCalled();
    api.installSlackApp.mockRejectedValue(new Error("Authorization unavailable"));
    click("Authorize in Slack again"); await settle();
    expect(api.installSlackApp).toHaveBeenCalledWith("endpoint");
    expect(api.createSlackApp).not.toHaveBeenCalled();
  });
});

describe("saved Slack configuration credentials", () => {
  let container: HTMLDivElement;
  let root: Root;
  const companyId = "company-a";
  const endpoint: ChatEndpoint = { id: "endpoint", companyId, provider: "slack", status: "draft", assignedAgentId: "agent", assignedAgentName: "Maya", allowUnlinkedPeople: false, trustUnlinkedPeople: false, setup: { step: "provider_setup", slackSetupMethod: "automatic" } };
  const savedEndpoint: ChatEndpoint = { ...endpoint, setup: { ...endpoint.setup!, slackRegistration: { status: "install", appId: "AEXAMPLE" } } };
  const activeCredential = { id: "credential-a", workspaceId: "TWORKSPACE", slackUserId: "USLACK", status: "active" as const, lastRotatedAt: "2026-10-20T12:00:00.000Z" };
  const onSaved = vi.fn(), onContinue = vi.fn(), onManual = vi.fn(), saveDetails = vi.fn(), onBusy = vi.fn();
  const refetchSlackSetupOptions = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, "open").mockReturnValue(null);
    localStorage.clear(); sessionStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    api.createSlackApp.mockResolvedValue(savedEndpoint); api.get.mockResolvedValue(endpoint);
    api.saveSlackConfigurationCredential.mockResolvedValue(activeCredential);
    api.forgetSlackConfigurationCredential.mockResolvedValue(undefined);
    saveDetails.mockResolvedValue(undefined);
  });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  type Credential = typeof activeCredential | (Omit<typeof activeCredential, "status"> & { status: "reauthorize" });
  function render(props: { slackSetupOptions?: { configurationCredentials?: Credential[] }; credentials?: Credential[] } = {}) {
    flushSync(() => root.render(<SlackAutomaticSetup endpoint={endpoint} stage="app" disabled={false} saveDetails={saveDetails}
      onSaved={onSaved} onContinue={onContinue} onManual={onManual} onBusy={onBusy} onSaveExit={() => {}}
      slackSetupOptions={props.slackSetupOptions ?? { configurationCredentials: props.credentials ?? [] }}
      refetchSlackSetupOptions={refetchSlackSetupOptions} />));
  }
  /** Make the next refetch deliver a new authoritative snapshot, as react-query does. */
  function refetchReturns(credentials: Credential[]) {
    refetchSlackSetupOptions.mockImplementation(async () => { render({ credentials }); return undefined; });
  }
  async function chooseWorkspace(label: string) {
    const trigger = container.querySelector('[aria-label="Saved Slack configuration workspace"]')!;
    flushSync(() => (trigger as HTMLElement).click());
    const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === label)!;
    flushSync(() => (option as HTMLElement).click());
    await settle();
  }
  function enter(value: string, selector = "input[type=password]") {
    const field = container.querySelector(selector)!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  }
  function button(label: string) { const node = findButton(label); expect(node).toBeDefined(); return node!; }
  const createButton = () => findButton("Create Slack app")!;

  it("enables creation from a saved credential with no input and sends only its id", async () => {
    render({ credentials: [activeCredential] });
    expect(container.textContent).toContain("Using your saved Slack configuration token for workspace");
    expect(container.textContent).toContain("TWORKSPACE");
    expect(container.querySelector("#slack-configuration-refresh-token")).toBeNull();
    expect(createButton().disabled).toBe(false);
    flushSync(() => createButton().click());
    await settle();
    expect(api.createSlackApp).toHaveBeenCalledWith(endpoint.id, expect.objectContaining({ credentials: { configurationCredentialId: activeCredential.id } }));
    expect(api.saveSlackConfigurationCredential).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("lets the user choose among several saved workspaces", async () => {
    const other = { ...activeCredential, id: "credential-b", workspaceId: "TOTHER" };
    render({ credentials: [activeCredential, other] });
    // With more than one, the button is gated until a workspace is chosen.
    expect(createButton().disabled).toBe(true);
    await chooseWorkspace("TOTHER");
    flushSync(() => createButton().click());
    await settle();
    expect(api.createSlackApp).toHaveBeenCalledWith(endpoint.id, expect.objectContaining({ credentials: { configurationCredentialId: other.id } }));
  });

  it("saves the refresh token, then creates with the new credential id and never keeps the token", async () => {
    refetchReturns([activeCredential]);
    render({ credentials: [] });
    enter("xoxe-1-pasted-refresh");
    flushSync(() => createButton().click());
    await settle();
    expect(api.saveSlackConfigurationCredential).toHaveBeenCalledWith(companyId, "xoxe-1-pasted-refresh");
    expect(api.createSlackApp).toHaveBeenCalledWith(endpoint.id, expect.objectContaining({ credentials: { configurationCredentialId: activeCredential.id } }));
    // Save must happen before create.
    expect(api.saveSlackConfigurationCredential.mock.invocationCallOrder[0]).toBeLessThan(api.createSlackApp.mock.invocationCallOrder[0]);
    expect(refetchSlackSetupOptions).toHaveBeenCalled();
    expect(container.querySelector("#slack-configuration-refresh-token")).toBeNull();
    expect(container.textContent).toContain("Using your saved Slack configuration token for workspace");
    expect(container.innerHTML).not.toContain("xoxe-1-pasted-refresh");
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it("sanitizes a save failure without echoing the token", async () => {
    api.saveSlackConfigurationCredential.mockRejectedValue(new Error(`Slack rejected the saved configuration refresh token. Provider echoed xoxe-1-pasted-refresh`));
    render({ credentials: [] });
    enter("xoxe-1-pasted-refresh");
    flushSync(() => createButton().click());
    await settle();
    expect(container.textContent).toContain("[redacted]");
    expect(container.innerHTML).not.toContain("xoxe-1-pasted-refresh");
    expect(api.createSlackApp).not.toHaveBeenCalled();
    expect(refetchSlackSetupOptions).toHaveBeenCalled();
  });

  it("keeps an active workspace selectable when another needs reauthorization", async () => {
    const stale = { ...activeCredential, id: "credential-b", workspaceId: "TSTALE", status: "reauthorize" as const };
    render({ credentials: [activeCredential, stale] });
    // Neither is assumed: the user chooses, and the stale one does not take over the panel.
    expect(container.querySelector('[aria-label="Saved Slack configuration workspace"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Slack rejected the saved configuration refresh token");
    expect(createButton().disabled).toBe(true);

    await chooseWorkspace(activeCredential.workspaceId);
    expect(container.textContent).toContain("Using your saved Slack configuration token for workspace");
    expect(container.querySelector("#slack-configuration-refresh-token")).toBeNull();
    flushSync(() => createButton().click());
    await settle();
    expect(api.saveSlackConfigurationCredential).not.toHaveBeenCalled();
    expect(api.createSlackApp).toHaveBeenCalledWith(endpoint.id, expect.objectContaining({ credentials: { configurationCredentialId: activeCredential.id } }));
  });

  it("saves a replacement for the selected stale workspace and creates with it, never the other active one", async () => {
    const stale = { ...activeCredential, id: "credential-b", workspaceId: "TSTALE", status: "reauthorize" as const };
    const replaced = { ...stale, status: "active" as const };
    api.saveSlackConfigurationCredential.mockResolvedValue(replaced);
    refetchReturns([activeCredential, replaced]);
    render({ credentials: [activeCredential, stale] });
    await chooseWorkspace("TSTALE (needs a new token)");
    expect(container.textContent).toContain("Slack rejected the saved configuration refresh token");
    enter("xoxe-1-replacement", "#slack-configuration-refresh-token");
    flushSync(() => createButton().click());
    await settle();
    expect(api.saveSlackConfigurationCredential).toHaveBeenCalledWith(companyId, "xoxe-1-replacement");
    expect(api.createSlackApp).toHaveBeenCalledTimes(1);
    expect(api.createSlackApp).toHaveBeenCalledWith(endpoint.id, expect.objectContaining({ credentials: { configurationCredentialId: stale.id } }));
    expect(container.innerHTML).not.toContain("xoxe-1-replacement");
  });

  it("does not create the app when a replacement token belongs to a different workspace", async () => {
    const stale = { ...activeCredential, id: "credential-b", workspaceId: "TSTALE", status: "reauthorize" as const };
    // The pasted token came from the active workspace instead.
    api.saveSlackConfigurationCredential.mockResolvedValue(activeCredential);
    refetchReturns([activeCredential, stale]);
    render({ credentials: [activeCredential, stale] });
    await chooseWorkspace("TSTALE (needs a new token)");
    enter("xoxe-1-wrong-workspace", "#slack-configuration-refresh-token");
    flushSync(() => createButton().click());
    await settle();
    expect(api.saveSlackConfigurationCredential).toHaveBeenCalledTimes(1);
    expect(api.createSlackApp).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Slack returned a token for a different workspace or account");
    expect(container.innerHTML).not.toContain("xoxe-1-wrong-workspace");
  });

  it("replaces the optimistic saved entry when the refetch reports reauthorization", async () => {
    // Save succeeds, but by the time options are refetched the chain was rejected.
    refetchReturns([{ ...activeCredential, status: "reauthorize" }]);
    api.createSlackApp.mockRejectedValue(new Error("Slack rejected the saved configuration refresh token."));
    render({ credentials: [] });
    enter("xoxe-1-pasted-refresh");
    flushSync(() => createButton().click());
    await settle();
    expect(container.textContent).not.toContain("Using your saved Slack configuration token for workspace");
    expect(container.querySelector("#slack-configuration-refresh-token")).not.toBeNull();
    expect(createButton().disabled).toBe(true);
  });

  it("drops the optimistic saved entry when the refetch no longer lists it (forgotten or revoked)", async () => {
    refetchReturns([]);
    api.createSlackApp.mockRejectedValue(new Error("Save a Slack configuration refresh token, or enter an app configuration access token, to continue."));
    render({ credentials: [] });
    enter("xoxe-1-pasted-refresh");
    flushSync(() => createButton().click());
    await settle();
    expect(container.textContent).not.toContain("Using your saved Slack configuration token for workspace");
    // Back to the no-credential paste state; nothing is usable as-is.
    expect(container.querySelector("#slack-configuration-refresh-token")).not.toBeNull();
    expect(createButton().disabled).toBe(true);
  });

  it("keeps the optimistic entry only until any newer options snapshot arrives", async () => {
    // The refetch itself fails, so the optimistic entry survives...
    refetchSlackSetupOptions.mockRejectedValue(new Error("offline"));
    render({ credentials: [] });
    enter("xoxe-1-pasted-refresh");
    flushSync(() => createButton().click());
    await settle();
    expect(container.textContent).toContain("Using your saved Slack configuration token for workspace");
    // ...until a later authoritative snapshot (e.g. a focus refetch) says otherwise.
    render({ credentials: [{ ...activeCredential, status: "reauthorize" }] });
    await settle();
    expect(container.textContent).not.toContain("Using your saved Slack configuration token for workspace");
    expect(container.textContent).toContain("Slack rejected the saved configuration refresh token");
  });

  it("shows the paste field when a saved credential needs reauthorization", async () => {
    render({ credentials: [{ ...activeCredential, status: "reauthorize" }] });
    expect(container.textContent).toContain("Slack rejected the saved configuration refresh token");
    expect(container.querySelector("#slack-configuration-refresh-token")).not.toBeNull();
    expect(createButton().disabled).toBe(true);
  });

  it("restores the one-time access-token field from the saved-credential view", async () => {
    render({ credentials: [activeCredential] });
    flushSync(() => button("Use a one-time access token instead").click());
    await settle();
    const accessField = container.querySelector("#slack-configuration-token");
    expect(accessField).not.toBeNull();
    enter("one-time-access-token", "#slack-configuration-token");
    flushSync(() => createButton().click());
    await settle();
    expect(api.saveSlackConfigurationCredential).not.toHaveBeenCalled();
    expect(api.createSlackApp).toHaveBeenCalledWith(endpoint.id, expect.objectContaining({ credentials: { configurationToken: "one-time-access-token" } }));
  });

  it("forgets the saved credential from the panel", async () => {
    render({ credentials: [activeCredential] });
    flushSync(() => button("Forget saved token").click());
    await settle();
    expect(api.forgetSlackConfigurationCredential).toHaveBeenCalledWith(companyId, activeCredential.id);
    expect(refetchSlackSetupOptions).toHaveBeenCalled();
    expect(api.createSlackApp).not.toHaveBeenCalled();
  });
});

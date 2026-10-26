// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvitesSection } from "./InvitesSection";
import { queryKeys } from "@/lib/queryKeys";

const listInvitesMock = vi.hoisted(() => vi.fn());
const createCompanyInviteMock = vi.hoisted(() => vi.fn());
const revokeInviteMock = vi.hoisted(() => vi.fn());
const getOwnerHandoffAvailabilityMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const clipboardWriteTextMock = vi.hoisted(() => vi.fn());
const companyState = vi.hoisted(() => ({
  current: {
    id: "company-1",
    name: "Paperclip",
    issuePrefix: "PAP",
    visibility: "shared" as "private" | "shared",
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listInvites: (companyId: string, options?: unknown) => listInvitesMock(companyId, options),
    createCompanyInvite: (companyId: string, input: unknown) =>
      createCompanyInviteMock(companyId, input),
    revokeInvite: (inviteId: string) => revokeInviteMock(inviteId),
    getOwnerHandoffAvailability: (companyId: string) => getOwnerHandoffAvailabilityMock(companyId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: companyState.current.id,
    selectedCompany: companyState.current,
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("InvitesSection", () => {
  let container: HTMLDivElement;
  const inviteHistory = Array.from({ length: 25 }, (_, index) => {
    const inviteNumber = 25 - index;
    const isActive = inviteNumber === 25;
    return {
      id: `invite-${inviteNumber}`,
      companyId: "company-1",
      inviteType: "company_join",
      tokenHash: `hash-${inviteNumber}`,
      allowedJoinTypes: "human",
      defaultsPayload: null,
      expiresAt: "2026-04-20T00:00:00.000Z",
      invitedByUserId: "user-1",
      revokedAt: null,
      acceptedAt: isActive ? null : "2026-04-11T00:00:00.000Z",
      createdAt: `2026-04-${String(inviteNumber).padStart(2, "0")}T00:00:00.000Z`,
      updatedAt: `2026-04-${String(inviteNumber).padStart(2, "0")}T00:00:00.000Z`,
      companyName: "Paperclip",
      humanRole: isActive ? "operator" : "viewer",
      inviteMessage: null,
      state: isActive ? "active" : "accepted",
      invitedByUser: {
        id: "user-1",
        name: `Board User ${inviteNumber}`,
        email: `board${inviteNumber}@paperclip.local`,
        image: null,
      },
      relatedJoinRequestId: isActive ? "join-1" : null,
    };
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    listInvitesMock.mockImplementation((_companyId: string, options?: { limit?: number; offset?: number }) => {
      const limit = options?.limit ?? 20;
      const offset = options?.offset ?? 0;
      const invites = inviteHistory.slice(offset, offset + limit);
      const nextOffset = offset + invites.length < inviteHistory.length ? offset + invites.length : null;
      return Promise.resolve({ invites, nextOffset });
    });

    createCompanyInviteMock.mockImplementation(() => {
      return Promise.resolve({
        token: "new-token",
        inviteUrl: "https://paperclip.local/invite/new-token",
        onboardingTextUrl: null,
        onboardingTextPath: null,
        humanRole: "viewer",
        allowedJoinTypes: "human",
      });
    });

    revokeInviteMock.mockResolvedValue(undefined);
    companyState.current = {
      id: "company-1",
      name: "Paperclip",
      issuePrefix: "PAP",
      visibility: "shared",
    };
    // TECH-7952: the server-derived answer the section renders from. A shared company never
    // queries it; private-company tests set it explicitly.
    getOwnerHandoffAvailabilityMock.mockResolvedValue({ available: false, reason: "not_private" });

    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a human-only invite flow and keeps invite history in a table", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <InvitesSection />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Invite a person");
    expect(container.textContent).not.toContain("Invite an agent");
    expect(container.textContent).not.toContain("Generate agent onboarding prompt");
    expect(container.textContent).toContain("Invite history");
    expect(container.textContent).toContain("Board User 25");
    expect(container.textContent).toContain("Board User 21");
    expect(container.textContent).not.toContain("Board User 20");
    expect(container.textContent).toContain("Review request");
    expect(container.textContent).toContain("View more");
    expect(container.textContent).not.toContain("Human or agent");
    expect(container.textContent).not.toContain("Invite message");
    expect(container.textContent).not.toContain("Latest generated invite");
    expect(container.textContent).not.toContain("Active invites");
    expect(container.textContent).not.toContain("Consumed invites");
    expect(container.textContent).not.toContain("Expired invites");
    expect(container.textContent).not.toContain("OpenClaw shortcut");

    expect(container.textContent).toContain("Choose a role");
    expect(container.textContent).toContain("Each invite link is single-use.");
    expect(container.textContent).toContain("Can create agents, invite users, assign tasks, and approve join requests.");
    expect(container.textContent).toContain("Everything in Admin, plus managing members.");
    expect(container.textContent).not.toContain("permission grants");
    expect(listInvitesMock).toHaveBeenCalledWith("company-1", { limit: 5, offset: 0 });

    const viewMoreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "View more",
    );

    await act(async () => {
      viewMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(listInvitesMock).toHaveBeenCalledWith("company-1", { limit: 5, offset: 5 });
    expect(container.textContent).toContain("Board User 20");
    expect(container.textContent).toContain("Board User 16");
    expect(container.textContent).toContain("View more");

    await act(async () => {
      const viewerRadio = container.querySelector('input[type="radio"][value="viewer"]') as HTMLInputElement | null;
      viewerRadio?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      viewerRadio?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const createButton = buttons.find((button) => button.textContent === "Create invite");
    const revokeButton = buttons.find((button) => button.textContent === "Revoke");

    expect(createButton).toBeTruthy();
    expect(revokeButton).toBeTruthy();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", {
      allowedJoinTypes: "human",
      humanRole: "viewer",
      agentMessage: null,
    });
    expect(clipboardWriteTextMock).toHaveBeenCalledWith("https://paperclip.local/invite/new-token");
    expect(container.textContent).toContain("Latest invite link");
    expect(container.textContent).toContain("This URL includes the current Paperclip domain returned by the server.");
    expect(container.querySelector('input[aria-label="Latest invite URL"]')).toHaveProperty(
      "value",
      "https://paperclip.local/invite/new-token",
    );
    expect(container.textContent).toContain("Copy link");
    // The inviter opening their own single-use link is never what they
    // mean, so the section deliberately offers no "Open invite" action.
    expect(container.textContent).not.toContain("Open invite");
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Invite created",
      body: "Invite ready below and copied to clipboard.",
      tone: "success",
    });

    const copyLinkButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Copy link",
    );

    await act(async () => {
      copyLinkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(clipboardWriteTextMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Copied");

    await act(async () => {
      revokeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(revokeInviteMock).toHaveBeenCalledWith("invite-25");

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to selectable text when browser clipboard access is unavailable", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "queryCommandSupported", {
      configurable: true,
      value: vi.fn((command: string) => command === "copy"),
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <InvitesSection />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    const createButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create invite",
    );

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const inviteInput = container.querySelector('input[aria-label="Latest invite URL"]') as HTMLInputElement | null;
    expect(inviteInput?.value).toBe("https://paperclip.local/invite/new-token");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Invite created",
      body: "Invite ready below and copied to clipboard.",
      tone: "success",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores legacy cached invite arrays and refetches paginated history", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["access", "invites", "company-1", "all"], inviteHistory.slice(0, 2));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <InvitesSection />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Board User 25");
    expect(container.textContent).not.toContain("Board User 20");
    expect(listInvitesMock).toHaveBeenCalledWith("company-1", { limit: 5, offset: 0 });
    expect(queryClient.getQueryData(queryKeys.access.invites("company-1", "all", 5))).toMatchObject({
      pages: [
        {
          invites: expect.any(Array),
          nextOffset: 5,
        },
      ],
    });

    await act(async () => {
      root.unmount();
    });
  });

  describe("TECH-7952 private-company owner handoff", () => {
    async function renderSection() {
      const root = createRoot(container);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      await act(async () => {
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <InvitesSection />
            </QueryClientProvider>
          </MemoryRouter>,
        );
      });
      await flushReact();
      await flushReact();
      return { root, queryClient };
    }

    const buttons = () => Array.from(container.querySelectorAll("button"));
    const buttonWithText = (text: string) => buttons().find((button) => button.textContent === text);

    it("shows a non-admin notice instead of the invite form on a private company", async () => {
      companyState.current = { ...companyState.current, visibility: "private" };
      getOwnerHandoffAvailabilityMock.mockResolvedValue({ available: false, reason: "not_instance_admin" });

      const { root } = await renderSection();

      expect(getOwnerHandoffAvailabilityMock).toHaveBeenCalledWith("company-1");
      expect(container.textContent).toContain("This is a private company. Only an instance admin can invite its owner.");
      expect(container.textContent).not.toContain("Invite the owner");
      expect(container.textContent).not.toContain("Owner email");
      expect(container.querySelector('input[type="email"]')).toBeNull();
      expect(buttonWithText("Create owner invite")).toBeUndefined();
      expect(buttonWithText("Create invite")).toBeUndefined();
      // No create call is possible from this state.
      expect(createCompanyInviteMock).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    });

    it("shows the owner-handoff form to an instance admin: required email, fixed Owner role, owner payload", async () => {
      companyState.current = { ...companyState.current, visibility: "private" };
      getOwnerHandoffAvailabilityMock.mockResolvedValue({ available: true, reason: null });
      createCompanyInviteMock.mockResolvedValue({
        token: "owner-token",
        inviteUrl: "https://paperclip.local/invite/owner-token",
        onboardingTextUrl: null,
        onboardingTextPath: null,
        humanRole: "owner",
        allowedJoinTypes: "human",
      });

      const { root } = await renderSection();

      expect(container.textContent).toContain("Invite the owner");
      expect(container.textContent).toContain("Owner email");
      expect(container.textContent).toContain("Role: Owner");
      expect(container.textContent).toContain("fixed for a private company");
      // The ordinary role picker is not offered on this branch.
      expect(container.querySelector('input[name="invite-role"]')).toBeNull();
      expect(container.textContent).not.toContain("Choose a role");

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement | null;
      expect(emailInput).not.toBeNull();
      expect(emailInput!.required).toBe(true);

      const createButton = buttonWithText("Create owner invite") as HTMLButtonElement | undefined;
      expect(createButton).toBeTruthy();
      // Nothing is submittable until the email is valid.
      expect(createButton!.disabled).toBe(true);

      const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      expect(inputValueSetter).toBeTypeOf("function");
      await act(async () => {
        inputValueSetter!.call(emailInput, "new.owner@example.com");
        emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
        emailInput!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flushReact();

      const enabledButton = buttonWithText("Create owner invite") as HTMLButtonElement | undefined;
      expect(enabledButton!.disabled).toBe(false);

      await act(async () => {
        enabledButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", {
        allowedJoinTypes: "human",
        humanRole: "owner",
        email: "new.owner@example.com",
        agentMessage: null,
      });
      expect(clipboardWriteTextMock).toHaveBeenCalledWith("https://paperclip.local/invite/owner-token");
      expect(container.textContent).toContain("Latest invite link");

      await act(async () => {
        root.unmount();
      });
    });

    it("normalizes the owner email to lowercase before submitting", async () => {
      companyState.current = { ...companyState.current, visibility: "private" };
      getOwnerHandoffAvailabilityMock.mockResolvedValue({ available: true, reason: null });

      const { root } = await renderSection();
      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

      await act(async () => {
        inputValueSetter!.call(emailInput, "  New.Owner@Example.COM  ");
        emailInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flushReact();

      await act(async () => {
        buttonWithText("Create owner invite")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
        humanRole: "owner",
        email: "new.owner@example.com",
      }));

      await act(async () => {
        root.unmount();
      });
    });

    it("keeps the shared-company flow unchanged: role picker, no email field, no owner payload", async () => {
      const { root } = await renderSection();

      expect(container.textContent).toContain("Invite a person");
      expect(container.textContent).toContain("Choose a role");
      expect(container.querySelector('input[type="email"]')).toBeNull();
      expect(container.textContent).not.toContain("Invite the owner");
      // A shared company never consults the handoff availability endpoint.
      expect(getOwnerHandoffAvailabilityMock).not.toHaveBeenCalled();

      await act(async () => {
        buttonWithText("Create invite")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", {
        allowedJoinTypes: "human",
        humanRole: "operator",
        agentMessage: null,
      });

      await act(async () => {
        root.unmount();
      });
    });

    it.each([
      [
        "not_instance_admin",
        "This is a private company. Only an instance admin can invite its owner.",
      ],
      [
        "cloud_managed_company",
        "This company's membership is managed by Paperclip Cloud. Owner handoff is unavailable here.",
      ],
      [
        "slot_occupied",
        "This private company already has its human owner or a pending owner invite. Revoke the pending invite or remove that member first.",
      ],
    ])("explains the %s refusal without hiding the form behind an instance-admin flag", async (reason, copy) => {
      companyState.current = { ...companyState.current, visibility: "private" };
      getOwnerHandoffAvailabilityMock.mockResolvedValue({ available: false, reason });

      const { root } = await renderSection();

      expect(container.textContent).toContain(copy);
      expect(container.querySelector('input[type="email"]')).toBeNull();
      expect(buttonWithText("Create owner invite")).toBeUndefined();

      await act(async () => {
        root.unmount();
      });
    });

    it("shows the fallback copy and no create form when the availability query errors", async () => {
      companyState.current = { ...companyState.current, visibility: "private" };
      // A failed query has no `reason` to map, and `retry: false` keeps it failed.
      getOwnerHandoffAvailabilityMock.mockRejectedValue(new Error("availability unavailable"));

      const { root } = await renderSection();

      expect(getOwnerHandoffAvailabilityMock).toHaveBeenCalledWith("company-1");
      expect(container.textContent).toContain(
        "Owner handoff is unavailable for this company right now.",
      );
      // The error is not the raw exception message, and it is not one of the reason-specific
      // strings either -- the fallback is its own copy.
      expect(container.textContent).not.toContain("availability unavailable");
      expect(container.textContent).not.toContain("Only an instance admin can invite its owner.");

      // H1: nothing renderable from a failed answer -- no form, no email field, no button.
      expect(container.textContent).not.toContain("Invite the owner");
      expect(container.textContent).not.toContain("Owner email");
      expect(container.querySelector('input[type="email"]')).toBeNull();
      expect(buttonWithText("Create owner invite")).toBeUndefined();
      expect(buttonWithText("Create invite")).toBeUndefined();
      expect(createCompanyInviteMock).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    });

    it("marks an owner handoff in invite history with a badge and the bound email", async () => {
      companyState.current = { ...companyState.current, visibility: "private" };
      getOwnerHandoffAvailabilityMock.mockResolvedValue({ available: true, reason: null });
      listInvitesMock.mockResolvedValue({
        invites: [
          {
            id: "invite-handoff",
            companyId: "company-1",
            inviteType: "company_join",
            tokenHash: "hash-handoff",
            allowedJoinTypes: "human",
            defaultsPayload: { human: { role: "owner" } },
            boundEmail: "new.owner@example.com",
            ownerHandoff: true,
            expiresAt: "2026-04-20T00:00:00.000Z",
            invitedByUserId: "admin-1",
            revokedAt: null,
            acceptedAt: null,
            createdAt: "2026-04-11T00:00:00.000Z",
            updatedAt: "2026-04-11T00:00:00.000Z",
            companyName: "Paperclip",
            humanRole: "owner",
            inviteMessage: null,
            state: "active",
            invitedByUser: {
              id: "admin-1",
              name: "Admin One",
              email: "admin@example.com",
              image: null,
            },
            relatedJoinRequestId: null,
          },
          {
            id: "invite-plain",
            companyId: "company-1",
            inviteType: "company_join",
            tokenHash: "hash-plain",
            allowedJoinTypes: "human",
            defaultsPayload: null,
            boundEmail: null,
            ownerHandoff: false,
            expiresAt: "2026-04-20T00:00:00.000Z",
            invitedByUserId: "admin-1",
            revokedAt: null,
            acceptedAt: null,
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
            companyName: "Paperclip",
            humanRole: "operator",
            inviteMessage: null,
            state: "active",
            invitedByUser: {
              id: "admin-1",
              name: "Admin One",
              email: "admin@example.com",
              image: null,
            },
            relatedJoinRequestId: null,
          },
        ],
        nextOffset: null,
      });

      const { root } = await renderSection();

      expect(container.textContent).toContain("Owner handoff");
      expect(container.textContent).toContain("new.owner@example.com");
      const rows = Array.from(container.querySelectorAll("tbody tr"));
      expect(rows).toHaveLength(2);
      // Only the handoff row gets the badge and the bound address.
      expect(rows[0]!.textContent).toContain("Owner handoff");
      expect(rows[0]!.textContent).toContain("new.owner@example.com");
      expect(rows[0]!.textContent).toContain("owner");
      expect(rows[1]!.textContent).toContain("operator");
      expect(rows[1]!.textContent).not.toContain("Owner handoff");
      expect(rows[1]!.textContent).not.toContain("new.owner@example.com");

      await act(async () => {
        root.unmount();
      });
    });
  });
});

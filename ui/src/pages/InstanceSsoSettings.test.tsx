// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstanceSsoSettings as InstanceSsoSettingsPayload } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceSsoSettings } from "./InstanceSsoSettings";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getSso: vi.fn(),
  updateSso: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function defaultSsoSettings(): InstanceSsoSettingsPayload {
  return {
    enabled: false,
    providers: [],
    allowedEmailDomains: [],
    disablePasswordAuth: false,
  };
}

const TOGGLE_SSO_SELECTOR = 'button[aria-label="Toggle SSO"]';
const DISABLE_PASSWORD_AUTH_SELECTOR = 'button[aria-label="Disable password authentication"]';

describe("InstanceSsoSettings", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let currentSsoSettings: InstanceSsoSettingsPayload;

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <InstanceSsoSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentSsoSettings = defaultSsoSettings();
    mockInstanceSettingsApi.getSso.mockImplementation(async () => ({ ...currentSsoSettings }));
    mockInstanceSettingsApi.updateSso.mockImplementation(async (patch) => {
      currentSsoSettings = { ...currentSsoSettings, ...patch };
      return { ...currentSsoSettings };
    });
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  function getAddProviderButton() {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add SSO Provider",
    );
  }

  function getSaveButton() {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.trim().startsWith("Save SSO Settings"),
    );
  }

  async function enableSso() {
    const toggle = container.querySelector<HTMLButtonElement>(TOGGLE_SSO_SELECTOR);
    await act(() => toggle?.click());
    await flushReact();
  }

  async function addProvider() {
    await act(() => getAddProviderButton()?.click());
    await flushReact();
  }

  // --- lockout guard -------------------------------------------------------

  it("disables the save button and explains the lockout when disabling password auth with no working provider", async () => {
    await renderPage();

    const disablePasswordAuthToggle = container.querySelector<HTMLButtonElement>(
      DISABLE_PASSWORD_AUTH_SELECTOR,
    );
    expect(disablePasswordAuthToggle?.getAttribute("aria-checked")).toBe("false");

    await act(() => disablePasswordAuthToggle?.click());
    await flushReact();

    expect(disablePasswordAuthToggle?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain(
      "Disabling password auth requires SSO to be enabled with at least one provider configured",
    );

    const saveButton = getSaveButton();
    expect(saveButton?.disabled).toBe(true);

    // Even a click on a disabled button must not reach the mutation --
    // this is the guard the server-side assertSsoSettingsNotLockedOut check
    // backs up, and the whole point of surfacing it here is so a save can
    // never actually leave the instance with no way to log in.
    await act(() => saveButton?.click());
    await flushReact();
    expect(mockInstanceSettingsApi.updateSso).not.toHaveBeenCalled();
  });

  it("re-enables save once SSO is on with a fully-filled-in provider", async () => {
    await renderPage();

    const disablePasswordAuthToggle = container.querySelector<HTMLButtonElement>(
      DISABLE_PASSWORD_AUTH_SELECTOR,
    );
    await act(() => disablePasswordAuthToggle?.click());
    await flushReact();
    expect(getSaveButton()?.disabled).toBe(true);

    await enableSso();
    await addProvider();

    // Provider still has empty clientId/clientSecret -- still locked out.
    expect(getSaveButton()?.disabled).toBe(true);

    const clientIdInput = container.querySelector<HTMLInputElement>('input[placeholder="my-app-client-id"]');
    const clientSecretInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    await act(() => {
      setNativeValue(clientIdInput!, "client-123");
      setNativeValue(clientSecretInput!, "secret-123");
    });
    await flushReact();

    expect(getSaveButton()?.disabled).toBe(false);
    expect(container.textContent).not.toContain("Disabling password auth requires SSO to be enabled");
  });

  // --- provider-type defaulting ---------------------------------------------

  it("defaults a newly added provider to Keycloak with the Keycloak-specific fields", async () => {
    await renderPage();
    await enableSso();
    await addProvider();

    expect(container.textContent).toContain("Provider 1: Keycloak");

    const typeSelect = container.querySelector<HTMLSelectElement>("select");
    expect(typeSelect?.value).toBe("keycloak");

    const providerIdInput = [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.value === "keycloak",
    );
    expect(providerIdInput).toBeDefined();

    // Keycloak needs an issuer URL, not a tenant ID or a discovery URL.
    expect(container.textContent).toContain("Issuer URL");
    expect(container.textContent).not.toContain("Tenant ID");
    expect(container.textContent).not.toContain("Discovery URL");
  });

  it("swaps in the Microsoft Entra ID fields (and re-defaults the provider id) when the type changes", async () => {
    await renderPage();
    await enableSso();
    await addProvider();

    const typeSelect = container.querySelector<HTMLSelectElement>("select");
    await act(() => setSelectValue(typeSelect!, "microsoft_entra_id"));
    await flushReact();

    expect(container.textContent).toContain("Provider 1: Microsoft Entra ID");
    // providerId tracked the type change because it still matched the prior
    // type's auto-generated default (providerIdFromType) rather than a
    // custom value the user had typed in.
    const providerIdInput = [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.value === "microsoft-entra-id",
    );
    expect(providerIdInput).toBeDefined();
    expect(container.textContent).toContain("Tenant ID");
    expect(container.textContent).not.toContain("Issuer URL");
  });

  it("shows the discovery URL field only for the generic OIDC provider type", async () => {
    await renderPage();
    await enableSso();
    await addProvider();

    const typeSelect = container.querySelector<HTMLSelectElement>("select");
    await act(() => setSelectValue(typeSelect!, "oidc"));
    await flushReact();

    expect(container.textContent).toContain("Discovery URL");
    expect(container.textContent).not.toContain("Issuer URL");
    expect(container.textContent).not.toContain("Tenant ID");
  });

  // --- round-trip through the save mutation ---------------------------------

  it("round-trips allowedEmailDomains and disablePasswordAuth through the save mutation", async () => {
    await renderPage();
    await enableSso();
    await addProvider();

    const clientIdInput = container.querySelector<HTMLInputElement>('input[placeholder="my-app-client-id"]');
    const clientSecretInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    await act(() => {
      setNativeValue(clientIdInput!, "client-123");
      setNativeValue(clientSecretInput!, "secret-123");
    });
    await flushReact();

    const domainsTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(() => setNativeValue(domainsTextarea!, "redesignhealth.com, partner.example"));
    await flushReact();

    const disablePasswordAuthToggle = container.querySelector<HTMLButtonElement>(
      DISABLE_PASSWORD_AUTH_SELECTOR,
    );
    await act(() => disablePasswordAuthToggle?.click());
    await flushReact();

    const saveButton = getSaveButton();
    expect(saveButton?.disabled).toBe(false);

    await act(() => saveButton?.click());
    await flushReact();

    expect(mockInstanceSettingsApi.updateSso).toHaveBeenCalledWith({
      enabled: true,
      providers: [
        expect.objectContaining({
          providerId: "keycloak",
          type: "keycloak",
          clientId: "client-123",
          clientSecret: "secret-123",
        }),
      ],
      allowedEmailDomains: ["redesignhealth.com", "partner.example"],
      disablePasswordAuth: true,
    });
  });

  it("loads existing allowedEmailDomains and disablePasswordAuth from the server into the form", async () => {
    currentSsoSettings = {
      enabled: true,
      providers: [
        {
          providerId: "okta",
          type: "okta",
          clientId: "existing-client",
          clientSecret: "existing-secret",
          issuer: "https://dev-1.okta.com",
        },
      ],
      allowedEmailDomains: ["redesignhealth.com"],
      disablePasswordAuth: true,
    };
    await renderPage();

    const domainsTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(domainsTextarea?.value).toBe("redesignhealth.com");

    const disablePasswordAuthToggle = container.querySelector<HTMLButtonElement>(
      DISABLE_PASSWORD_AUTH_SELECTOR,
    );
    expect(disablePasswordAuthToggle?.getAttribute("aria-checked")).toBe("true");
  });
});

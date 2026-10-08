import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type Page } from "@playwright/test";

const BASE = process.env.PAPERCLIP_E2E_BASE_URL ?? "http://127.0.0.1:3105";
const DATA_DIR = process.env.PAPERCLIP_E2E_DATA_DIR ?? process.env.PAPERCLIP_HOME;
const CONFIG_PATH = process.env.PAPERCLIP_E2E_CONFIG_PATH ?? path.resolve(process.cwd(), ".paperclip/config.json");
const BOOTSTRAP_SCRIPT_PATH = path.resolve(process.cwd(), "packages/db/scripts/create-auth-bootstrap-invite.ts");
const OWNER_PASSWORD = "paperclip-owner-password";
const INVITED_PASSWORD = "paperclip-invited-password";

type HumanUser = {
  name: string;
  email: string;
  password: string;
};

type CompanySummary = {
  id: string;
  name: string;
  issuePrefix?: string | null;
};

type CompanyMember = {
  id: string;
  membershipRole: "owner" | "admin" | "operator" | "viewer";
  status: "pending" | "active" | "suspended";
  user: { id: string; email: string | null; name: string | null } | null;
};

type SessionJsonResponse<T> = {
  ok: boolean;
  status: number;
  text: string;
  json: T | null;
};

const runId = Date.now();
const companyName = `MU-Auth-${runId}`;
const ownerUser: HumanUser = {
  name: "Owner User",
  email: `owner-${runId}@paperclip.local`,
  password: OWNER_PASSWORD,
};
const invitedUser: HumanUser = {
  name: "Invited User",
  email: `invitee-${runId}@paperclip.local`,
  password: INVITED_PASSWORD,
};

function createBootstrapInvite() {
  if (!DATA_DIR) {
    throw new Error("PAPERCLIP_E2E_DATA_DIR or PAPERCLIP_HOME is required for authenticated bootstrap tests");
  }
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Authenticated bootstrap config not found at ${CONFIG_PATH}`);
  }
  if (!existsSync(BOOTSTRAP_SCRIPT_PATH)) {
    throw new Error(`Authenticated bootstrap helper not found at ${BOOTSTRAP_SCRIPT_PATH}`);
  }

  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return execFileSync(
    pnpmCommand,
    [
      "--filter",
      "@paperclipai/db",
      "exec",
      "tsx",
      BOOTSTRAP_SCRIPT_PATH,
      "--config",
      CONFIG_PATH,
      "--base-url",
      BASE,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        PAPERCLIP_HOME: DATA_DIR,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  ).trim();
}

async function signUp(page: Page, user: HumanUser) {
  await page.goto(`${BASE}/auth`);
  await expect(page.getByRole("heading", { name: "Sign in to Paperclip" })).toBeVisible();
  await page.getByRole("button", { name: "Create one" }).click();
  await expect(page.getByRole("heading", { name: "Create your Paperclip account" })).toBeVisible();
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function acceptBootstrapInvite(page: Page, inviteUrl: string) {
  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: "Bootstrap your Paperclip instance" })).toBeVisible();
  await page.getByRole("button", { name: "Accept bootstrap invite" }).click();
  await expect(page.getByRole("heading", { name: "Bootstrap complete" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("link", { name: "Open board" }).click();
}

async function createCompanyForSession(page: Page, nextCompanyName: string) {
  const createRes = await sessionJsonRequest<CompanySummary>(page, `${BASE}/api/companies`, {
    method: "POST",
    data: { name: nextCompanyName },
  });
  expect(createRes.ok).toBe(true);
  expect(createRes.json).toBeTruthy();
  return createRes.json!;
}

async function createAuthenticatedInvite(page: Page, companyPrefix: string) {
  await page.goto(`${BASE}/${companyPrefix}/company/settings`);
  await expect(page.getByTestId("company-settings-invites-section")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("company-settings-human-invite-role").selectOption("operator");
  await page.getByTestId("company-settings-create-human-invite").click();
  const inviteField = page.getByTestId("company-settings-human-invite-url");
  await expect(inviteField).toBeVisible({ timeout: 20_000 });
  return (await inviteField.inputValue()).trim();
}

async function signUpFromInvite(page: Page, inviteUrl: string, user: HumanUser) {
  await page.goto(inviteUrl);
  await expect(page.getByText("Sign in or create an account before submitting a human join request.")).toBeVisible();
  await page.getByRole("link", { name: "Sign in / Create account" }).click();
  await expect(page).toHaveURL(/\/auth\?next=/);
  await expect(page.getByRole("heading", { name: "Sign in to Paperclip" })).toBeVisible();
  await page.getByRole("button", { name: "Create one" }).click();
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(new RegExp(`/invite/[^/]+$`), { timeout: 20_000 });
}

async function acceptHumanInvite(page: Page) {
  await expect(page.getByRole("button", { name: "Join company" })).toBeEnabled();
  await page.getByRole("button", { name: "Join company" }).click();
  await expect(page.getByRole("heading", { name: "You joined the company" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("link", { name: "Open board" }).click();
}

async function sessionJsonRequest<T>(
  page: Page,
  url: string,
  options: {
    method?: string;
    data?: unknown;
  } = {}
) {
  return page.evaluate(
    async ({ url: targetUrl, method, data }) => {
      const response = await fetch(targetUrl, {
        method,
        credentials: "include",
        headers: data === undefined ? undefined : { "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await response.text();
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        text,
        json,
      };
    },
    {
      url,
      method: options.method ?? "GET",
      data: options.data,
    }
  ) as Promise<SessionJsonResponse<T>>;
}

async function waitForMember(page: Page, companyId: string, email: string) {
  let member: CompanyMember | null = null;
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        member = body.members.find((entry) => entry.user?.email === email) ?? null;
        return member;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      status: "active",
      membershipRole: "operator",
      user: { email },
    });
  return member!;
}

async function waitForMemberRole(
  page: Page,
  companyId: string,
  memberId: string,
  membershipRole: CompanyMember["membershipRole"]
) {
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        return body.members.find((member) => member.id === memberId) ?? null;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      id: memberId,
      membershipRole,
    });
}

async function newPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/**
 * Like `waitForMember`, but pins the expected membership role — the TECH-7325
 * peer joins through an owner-role invite, so "operator" must not be assumed.
 */
async function waitForMemberWithRole(
  page: Page,
  companyId: string,
  email: string,
  membershipRole: CompanyMember["membershipRole"]
) {
  let member: CompanyMember | null = null;
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        member = body.members.find((entry) => entry.user?.email === email) ?? null;
        return member;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      status: "active",
      membershipRole,
      user: { email },
    });
  return member!;
}

test.describe("Multi-user: authenticated mode", () => {
  test("authenticated humans can bootstrap, invite, join, and respect viewer restrictions", async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);

    const healthRes = await page.request.get(`${BASE}/api/health`);
    expect(healthRes.ok()).toBe(true);
    const health = (await healthRes.json()) as {
      deploymentMode?: string;
      bootstrapStatus?: string;
    };
    expect(health.deploymentMode).toBe("authenticated");

    await signUp(page, ownerUser);
    await acceptBootstrapInvite(page, createBootstrapInvite());

    const company = await createCompanyForSession(page, companyName);
    const companyPrefix = company.issuePrefix ?? company.id;
    await page.goto(`${BASE}/${companyPrefix}/dashboard`);
    await expect(page.getByTestId("layout-account-menu-trigger")).toContainText(ownerUser.name);
    await page.getByTestId("layout-account-menu-trigger").click();
    await expect(page.getByText(ownerUser.email)).toBeVisible();
    const inviteUrl = await createAuthenticatedInvite(page, companyPrefix);

    const invited = await newPage(browser);
    try {
      await signUpFromInvite(invited.page, inviteUrl, invitedUser);
      await acceptHumanInvite(invited.page);
      await expect(invited.page).not.toHaveURL(/\/auth/, { timeout: 10_000 });

      const joinedMember = await waitForMember(page, company.id, invitedUser.email);

      await page.goto(`${BASE}/${companyPrefix}/company/settings`);
      const roleSelect = page.getByTestId(`company-settings-member-role-${joinedMember.id}`);
      await expect(roleSelect).toBeVisible({ timeout: 20_000 });
      await roleSelect.selectOption("viewer");
      await expect(roleSelect).toHaveValue("viewer");
      await waitForMemberRole(page, company.id, joinedMember.id, "viewer");

      await invited.page.goto(`${BASE}/${companyPrefix}/company/settings`);
      await expect(
        invited.page.getByText("Your current company role cannot create human invites.")
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        invited.page.getByTestId("company-settings-create-human-invite")
      ).toHaveCount(0);

      const forbiddenInviteRes = await sessionJsonRequest(
        invited.page,
        `${BASE}/api/companies/${company.id}/invites`,
        {
          method: "POST",
          data: {
            allowedJoinTypes: "human",
            humanRole: "viewer",
          },
        }
      );
      expect(forbiddenInviteRes.status).toBe(403);
    } finally {
      await invited.context.close();
    }
  });
});


test("agent chats keep personal identity and ordinary company visibility", async ({ browser, page }) => {
  test.setTimeout(120_000);
  expect((await (await page.request.get(`${BASE}/api/health`)).json()).deploymentMode).toBe("authenticated");
  await signUp(page, { ...ownerUser, email: `chat-${ownerUser.email}` });
  const bootstrapToken = new URL(createBootstrapInvite()).pathname.split("/").at(-1);
  expect((await sessionJsonRequest(page, `${BASE}/api/invites/${bootstrapToken}/accept`, { method: "POST", data: { requestType: "human" } })).ok).toBe(true);
  const company = await createCompanyForSession(page, `Chat identity ${runId}`);
  const companyPrefix = company.issuePrefix ?? company.id;
  const invite = await sessionJsonRequest<{ inviteUrl: string }>(page, `${BASE}/api/companies/${company.id}/invites`, { method: "POST", data: { allowedJoinTypes: "human", humanRole: "operator" } });
  expect(invite.ok).toBe(true);
  const invited = await newPage(browser);
  try {
    await signUp(invited.page, { ...invitedUser, email: `chat-${invitedUser.email}` });
    const inviteToken = new URL(invite.json!.inviteUrl, BASE).pathname.split("/").at(-1);
    const joined = await sessionJsonRequest(invited.page, `${BASE}/api/invites/${inviteToken}/accept`, { method: "POST", data: { requestType: "human" } });
    expect(joined.ok).toBe(true);
      // Persistent chats are personal identities, not private messaging.
      const originalFlags = await sessionJsonRequest<Record<string, boolean>>(page, `${BASE}/api/instance/settings/experimental`);
      const enable = await sessionJsonRequest(page, `${BASE}/api/instance/settings/experimental`, { method: "PATCH", data: { enableAgentChat: true } });
      expect(enable.ok).toBe(true);
      try {
        const createdAgent = await sessionJsonRequest<{ id: string }>(page, `${BASE}/api/companies/${company.id}/agents`, { method: "POST", data: {
          name: "Personal chat identity", adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
          runtimeConfig: { heartbeat: { enabled: false } },
        } });
        expect(createdAgent.ok).toBe(true);
        const agentId = createdAgent.json!.id;
        const chatEndpoint = `${BASE}/api/companies/${company.id}/chats/${agentId}`;
        await page.goto(`${BASE}/${companyPrefix}/chats/${agentId}`);
        await invited.page.goto(`${BASE}/${companyPrefix}/chats/${agentId}`);
        expect((await sessionJsonRequest(page, chatEndpoint)).json).toBeNull();
        expect((await sessionJsonRequest(invited.page, chatEndpoint)).json).toBeNull();
        const ownerChat = await sessionJsonRequest<{ id: string; conversationUserId: string }>(page, chatEndpoint, { method: "POST", data: {} });
        const memberChat = await sessionJsonRequest<{ id: string; conversationUserId: string }>(invited.page, chatEndpoint, { method: "POST", data: {} });
        expect(ownerChat.ok).toBe(true); expect(memberChat.ok).toBe(true);
        expect(ownerChat.json!.id).not.toBe(memberChat.json!.id);
        expect(ownerChat.json!.conversationUserId).not.toBe(memberChat.json!.conversationUserId);
        expect((await sessionJsonRequest(invited.page, `${BASE}/api/issues/${ownerChat.json!.id}`)).ok).toBe(true);
        expect((await sessionJsonRequest(page, `${BASE}/api/issues/${memberChat.json!.id}`)).ok).toBe(true);
        await page.reload(); await invited.page.reload();
        await page.getByRole("button", { name: "Star Personal chat identity", exact: true }).click();
        await expect(page.getByRole("button", { name: "Unstar Personal chat identity", exact: true })).toBeAttached();
        await expect(invited.page.getByRole("button", { name: "Star Personal chat identity", exact: true })).toBeAttached();
        const ownerRecent = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("paperclip.recentAgentChats:")));
        const memberRecent = await invited.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("paperclip.recentAgentChats:")));
        expect(ownerRecent.some(key => key.endsWith(ownerChat.json!.conversationUserId))).toBe(true);
        expect(memberRecent.some(key => key.endsWith(memberChat.json!.conversationUserId))).toBe(true);
        const another = await createCompanyForSession(page, `Private company ${runId}`);
        const forbidden = await sessionJsonRequest(invited.page, `${BASE}/api/companies/${another.id}/chats/${agentId}`);
        expect([403, 404]).toContain(forbidden.status);
      } finally {
        const restore = await sessionJsonRequest(page, `${BASE}/api/instance/settings/experimental`, { method: "PATCH", data: { enableAgentChat: originalFlags.json!.enableAgentChat } });
        expect(restore.ok).toBe(true);
      }
  } finally { await invited.context.close(); }
});

/**
 * TECH-7325 focused scenario: an authenticated instance admin who owns a
 * company can leave it themselves from the members UI, while every other
 * protection stays in place. Setup deliberately uses stable API surfaces
 * (bootstrap/invite create+accept over session cookies — the file's older
 * UI helpers like `acceptBootstrapInvite`/`createAuthenticatedInvite` target
 * invite-landing/settings testids that have since moved); only the
 * self-leave itself and the button-state assertions drive the real members
 * UI. Run scoped:
 *
 *   pnpm test:e2e:multiuser-authenticated --grep "self-leaves"
 *
 * against a fresh disposable authenticated instance (see the qualification
 * notes in the PR) — the bootstrap claim below must be the instance's first,
 * exactly like the other tests in this file.
 */
test("instance admin owner self-leaves their own company from the members UI", async ({ browser, page }) => {
  test.setTimeout(180_000);

  expect((await (await page.request.get(`${BASE}/api/health`)).json()).deploymentMode).toBe("authenticated");

  const selfLeaveAdmin: HumanUser = {
    name: "Selfleave Admin",
    email: `selfleave-admin-${runId}@paperclip.local`,
    password: OWNER_PASSWORD,
  };
  const peerOwner: HumanUser = {
    name: "Selfleave Peer",
    email: `selfleave-peer-${runId}@paperclip.local`,
    password: INVITED_PASSWORD,
  };

  // First signer-upper claims the bootstrap invite over the API and becomes the instance admin.
  await signUp(page, selfLeaveAdmin);
  const bootstrapToken = new URL(createBootstrapInvite()).pathname.split("/").at(-1);
  const bootstrapAccept = await sessionJsonRequest(
    page,
    `${BASE}/api/invites/${bootstrapToken}/accept`,
    { method: "POST", data: { requestType: "human" } }
  );
  expect(bootstrapAccept.ok, JSON.stringify(bootstrapAccept)).toBe(true);

  const company = await createCompanyForSession(page, `Selfleave-${runId}`);
  const companyPrefix = company.issuePrefix ?? company.id;

  // Sole active owner: the UI must keep the instance admin's own Remove button
  // disabled with the last-owner reason — the self-leave exception never
  // overrides the last-active-owner guard.
  await page.goto(`${BASE}/${companyPrefix}/company/settings/members`);
  const soleOwnerRemove = page
    .getByRole("row")
    .filter({ hasText: selfLeaveAdmin.email })
    .getByRole("button", { name: "Remove" });
  await expect(soleOwnerRemove).toBeVisible();
  await expect(soleOwnerRemove).toBeDisabled();
  await expect(soleOwnerRemove).toHaveAttribute("title", "Cannot remove the last active owner.");

  // A second ordinary user joins through an owner-role human invite (the accept
  // flow seeds the owner role grants, unlike a post-hoc role PATCH) and lands
  // as an ACTIVE owner, leaving two owners in the company.
  const inviteRes = await sessionJsonRequest<{ inviteUrl: string }>(
    page,
    `${BASE}/api/companies/${company.id}/invites`,
    { method: "POST", data: { allowedJoinTypes: "human", humanRole: "owner" } }
  );
  expect(inviteRes.ok, JSON.stringify(inviteRes)).toBe(true);
  const inviteToken = new URL(inviteRes.json!.inviteUrl, BASE).pathname.split("/").at(-1);
  const peer = await newPage(browser);
  try {
    await signUp(peer.page, peerOwner);
    const joined = await sessionJsonRequest(
      peer.page,
      `${BASE}/api/invites/${inviteToken}/accept`,
      { method: "POST", data: { requestType: "human" } }
    );
    expect(joined.ok, JSON.stringify(joined)).toBe(true);
    await waitForMemberWithRole(page, company.id, peerOwner.email, "owner");

    // Peer owner view: the instance admin's row is protected — the peer cannot
    // remove them even though owner-vs-owner removal would otherwise be allowed.
    await peer.page.goto(`${BASE}/${companyPrefix}/company/settings/members`);
    const adminRowAsPeer = peer.page
      .getByRole("row")
      .filter({ hasText: selfLeaveAdmin.email })
      .getByRole("button", { name: "Remove" });
    await expect(adminRowAsPeer).toBeVisible();
    await expect(adminRowAsPeer).toBeDisabled();
    await expect(adminRowAsPeer).toHaveAttribute(
      "title",
      "Instance admins cannot be removed from company access."
    );

    // Admin view with two owners: the own-row Remove button is now enabled.
    await page.goto(`${BASE}/${companyPrefix}/company/settings/members`);
    const ownRemove = page
      .getByRole("row")
      .filter({ hasText: selfLeaveAdmin.email })
      .getByRole("button", { name: "Remove" });
    await expect(ownRemove).toBeEnabled();
    await ownRemove.click();

    // The Remove dialog carries the self-removal warning before the destructive confirm.
    await expect(page.getByText("You are removing your own access")).toBeVisible();
    await page.getByRole("button", { name: "Remove member", exact: true }).click();

    // The account drops the company and lands on the company-less root flow:
    // with zero accessible companies, "/" redirects into /onboarding.
    await expect(page).toHaveURL(/\/onboarding\/?$/, { timeout: 20_000 });

    // The company switcher's data source no longer offers the removed company.
    const accessible = await sessionJsonRequest<Array<{ id: string }>>(
      page,
      `${BASE}/api/companies?scope=accessible`
    );
    expect(accessible.ok).toBe(true);
    expect(accessible.json!.some((entry) => entry.id === company.id)).toBe(false);

    // Direct member access is gone (403) while the global instance-admin role persists.
    const membersRes = await sessionJsonRequest(
      page,
      `${BASE}/api/companies/${company.id}/members`
    );
    expect(membersRes.status).toBe(403);
    const meRes = await sessionJsonRequest<{
      userId: string;
      isInstanceAdmin: boolean;
      companyIds: string[];
    }>(page, `${BASE}/api/cli-auth/me`);
    expect(meRes.ok, JSON.stringify(meRes)).toBe(true);
    expect(meRes.json!.isInstanceAdmin).toBe(true);
    expect(meRes.json!.companyIds).not.toContain(company.id);

    // The admin's own membership row is archived (not deleted), still visible
    // through the instance-admin company-access surface with the role intact.
    const ownAccess = await sessionJsonRequest<{
      user: { isInstanceAdmin: boolean } | null;
      companyAccess: Array<{ companyId: string; status: string }>;
    }>(page, `${BASE}/api/admin/users/${meRes.json!.userId}/company-access`);
    expect(ownAccess.ok, JSON.stringify(ownAccess)).toBe(true);
    expect(ownAccess.json!.user?.isInstanceAdmin).toBe(true);
    expect(ownAccess.json!.companyAccess.find((row) => row.companyId === company.id)?.status).toBe(
      "archived"
    );

    // The peer owner keeps the company and no longer sees the archived admin in members.
    const peerMembers = await sessionJsonRequest<{ members: CompanyMember[] }>(
      peer.page,
      `${BASE}/api/companies/${company.id}/members`
    );
    expect(peerMembers.ok, JSON.stringify(peerMembers)).toBe(true);
    expect(peerMembers.json!.members.some((member) => member.user?.email === selfLeaveAdmin.email)).toBe(false);
    expect(
      peerMembers.json!.members.some(
        (member) => member.user?.email === peerOwner.email && member.membershipRole === "owner"
      )
    ).toBe(true);
  } finally {
    await peer.context.close();
  }
});

import { describe, expect, it, vi } from "vitest";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import {
  applyExperimentalSettingsPatch,
  assertSsoSettingsNotLockedOut,
  instanceSettingsService,
  normalizeExperimentalSettings,
  normalizeSsoSettings,
  resolveWorktreeRunExecutionActivationState,
} from "../services/instance-settings.js";

describe("instance settings service", () => {
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      enableBuiltInAgents: true,
      enableGoalsSidebarLink: true,
      enableServerInfoDebugView: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: true,
      enableApps: false,
      enableConferenceRoomChat: false,
      enableExternalObjects: false,
      enableSmokeLab: false,
      enablePipelines: false,
      enableCases: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      enableSmokeLab: false,
      enableBuiltInAgents: true,
      enableSummaries: false,
      enableDecisions: false,
      enableGoalsSidebarLink: true,
      enableServerInfoDebugView: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: false,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
    });
  });

  it("defaults enableApps to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableApps).toBe(false);
    expect(normalizeExperimentalSettings({}).enableApps).toBe(false);
    expect(normalizeExperimentalSettings({ enablePipelines: true }).enableApps).toBe(false);
  });

  it("defaults enableConferenceRoomChat to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableConferenceRoomChat).toBe(false);
    expect(normalizeExperimentalSettings({}).enableConferenceRoomChat).toBe(false);
    // Rows persisted before the flag existed (PAP-137) must normalize to off.
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("defaults enableTaskWatchdogs to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableTaskWatchdogs).toBe(false);
    expect(normalizeExperimentalSettings({}).enableTaskWatchdogs).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableExperimentalFileViewer: true }).enableTaskWatchdogs,
    ).toBe(false);
  });

  it("defaults enableSmokeLab to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableSmokeLab).toBe(false);
    expect(normalizeExperimentalSettings({}).enableSmokeLab).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableExternalObjects: true }).enableSmokeLab,
    ).toBe(false);
  });

  it("defaults enableServerInfoDebugView to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableServerInfoDebugView).toBe(false);
    expect(normalizeExperimentalSettings({}).enableServerInfoDebugView).toBe(false);
    expect(
      normalizeExperimentalSettings({ autoRestartDevServerWhenIdle: true }).enableServerInfoDebugView,
    ).toBe(false);
  });

  it("defaults enableGoalsSidebarLink to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableGoalsSidebarLink).toBe(false);
    expect(normalizeExperimentalSettings({}).enableGoalsSidebarLink).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableGoalsSidebarLink,
    ).toBe(false);
  });

  it("defaults enableDecisions to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableDecisions).toBe(false);
    expect(normalizeExperimentalSettings({}).enableDecisions).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableDecisions,
    ).toBe(false);
  });

  it("defaults workspace branch repair settings to true for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableWorkspaceBranchReconcileForward).toBe(true);
    expect(normalizeExperimentalSettings({}).enableWorkspaceBranchReconcileForward).toBe(true);
    expect(
      normalizeExperimentalSettings({ enableIssueGraphLivenessAutoRecovery: true })
        .enableWorkspaceBranchReconcileForward,
    ).toBe(true);
    expect(normalizeExperimentalSettings(undefined).enableWorkspaceDirtyQuarantineRepair).toBe(true);
    expect(normalizeExperimentalSettings({}).enableWorkspaceDirtyQuarantineRepair).toBe(true);
    expect(
      normalizeExperimentalSettings({ enableWorkspaceBranchReconcileForward: false })
        .enableWorkspaceDirtyQuarantineRepair,
    ).toBe(true);
  });

  it("round-trips an enableConferenceRoomChat patch through the update merge", () => {
    // updateExperimental merges `{ ...normalize(current), ...patch }` and
    // re-normalizes; emulate that to prove the flag survives the roundtrip
    // without disturbing other settings.
    const current = normalizeExperimentalSettings({});
    const enabled = normalizeExperimentalSettings({ ...current, enableConferenceRoomChat: true });
    expect(enabled.enableConferenceRoomChat).toBe(true);
    expect(enabled.enableStreamlinedLeftNavigation).toBe(true);

    const disabled = normalizeExperimentalSettings({ ...enabled, enableConferenceRoomChat: false });
    expect(disabled).toEqual(current);
  });

  it("rejects non-boolean enableConferenceRoomChat values back to the default", () => {
    expect(
      normalizeExperimentalSettings({ enableConferenceRoomChat: "yes" }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("defaults enableBuiltInAgents to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableBuiltInAgents).toBe(false);
    expect(normalizeExperimentalSettings({}).enableBuiltInAgents).toBe(false);
    expect(normalizeExperimentalSettings({ enableExternalObjects: true }).enableBuiltInAgents).toBe(false);
  });

  it("sets worktree run execution activation fields on a false to true transition", () => {
    const activatedAt = new Date("2026-07-10T12:00:00.000Z");

    const next = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      { enableWorktreeRunExecution: true },
      {
        now: () => activatedAt,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.enableWorktreeRunExecution).toBe(true);
    expect(next.worktreeRunExecutionActivatedAt).toBe("2026-07-10T12:00:00.000Z");
    expect(next.worktreeRunExecutionActivationInstanceId).toBe("worktree-instance");
  });

  it("clears worktree run execution activation fields on a true to false transition", () => {
    const next = applyExperimentalSettingsPatch(
      {
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "worktree-instance",
      },
      { enableWorktreeRunExecution: false },
      {
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.enableWorktreeRunExecution).toBe(false);
    expect(next.worktreeRunExecutionActivatedAt).toBeNull();
    expect(next.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("refreshes the activation cutoff when worktree run execution is re-toggled", () => {
    const firstActivation = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      { enableWorktreeRunExecution: true },
      {
        now: () => new Date("2026-07-10T12:00:00.000Z"),
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );
    const disabled = applyExperimentalSettingsPatch(
      firstActivation,
      { enableWorktreeRunExecution: false },
      {
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    const secondActivation = applyExperimentalSettingsPatch(
      disabled,
      { enableWorktreeRunExecution: true },
      {
        now: () => new Date("2026-07-10T12:05:00.000Z"),
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(secondActivation.worktreeRunExecutionActivatedAt).toBe("2026-07-10T12:05:00.000Z");
    expect(secondActivation.worktreeRunExecutionActivatedAt).not.toBe(
      firstActivation.worktreeRunExecutionActivatedAt,
    );
  });

  it("strips client-supplied activation fields before applying experimental patches", () => {
    const next = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      {
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "copied-instance",
      },
      {
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.worktreeRunExecutionActivatedAt).toBeNull();
    expect(next.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("resolves worktree run execution as armed only when the cutoff matches the current instance", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "worktree-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toEqual({
      armed: true,
      cutoff: "2026-07-10T12:00:00.000Z",
      activationInstanceId: "worktree-instance",
      reason: null,
    });
  });

  it("fails closed when worktree run execution is missing a cutoff", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivationInstanceId: "worktree-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "missing_cutoff",
    });
  });

  it("fails closed when worktree run execution was activated by another instance", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "source-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "target-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      activationInstanceId: "source-instance",
      reason: "instance_id_mismatch",
    });
  });

  it("fails closed on settings read errors and avoids reads outside worktree runtimes", async () => {
    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => {
          throw new Error("settings unavailable");
        },
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "settings_read_error",
    });

    const getExperimental = vi.fn<() => Promise<InstanceExperimentalSettings>>();
    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "false",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "not_worktree_runtime",
    });
    expect(getExperimental).not.toHaveBeenCalled();
  });

});

describe("SSO settings normalization and lockout guard (TECH-4916)", () => {
  it("defaults allowedEmailDomains and disablePasswordAuth for empty/legacy stored settings", () => {
    expect(normalizeSsoSettings(undefined)).toEqual({
      enabled: false,
      providers: [],
      allowedEmailDomains: [],
      disablePasswordAuth: false,
    });
    expect(normalizeSsoSettings({})).toEqual({
      enabled: false,
      providers: [],
      allowedEmailDomains: [],
      disablePasswordAuth: false,
    });
  });

  it("normalizes and lowercases allowedEmailDomains", () => {
    expect(
      normalizeSsoSettings({ allowedEmailDomains: ["RedesignHealth.com", " partner.example "] })
        .allowedEmailDomains,
    ).toEqual(["redesignhealth.com", "partner.example"]);
  });

  it("allows disablePasswordAuth=false regardless of provider configuration", () => {
    expect(() =>
      assertSsoSettingsNotLockedOut({
        enabled: false,
        providers: [],
        allowedEmailDomains: [],
        disablePasswordAuth: false,
      }),
    ).not.toThrow();
  });

  it("rejects disablePasswordAuth=true when SSO is not enabled with a configured provider", () => {
    expect(() =>
      assertSsoSettingsNotLockedOut({
        enabled: false,
        providers: [],
        allowedEmailDomains: [],
        disablePasswordAuth: true,
      }),
    ).toThrow(/requires SSO to be enabled/i);

    expect(() =>
      assertSsoSettingsNotLockedOut({
        enabled: true,
        providers: [],
        allowedEmailDomains: [],
        disablePasswordAuth: true,
      }),
    ).toThrow(/requires SSO to be enabled/i);
  });

  it("allows disablePasswordAuth=true once SSO is enabled with at least one provider", () => {
    expect(() =>
      assertSsoSettingsNotLockedOut({
        enabled: true,
        providers: [
          {
            providerId: "okta",
            type: "okta",
            clientId: "client",
            clientSecret: "secret",
            issuer: "https://example.okta.com",
          },
        ],
        allowedEmailDomains: [],
        disablePasswordAuth: true,
      }),
    ).not.toThrow();
  });
});

describe("getSsoReadOnly (public sso-providers endpoint, TECH-4916 finding #3)", () => {
  function createSelectOnlyDb(row: unknown | null) {
    const insert = vi.fn(() => {
      throw new Error("getSsoReadOnly must not write the instance_settings row");
    });
    const select = vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(row ? [row] : []),
      }),
    }));
    return { select, insert } as any;
  }

  it("returns default SSO settings without inserting a row when none exists yet", async () => {
    const db = createSelectOnlyDb(null);
    const svc = instanceSettingsService(db);

    const result = await svc.getSsoReadOnly();

    expect(result).toEqual({
      enabled: false,
      providers: [],
      allowedEmailDomains: [],
      disablePasswordAuth: false,
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("reads the existing SSO settings without writing anything", async () => {
    const db = createSelectOnlyDb({
      id: "row-1",
      sso: { enabled: true, disablePasswordAuth: true, allowedEmailDomains: ["redesignhealth.com"] },
    });
    const svc = instanceSettingsService(db);

    const result = await svc.getSsoReadOnly();

    expect(result.enabled).toBe(true);
    expect(result.disablePasswordAuth).toBe(true);
    expect(result.allowedEmailDomains).toEqual(["redesignhealth.com"]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("differs from getSso only in that it never creates the settings row", async () => {
    const db = createSelectOnlyDb(null);
    const svc = instanceSettingsService(db);

    // getSso's getOrCreateRow would call db.insert() when no row exists;
    // confirm that path is reachable on this mock (i.e. the mock isn't
    // accidentally making both methods equivalent) by asserting it throws.
    await expect(svc.getSso()).rejects.toThrow(/must not write/);
  });
});

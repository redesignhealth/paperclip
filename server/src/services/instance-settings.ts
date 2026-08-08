import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
  instanceSsoSettingsSchema,
  type InstanceSsoSettings,
  type PatchInstanceGeneralSettings,
  type InstanceSettings,
  type PatchInstanceSettings,
  type PatchInstanceExperimentalSettings,
  type PatchInstanceSsoSettings,
  type SsoProviderConfig,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_SINGLETON_KEY = "default";
const instanceGeneralSettingsStorageSchema = instanceGeneralSettingsSchema.strip();
const instanceExperimentalSettingsStorageSchema = instanceExperimentalSettingsSchema.strip();
const TRUTHY_RUNTIME_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

interface InstanceSettingsServiceOptions {
  runtimeEnv?: Record<string, string | undefined>;
  now?: () => Date;
}

type WorktreeRunExecutionSuppressedReason =
  | "not_worktree_runtime"
  | "flag_disabled"
  | "missing_cutoff"
  | "missing_instance_id"
  | "instance_id_mismatch"
  | "settings_read_error";

export type WorktreeRunExecutionActivationState =
  | {
      armed: true;
      cutoff: string;
      activationInstanceId: string;
      reason: null;
    }
  | {
      armed: false;
      cutoff: null;
      activationInstanceId: string | null;
      reason: WorktreeRunExecutionSuppressedReason;
    };

export function isTruthyRuntimeEnvValue(value: string | undefined) {
  return typeof value === "string" && TRUTHY_RUNTIME_ENV_VALUES.has(value.trim().toLowerCase());
}

function getRuntimeInstanceId(env: Record<string, string | undefined>) {
  const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim();
  return instanceId ? instanceId : null;
}

function stripServerManagedExperimentalPatchFields(
  patch: PatchInstanceExperimentalSettings | Record<string, unknown>,
): PatchInstanceExperimentalSettings {
  const {
    worktreeRunExecutionActivatedAt: _ignoredActivatedAt,
    worktreeRunExecutionActivationInstanceId: _ignoredActivationInstanceId,
    ...patchable
  } = patch as Record<string, unknown>;
  return patchable as PatchInstanceExperimentalSettings;
}

export function applyExperimentalSettingsPatch(
  current: unknown,
  patch: PatchInstanceExperimentalSettings | Record<string, unknown>,
  options: InstanceSettingsServiceOptions = {},
): InstanceExperimentalSettings {
  const previousExperimental = normalizeExperimentalSettings(current);
  const patchable = stripServerManagedExperimentalPatchFields(patch);
  const nextExperimental = normalizeExperimentalSettings({
    ...previousExperimental,
    ...patchable,
  });
  const hasWorktreeRunExecutionPatch = Object.prototype.hasOwnProperty.call(
    patchable,
    "enableWorktreeRunExecution",
  );

  if (!hasWorktreeRunExecutionPatch) {
    return nextExperimental;
  }

  if (nextExperimental.enableWorktreeRunExecution !== true) {
    return {
      ...nextExperimental,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    };
  }

  if (previousExperimental.enableWorktreeRunExecution === true) {
    return nextExperimental;
  }

  const runtimeEnv = options.runtimeEnv ?? process.env;
  if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
    return nextExperimental;
  }

  return {
    ...nextExperimental,
    worktreeRunExecutionActivatedAt: (options.now ?? (() => new Date()))().toISOString(),
    worktreeRunExecutionActivationInstanceId: getRuntimeInstanceId(runtimeEnv),
  };
}

function suppressWorktreeRunExecution(
  reason: WorktreeRunExecutionSuppressedReason,
  activationInstanceId: string | null = null,
): WorktreeRunExecutionActivationState {
  return {
    armed: false,
    cutoff: null,
    activationInstanceId,
    reason,
  };
}

export function resolveWorktreeRunExecutionActivation(
  experimental: InstanceExperimentalSettings,
  currentInstanceId: string | null | undefined,
): WorktreeRunExecutionActivationState {
  if (experimental.enableWorktreeRunExecution !== true) {
    return suppressWorktreeRunExecution(
      "flag_disabled",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!experimental.worktreeRunExecutionActivatedAt) {
    return suppressWorktreeRunExecution(
      "missing_cutoff",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!currentInstanceId) {
    return suppressWorktreeRunExecution(
      "missing_instance_id",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (experimental.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return suppressWorktreeRunExecution(
      "instance_id_mismatch",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  return {
    armed: true,
    cutoff: experimental.worktreeRunExecutionActivatedAt,
    activationInstanceId: currentInstanceId,
    reason: null,
  };
}

export async function resolveWorktreeRunExecutionActivationState(options: {
  getExperimental: () => Promise<InstanceExperimentalSettings>;
  runtimeEnv?: Record<string, string | undefined>;
}): Promise<WorktreeRunExecutionActivationState> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
    return suppressWorktreeRunExecution("not_worktree_runtime");
  }
  try {
    return resolveWorktreeRunExecutionActivation(
      await options.getExperimental(),
      getRuntimeInstanceId(runtimeEnv),
    );
  } catch {
    return suppressWorktreeRunExecution("settings_read_error");
  }
}

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const parsed = instanceGeneralSettingsStorageSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      keyboardShortcuts: parsed.data.keyboardShortcuts ?? false,
      feedbackDataSharingPreference:
        parsed.data.feedbackDataSharingPreference ?? DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
      backupRetention: parsed.data.backupRetention ?? DEFAULT_BACKUP_RETENTION,
      // Absent => unrestricted; only carry through an explicit policy.
      ...(parsed.data.executionMode ? { executionMode: parsed.data.executionMode } : {}),
    };
  }
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
    backupRetention: DEFAULT_BACKUP_RETENTION,
  };
}

export function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const parsed = instanceExperimentalSettingsStorageSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enableEnvironments: parsed.data.enableEnvironments ?? false,
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? false,
      enableStreamlinedLeftNavigation: parsed.data.enableStreamlinedLeftNavigation ?? true,
      enableApps: parsed.data.enableApps ?? false,
      enablePipelines: parsed.data.enablePipelines ?? false,
      enableCases: parsed.data.enableCases ?? false,
      enableConferenceRoomChat: parsed.data.enableConferenceRoomChat ?? false,
      enableIssuePlanDecompositions: parsed.data.enableIssuePlanDecompositions ?? false,
      enableExperimentalFileViewer: parsed.data.enableExperimentalFileViewer ?? false,
      enableTaskWatchdogs: parsed.data.enableTaskWatchdogs ?? false,
      enableCloudSync: parsed.data.enableCloudSync ?? false,
      enableExternalObjects: parsed.data.enableExternalObjects ?? false,
      enableSmokeLab: parsed.data.enableSmokeLab ?? false,
      enableBuiltInAgents: parsed.data.enableBuiltInAgents ?? false,
      enableSummaries: parsed.data.enableSummaries ?? false,
      enableDecisions: parsed.data.enableDecisions ?? false,
      enableGoalsSidebarLink: parsed.data.enableGoalsSidebarLink ?? false,
      enableServerInfoDebugView: parsed.data.enableServerInfoDebugView ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      enableIssueGraphLivenessAutoRecovery: parsed.data.enableIssueGraphLivenessAutoRecovery ?? false,
      enableWorkspaceBranchReconcileForward: parsed.data.enableWorkspaceBranchReconcileForward ?? true,
      enableWorkspaceDirtyQuarantineRepair: parsed.data.enableWorkspaceDirtyQuarantineRepair ?? true,
      enableWorktreeRunExecution: parsed.data.enableWorktreeRunExecution ?? false,
      worktreeRunExecutionActivatedAt: parsed.data.worktreeRunExecutionActivatedAt ?? null,
      worktreeRunExecutionActivationInstanceId:
        parsed.data.worktreeRunExecutionActivationInstanceId ?? null,
      issueGraphLivenessAutoRecoveryLookbackHours:
        parsed.data.issueGraphLivenessAutoRecoveryLookbackHours ??
        DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
    };
  }
  return {
    enableEnvironments: false,
    enableIsolatedWorkspaces: false,
    enableStreamlinedLeftNavigation: true,
    enableApps: false,
    enablePipelines: false,
    enableCases: false,
    enableConferenceRoomChat: false,
    enableTaskWatchdogs: false,
    enableIssuePlanDecompositions: false,
    enableExperimentalFileViewer: false,
    enableCloudSync: false,
    enableExternalObjects: false,
    enableSmokeLab: false,
    enableBuiltInAgents: false,
    enableSummaries: false,
    enableDecisions: false,
    enableGoalsSidebarLink: false,
    enableServerInfoDebugView: false,
    autoRestartDevServerWhenIdle: false,
    enableIssueGraphLivenessAutoRecovery: false,
    enableWorkspaceBranchReconcileForward: true,
    enableWorkspaceDirtyQuarantineRepair: true,
    enableWorktreeRunExecution: false,
    worktreeRunExecutionActivatedAt: null,
    worktreeRunExecutionActivationInstanceId: null,
    issueGraphLivenessAutoRecoveryLookbackHours:
      DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  };
}

// Thrown by normalizeSsoSettings when the stored `sso` JSONB fails schema
// validation. Named so callers (and boot-time crash logs) can tell "the auth
// config itself is untrustworthy" apart from ordinary validation errors.
export class SsoSettingsCorruptError extends Error {
  constructor(issues: string) {
    super(
      `Stored instance SSO settings failed validation and cannot be trusted (${issues}). ` +
        "Refusing to fall back to defaults here: doing so would silently disable SSO, " +
        "clear the email-domain allowlist, and re-enable password auth all at once -- " +
        "i.e. fail *open* on two security controls at the exact moment the instance's " +
        "auth config is unknown. An instance that cannot parse its own auth config should " +
        "not guess at a safe state and should not serve traffic. Fix or clear the `sso` " +
        "column on the instance_settings row (or restore it from backup) to recover.",
    );
    this.name = "SsoSettingsCorruptError";
  }
}

export function normalizeSsoSettings(raw: unknown): InstanceSsoSettings {
  const parsed = instanceSsoSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enabled: parsed.data.enabled ?? false,
      providers: parsed.data.providers ?? [],
      allowedEmailDomains: parsed.data.allowedEmailDomains ?? [],
      disablePasswordAuth: parsed.data.disablePasswordAuth ?? false,
    };
  }
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  // Loud on purpose (see SsoSettingsCorruptError): a malformed stored value
  // here previously produced a *quiet* all-defaults instance -- SSO off,
  // allowlist empty, password auth on -- which is the same shape as a
  // perfectly healthy "SSO not configured" instance. That made a corrupted
  // security config indistinguishable from an intentionally open one both in
  // logs and in the UI. Every caller (boot, the instance-settings routes,
  // and the public sso-providers probe) now has to explicitly decide how to
  // react to this error instead of unknowingly inheriting an open instance.
  logger.error({ issues }, "Stored instance SSO settings failed validation; refusing to use defaults");
  throw new SsoSettingsCorruptError(issues);
}

// Guards against an instance-bricking config: disablePasswordAuth can only be
// set while SSO is enabled with at least one provider configured, otherwise
// there would be no way for anyone to log in at all. Fails closed: reject the
// write rather than silently coercing it.
export function assertSsoSettingsNotLockedOut(next: InstanceSsoSettings): void {
  if (!next.disablePasswordAuth) return;
  if (next.enabled && next.providers.length > 0) return;
  throw badRequest(
    "disablePasswordAuth requires SSO to be enabled with at least one provider configured — " +
      "otherwise no one could log in. Add and enable an SSO provider first.",
  );
}

export interface EffectiveSso {
  providers: SsoProviderConfig[];
  allowedEmailDomains: string[];
  disablePasswordAuth: boolean;
}

// Single source of truth for combining DB-configured SSO (from the
// instance_settings singleton) with env/config-file-configured SSO (from
// `PAPERCLIP_SSO_PROVIDERS` / the config file's `auth.ssoProviders`).
//
// DB providers only take over -- along with the DB-only security controls,
// the email-domain allowlist and the password-auth kill switch -- once SSO
// is enabled *and* has at least one provider configured. Otherwise the
// env-configured providers remain authoritative and neither DB-only control
// applies, since there is no corresponding DB-backed provider for them to
// protect.
//
// This must be called identically at boot and on every subsequent settings
// change (Better Auth rebuild, and the public sso-providers login-page
// probe) -- using three different ad-hoc copies of this decision is what let
// a settings save silently unregister env-configured providers and let the
// public provider list drift out of sync with what the auth handler
// actually accepts.
export function deriveEffectiveSso(
  dbSso: InstanceSsoSettings,
  envProviders: SsoProviderConfig[],
): EffectiveSso {
  if (dbSso.enabled && dbSso.providers.length > 0) {
    return {
      providers: dbSso.providers,
      allowedEmailDomains: dbSso.allowedEmailDomains,
      disablePasswordAuth: dbSso.disablePasswordAuth,
    };
  }
  return { providers: envProviders, allowedEmailDomains: [], disablePasswordAuth: false };
}

function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
  return {
    id: row.id,
    defaultEnvironmentId: row.defaultEnvironmentId ?? null,
    general: normalizeGeneralSettings(row.general),
    experimental: normalizeExperimentalSettings(row.experimental),
    sso: normalizeSsoSettings(row.sso),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as InstanceSettings;
}

export function instanceSettingsService(db: Db, options: InstanceSettingsServiceOptions = {}) {
  async function selectRow() {
    return db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
  }

  async function getOrCreateRow() {
    const existing = await selectRow();
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        experimental: {},
        sso: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    if (created) return created;

    const raced = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (raced) return raced;

    throw new Error("Failed to initialize instance settings row");
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    update: async (patch: PatchInstanceSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          ...(Object.prototype.hasOwnProperty.call(patch, "defaultEnvironmentId")
            ? { defaultEnvironmentId: patch.defaultEnvironmentId ?? null }
            : {}),
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return normalizeGeneralSettings(row.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettings> => {
      const row = await getOrCreateRow();
      return normalizeExperimentalSettings(row.experimental);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextGeneral = normalizeGeneralSettings({
        ...normalizeGeneralSettings(current.general),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextExperimental = applyExperimentalSettingsPatch(current.experimental, patch, options);
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    getSso: async (): Promise<InstanceSsoSettings> => {
      const row = await getOrCreateRow();
      return normalizeSsoSettings(row.sso);
    },

    // Non-writing counterpart to `getSso`. `getOrCreateRow` inserts the
    // singleton settings row the first time it's read, which is fine for
    // authenticated/admin reads but wrong for a public, unauthenticated
    // endpoint (e.g. the login page's SSO-provider probe) that should never
    // cause a database write. Falls back to the same defaults `getSso` would
    // return via `normalizeSsoSettings` when no row exists yet.
    getSsoReadOnly: async (): Promise<InstanceSsoSettings> => {
      const row = await selectRow();
      return normalizeSsoSettings(row?.sso);
    },

    updateSso: async (patch: PatchInstanceSsoSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const currentSso = normalizeSsoSettings(current.sso);
      const nextSso = normalizeSsoSettings({ ...currentSso, ...patch });
      assertSsoSettingsNotLockedOut(nextSso);
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          sso: { ...nextSso } as Record<string, unknown>,
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}

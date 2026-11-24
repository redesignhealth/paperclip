import { buildAgentChildBaseEnv } from "@paperclipai/adapter-utils/agent-child-env";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { createUsageCheckpointLog } from "@paperclipai/adapter-utils/usage-checkpoint";
import { registerModelRelay, MODEL_RELAY_ROUTE_POLICIES } from "@paperclipai/adapter-utils/model-relay";
import { buildPackageRelayEnv, packageRelayAnyOptedIn, PACKAGE_RELAY_GITHUB_REPOS_ENV, PACKAGE_RELAY_ROUTE_POLICIES } from "@paperclipai/adapter-utils/package-relay-env";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetIsSandbox,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetFile,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { isPiUnknownSessionError, parsePiJsonl, createPiJsonlParser } from "./parse.js";
import { createPiStdoutCompactor, resolvePiStdoutLogMode } from "./stdout-compaction.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";
import { pointRelayedProvidersAtBridge, preparePiRuntimeConfig } from "./runtime-config.js";
import {
  PI_MCP_TOOL_NAME,
  buildPiMcpConfig,
  buildPiMcpRelayRoutes,
  resolvePiMcpAdapterPath,
  selectPiMcpRelayServers,
} from "./mcp-config.js";
import { PI_MEMORY_EXTENSION_FILE, PI_MEMORY_TOOL_NAMES, findPiMemoryRelayServer, preparePiMemoryExtension } from "./memory-extension.js";
import { preparePiOpenRouterExtension } from "./openrouter-extension.js";
import { PI_GUARD_EXTENSION_FILE, preparePiGuardExtension, readPiGuardProfile } from "./guard-extension.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  collectSessionSecrets,
  protectRemoteSessionDir,
  restoreRemoteSession,
  saveRemoteSession,
  type RemoteSessionExec,
} from "./session-persistence.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PAPERCLIP_SESSIONS_DIR = path.join(os.homedir(), ".pi", "paperclips");
const PI_AGENT_SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

async function ensurePiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;
  await fs.mkdir(PI_AGENT_SKILLS_DIR, { recursive: true });
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    PI_AGENT_SKILLS_DIR,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Pi skill "${skillName}" from ${PI_AGENT_SKILLS_DIR}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(PI_AGENT_SKILLS_DIR, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildPiSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return provider === "openai" ? inferOpenAiCompatibleBiller(env, "openai") ?? "unknown" : provider ?? "unknown";
}

async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(PAPERCLIP_SESSIONS_DIR, { recursive: true });
  return PAPERCLIP_SESSIONS_DIR;
}

function buildSessionPath(agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(PAPERCLIP_SESSIONS_DIR, `${safeTimestamp}-${agentId}.jsonl`);
}

function buildRemoteSessionPath(runtimeRootDir: string, agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.posix.join(runtimeRootDir, "sessions", `${safeTimestamp}-${agentId}.jsonl`);
}

function normalizeExecutionCwd(candidate: string, remote: boolean): string {
  return remote ? path.posix.normalize(candidate) : path.resolve(candidate);
}

function executionCwdsMatch(saved: string, current: string, remote: boolean): boolean {
  return normalizeExecutionCwd(saved, remote) === normalizeExecutionCwd(current, remote);
}

function readSessionHeaderCwd(raw: string): string | null {
  const headerLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!headerLine) return null;
  try {
    const parsed = JSON.parse(headerLine) as Record<string, unknown>;
    if (parsed.type !== "session") return null;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    return cwd.length > 0 ? cwd : null;
  } catch {
    return null;
  }
}

async function readSavedSessionCwd(input: {
  runId: string;
  sessionPath: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  if (!input.sessionPath.trim()) return null;

  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    try {
      return readSessionHeaderCwd(await fs.readFile(input.sessionPath, "utf8"));
    } catch {
      return null;
    }
  }

  try {
    const sessionHeader = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `if [ -f ${shellQuote(input.sessionPath)} ]; then head -n 1 ${shellQuote(input.sessionPath)}; fi`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    if (sessionHeader.timedOut || (sessionHeader.exitCode ?? 0) !== 0) return null;
    return readSessionHeaderCwd(sessionHeader.stdout);
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const hasCustomPromptTemplate = asString(config.promptTemplate, "").trim().length > 0;
  const command = asString(config.command, "pi");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();
  const stdoutLogMode = resolvePiStdoutLogMode(config);

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  if (!executionTargetIsRemote) {
    await ensureSessionsDir();
  }

  const piSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredPiSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, piSkillEntries);
  if (!executionTargetIsRemote) {
    await ensurePiSkillsInjected(onLog, piSkillEntries, desiredPiSkillNames);
  }

  // Build environment
  // A copy: relayed secrets are removed from it below.
  const envConfig = { ...parseObject(config.env) };
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  // The run JWT authenticates host-side Paperclip API calls. A remote target
  // never needs it: every remote target talks to Paperclip through the callback
  // bridge, which takes the JWT host-side (hostApiToken below) and gives the
  // target its own bridge token. Keep it out of `env` for remote targets so no
  // exec issued before the bridge starts can carry it to the target.
  // (PAPERCLIP_API_KEY is never accepted from config env, so authToken is the
  // only source.)
  if (authToken && !executionTargetIsRemote) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  // Materialize custom Pi providers (PAPERCLIP_PI_PROVIDERS) into a managed
  // PI_CODING_AGENT_DIR before runtimeEnv is computed, so both local validation
  // and the spawned Pi process resolve models against the managed models.json.
  // TECH-9794: runtime MCP servers reach Pi only through the sandbox bridge relay, so no MCP token or run
  // token is written to the pod. Targets without the bridge (and local runs) continue without them.
  const allRuntimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
  // Sandbox pods only: they run the runtime image that carries the pinned extension. SSH hosts also use the bridge
  // but do not have it.
  const mcpRelayAvailable = adapterExecutionTargetIsSandbox(executionTarget) && adapterExecutionTargetUsesPaperclipBridge(executionTarget);
  const { relayServers: piMcpRelayServers, skipped: piMcpSkipped } = mcpRelayAvailable
    ? selectPiMcpRelayServers(allRuntimeMcpServers)
    : { relayServers: [], skipped: [] };
  if (allRuntimeMcpServers.length > 0 && !mcpRelayAvailable) {
    await onLog(
      "stdout",
      `[paperclip] Warning: ${allRuntimeMcpServers.length} runtime MCP server(s) need the Paperclip bridge relay and the runtime image extension, which only sandbox pod targets have; this run continues without them.\n`,
    );
  }
  if (piMcpSkipped.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Warning: skipped runtime MCP server(s) with no allowed tools: ${piMcpSkipped.join(", ")}.\n`,
    );
  }
  let piMcpEnabled = piMcpRelayServers.length > 0;
  const piMcpAdapterPath = resolvePiMcpAdapterPath();
  const preparedRuntimeConfig = await preparePiRuntimeConfig({
    env,
    mcpConfig: piMcpEnabled ? buildPiMcpConfig(piMcpRelayServers) : null,
    // TECH-10174: in a sandbox pod the model gateway key stays on the server and model calls go through the relay.
    modelRelay: mcpRelayAvailable,
  });
  const relayedProviderNames = Object.keys(preparedRuntimeConfig.relayedProviders);
  for (const key of preparedRuntimeConfig.droppedEnvKeys) {
    delete env[key];
    // The workspace env refresh re-applies envConfig later; the value must not come back.
    delete envConfig[key];
  }
  const disposeModelRelay = relayedProviderNames.length > 0
    ? registerModelRelay(runId, preparedRuntimeConfig.relayedProviders)
    : () => {};
  const localAgentConfigDir = preparedRuntimeConfig.agentConfigDir ?? "";
  if (localAgentConfigDir) {
    env.PI_CODING_AGENT_DIR = localAgentConfigDir;
  }
  let attributionExtension: Awaited<ReturnType<typeof preparePiOpenRouterExtension>> | undefined;
  // TECH-9797: a pod has no person to approve a tool call. Remote runs load the headless guard (pre-approved list,
  // deny list, fail fast on the rest). Local runs keep Pi's own behaviour.
  let guardExtension: Awaited<ReturnType<typeof preparePiGuardExtension>> | undefined;
  let guardExtensionPath: string | null = null;
  let memoryExtension: Awaited<ReturnType<typeof preparePiMemoryExtension>> | undefined;
  try {
    attributionExtension = await preparePiOpenRouterExtension();
    if (executionTargetIsRemote) {
      guardExtension = await preparePiGuardExtension(readPiGuardProfile(envConfig));
      guardExtensionPath = guardExtension.extensionPath;
    }
    let attributionExtensionPath = attributionExtension.extensionPath;
    // TECH-9796: enrolled agents (adapterConfig.memoryExtension, set by the memory profile) get the recall/capture
    // extension. It needs the memory MCP server from the relay, so without one the run continues without memory.
    let memoryExtensionPath: string | null = null;
    if (config.memoryExtension === true) {
      if (findPiMemoryRelayServer(piMcpRelayServers)) {
        memoryExtension = await preparePiMemoryExtension();
        memoryExtensionPath = memoryExtension.extensionPath;
      } else {
        await onLog("stdout", "[paperclip] Warning: memory is enabled for this agent but its memory MCP server is not available in this run; continuing without memory.\n");
      }
    }
    // Prepend installed skill `bin/` dirs to PATH so an agent's bash tool can
    // invoke skill binaries (e.g. `paperclip-get-issue`) by name. Without this,
    // any pi_local agent whose AGENTS.md calls a skill command via bash hits
    // exit 127 "command not found". Only include skills that ensurePiSkillsInjected
    // actually linked — otherwise non-injected skills' binaries would be reachable
    // to the agent.
    const injectedSkillKeys = new Set(desiredPiSkillNames);
    const skillBinDirs = piSkillEntries
      .filter((entry) => injectedSkillKeys.has(entry.key) && entry.source.length > 0)
      .map((entry) => path.join(entry.source, "bin"));
    const mergedEnv = ensurePathInEnv({ ...buildAgentChildBaseEnv(process.env), ...env });
    const pathKey =
      typeof mergedEnv.Path === "string" && mergedEnv.Path.length > 0 && !mergedEnv.PATH
        ? "Path"
        : "PATH";
    const basePath = mergedEnv[pathKey] ?? "";
    if (skillBinDirs.length > 0) {
      const existing = basePath.split(path.delimiter).filter(Boolean);
      const additions = skillBinDirs.filter((dir) => !existing.includes(dir));
      if (additions.length > 0) {
        mergedEnv[pathKey] = [...additions, basePath].filter(Boolean).join(path.delimiter);
      }
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    if (!executionTargetIsRemote) {
      await ensurePiModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let localSkillsDir: string | null = null;
    let remoteSkillsDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTargetIsRemote) {
      try {
        localSkillsDir = await buildPiSkillsDir(config);
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Pi runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "pi",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [
            {
              key: "attribution",
              localDir: attributionExtension.directory,
            },
            ...(guardExtension
              ? [{
                key: "guard",
                localDir: guardExtension.directory,
              }]
              : []),
            ...(memoryExtension
              ? [{
                key: "memory",
                localDir: memoryExtension.directory,
              }]
              : []),
            {
              key: "skills",
              localDir: localSkillsDir,
              followSymlinks: true,
            },
            ...(localAgentConfigDir
              ? [{
                key: "agentConfig",
                localDir: localAgentConfigDir,
              }]
              : []),
          ],
        });
        restoreRemoteWorkspace = () =>
          preparedRemoteRuntime.restoreWorkspace((line) => onLog("stdout", line));
        effectiveExecutionCwd = preparedRemoteRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
        refreshPaperclipWorkspaceEnvForExecution({
          env,
          envConfig,
          workspaceCwd: effectiveWorkspaceCwd,
          workspaceSource,
          workspaceId,
          workspaceRepoUrl,
          workspaceRepoRef,
          workspaceHints,
          agentHome,
          executionTargetIsRemote,
          executionCwd: effectiveExecutionCwd,
        });
        if (adapterExecutionTargetUsesManagedHome(executionTarget) && preparedRemoteRuntime.runtimeRootDir) {
          env.HOME = preparedRemoteRuntime.runtimeRootDir;
        }
        remoteRuntimeRootDir = preparedRemoteRuntime.runtimeRootDir;
        remoteSkillsDir = preparedRemoteRuntime.assetDirs.skills ?? null;
        const remoteAttributionDir = preparedRemoteRuntime.assetDirs.attribution;
        if (!remoteAttributionDir) throw new Error("Pi attribution extension was not staged to the execution target.");
        attributionExtensionPath = path.posix.join(remoteAttributionDir, "openrouter-attribution.mjs");
        if (guardExtension) {
          const remoteGuardDir = preparedRemoteRuntime.assetDirs.guard;
          // Fail closed: never start a pod run without its guard.
          if (!remoteGuardDir) throw new Error("Pi guard extension was not staged to the execution target.");
          guardExtensionPath = path.posix.join(remoteGuardDir, PI_GUARD_EXTENSION_FILE);
        }
        if (memoryExtension) {
          const remoteMemoryDir = preparedRemoteRuntime.assetDirs.memory;
          if (!remoteMemoryDir) throw new Error("Pi memory extension was not staged to the execution target.");
          memoryExtensionPath = path.posix.join(remoteMemoryDir, PI_MEMORY_EXTENSION_FILE);
        }
        if (localAgentConfigDir && preparedRemoteRuntime.assetDirs.agentConfig) {
          env.PI_CODING_AGENT_DIR = preparedRemoteRuntime.assetDirs.agentConfig;
        }
        if (piMcpEnabled) {
          // Fail soft: an image without the pinned extension must not break the run. Pi would abort on a
          // missing --extension, so run without MCP and say why.
          const probe = await runAdapterExecutionTargetShellCommand(
            runId,
            executionTarget,
            `test -f ${shellQuote(piMcpAdapterPath)}`,
            { cwd: effectiveExecutionCwd, env: runtimeEnv, timeoutSec: 15, graceSec: 5 },
          ).catch(() => null);
          if (!probe || probe.timedOut || (probe.exitCode ?? 1) !== 0) {
            piMcpEnabled = false;
            memoryExtensionPath = null; // memory is delivered as MCP tools, so it goes with MCP
            await onLog(
              "stdout",
              `[paperclip] Warning: the Pi MCP adapter extension was not found at ${piMcpAdapterPath} in the execution target image; this run continues without runtime MCP servers.\n`,
            );
          }
        }
      } catch (error) {
        await Promise.allSettled([
          restoreRemoteWorkspace?.(),
          localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        ]);
        throw error;
      }
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "pi",
        timeoutSec,
        hostApiToken: authToken,
        onLog,
        ...(piMcpEnabled ? { relayRoutes: buildPiMcpRelayRoutes(piMcpRelayServers) } : {}),
        // The package relay routes get their own lane and deadline (TECH-9786).
        ...(packageRelayAnyOptedIn(envConfig) || relayedProviderNames.length > 0
          ? {
              bridgeRoutePolicies: [
                ...(packageRelayAnyOptedIn(envConfig) ? PACKAGE_RELAY_ROUTE_POLICIES : []),
                ...(relayedProviderNames.length > 0 ? MODEL_RELAY_ROUTE_POLICIES : []),
              ],
            }
          : {}),
      });
      if (relayedProviderNames.length > 0) {
        // Fail closed: without the bridge the provider would point at nothing, and the key must not fall back into the pod.
        const apiUrl = paperclipBridge?.env.PAPERCLIP_API_URL;
        if (!apiUrl || !localAgentConfigDir || !env.PI_CODING_AGENT_DIR) {
          throw new Error("The model relay needs the Paperclip bridge, which did not start; refusing to run with the model key in the sandbox.");
        }
        const localModelsPath = path.join(localAgentConfigDir, "models.json");
        const rewritten = pointRelayedProvidersAtBridge(await fs.readFile(localModelsPath, "utf8"), relayedProviderNames, apiUrl);
        if (rewritten) {
          const written = await runAdapterExecutionTargetProcess(
            runId,
            runtimeExecutionTarget,
            "sh",
            ["-c", 'cat > "$1"', "sh", path.posix.join(env.PI_CODING_AGENT_DIR, "models.json")],
            { cwd, env, stdin: rewritten, timeoutSec: 30, graceSec: 5, onLog: async () => {} },
          );
          if (written.timedOut || (written.exitCode ?? 1) !== 0) {
            throw new Error("Could not point the Pi model provider at the Paperclip relay in the sandbox.");
          }
        }
      }
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        // Opted-in builder agents install private packages through the server relay (TECH-9786).
        Object.assign(env, buildPackageRelayEnv(envConfig, paperclipBridge.env, process.env[PACKAGE_RELAY_GITHUB_REPOS_ENV]));
        loggedEnv = buildInvocationEnvForLogs(env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...buildAgentChildBaseEnv(process.env), ...env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const sessionTargetMatches = adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionParamsCwdMatches =
      runtimeSessionCwd.length === 0 ||
      executionCwdsMatch(runtimeSessionCwd, effectiveExecutionCwd, executionTargetIsRemote);
    // A reused pod is scrubbed between turns, which deletes the Pi session file.
    // Put the server's saved copy back before deciding whether to resume (TECH-9798).
    const remoteSessionExec: RemoteSessionExec | null = runtimeExecutionTarget?.kind === "remote" && runtimeExecutionTarget.transport === "sandbox"
      ? async (script, stdin) => {
          const result = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, "sh", ["-c", script], {
            cwd,
            env,
            ...(stdin !== undefined ? { stdin } : {}),
            timeoutSec: 30,
            graceSec: 5,
            onLog: async () => {},
          });
          return { exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout };
        }
      : null;
    const sessionSecrets = collectSessionSecrets(env, [authToken]);
    if (remoteSessionExec && sessionTargetMatches && sessionParamsCwdMatches && runtimeSessionId.length > 0) {
      try {
        if (await restoreRemoteSession({ exec: remoteSessionExec, storeDir: PAPERCLIP_SESSIONS_DIR, sessionPath: runtimeSessionId })) {
          await onLog("stdout", `[paperclip] Restored Pi session "${runtimeSessionId}" from the server copy.\n`);
        }
      } catch (err) {
        await onLog("stderr", `[paperclip] Could not restore the saved Pi session: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    const savedSessionCwd =
      runtimeSessionId.length > 0
        ? await readSavedSessionCwd({
            runId,
            sessionPath: runtimeSessionId,
            executionTarget: runtimeExecutionTarget ?? null,
            cwd,
            env,
            timeoutSec,
            graceSec,
          })
        : null;
    const sessionHeaderCwdMatches =
      runtimeSessionId.length === 0 ||
      (savedSessionCwd !== null &&
        executionCwdsMatch(savedSessionCwd, effectiveExecutionCwd, executionTargetIsRemote));
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      sessionTargetMatches &&
      sessionParamsCwdMatches &&
      sessionHeaderCwdMatches;
    const sessionPath = canResumeSession
      ? runtimeSessionId
      : executionTargetIsRemote && remoteRuntimeRootDir
        ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
        : buildSessionPath(agent.id, new Date().toISOString());

    if (runtimeSessionId && !canResumeSession) {
      const staleSessionCwdNote =
        savedSessionCwd !== null && !sessionHeaderCwdMatches
          ? ` Pi stored cwd "${savedSessionCwd}" in the session header, so Paperclip will start a fresh session for "${effectiveExecutionCwd}".`
          : "";
      await onLog(
        "stdout",
        executionTargetIsRemote
          ? `[paperclip] Pi session "${runtimeSessionId}" does not match the current remote execution state and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote} Starting a fresh remote session.\n`
          : `[paperclip] Pi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote}\n`,
      );
    }

    if (!canResumeSession) {
      if (executionTargetIsRemote) {
        await ensureAdapterExecutionTargetFile(runId, runtimeExecutionTarget, sessionPath, {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog,
        });
        if (remoteSessionExec) await protectRemoteSessionDir(remoteSessionExec, sessionPath).catch((err) => onLog("stderr", `[paperclip] Could not protect the Pi session dir from Git: ${err instanceof Error ? err.message : String(err)}\n`));
      } else {
        try {
          await fs.writeFile(sessionPath, "", { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            throw err;
          }
        }
      }
    }

    // Handle instructions file and build system prompt extension
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

    let systemPromptExtension = "";
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        systemPromptExtension =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
          (context.conversationMode === true
            ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
            : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
      } catch (err) {
        instructionsReadFailed = true;
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
        // Fall back to base prompt template
        systemPromptExtension = promptTemplate;
      }
    } else {
      systemPromptExtension = promptTemplate;
    }

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
    const systemOwnsDefaultPolicy = !hasCustomPromptTemplate || Boolean(resolvedInstructionsFilePath && !instructionsReadFailed);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (stdoutLogMode !== "raw") {
        notes.push(`Pi stdout run-log compaction mode: ${stdoutLogMode}`);
      }
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsReadFailed) {
        notes.push(
          `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        );
        return notes;
      }
      notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      notes.push(
        `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
      );
      return notes;
    })();

    const buildArgs = (sessionFile: string, userPrompt: string): string[] => {
      const args: string[] = [];

      // Use JSON mode for structured output with print mode (non-interactive)
      args.push("--mode", "json");
      args.push("-p"); // Non-interactive mode: process prompt and exit

      // Use --append-system-prompt to extend Pi's default system prompt
      args.push("--append-system-prompt", renderedSystemPromptExtension);

      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (thinking) args.push("--thinking", thinking);

      args.push(
        "--tools",
        [
          "read,bash,edit,write,grep,find,ls",
          ...(piMcpEnabled ? [PI_MCP_TOOL_NAME] : []),
          ...(memoryExtensionPath ? PI_MEMORY_TOOL_NAMES : []),
        ].join(","),
      );
      args.push("--session", sessionFile);
      args.push("--skill", remoteSkillsDir ?? PI_AGENT_SKILLS_DIR);

      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("--extension", attributionExtensionPath);
      if (guardExtensionPath) args.push("--extension", guardExtensionPath);
      if (piMcpEnabled) args.push("--extension", piMcpAdapterPath);
      if (memoryExtensionPath) args.push("--extension", memoryExtensionPath);

      // Add the user prompt as the last argument
      args.push(userPrompt);

      return args;
    };

    const runAttempt = async (sessionFile: string) => {
      const attemptResumedSession = canResumeSession && sessionFile === sessionPath;
      await hydrateFreshSessionHandoff(ctx, { resumedSession: attemptResumedSession });
      const attemptSections = selectPaperclipPromptSections(context, {
        resumedSession: attemptResumedSession,
        includeCommunicationGuidance: false,
        includeExecutionContract: systemOwnsDefaultPolicy ? false : undefined,
      });
      const attemptBootstrapPrompt = !attemptResumedSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
      const attemptWakePrompt = attemptSections.wakePrompt;
      const attemptRenderedHeartbeatPrompt = attemptResumedSession && attemptWakePrompt.length > 0
        || isPaperclipRecoveryWakePayload(context.paperclipWake)
        || !hasCustomPromptTemplate
        ? ""
        : renderTemplate(promptTemplate, templateData);
      const attemptBaseUserPrompt = joinPromptSections([
        attemptBootstrapPrompt,
        attemptWakePrompt,
        attemptSections.taskContextNote,
        sessionHandoffNote,
        attemptRenderedHeartbeatPrompt,
      ]);
      const userPrompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: attemptResumedSession }),
        attemptBaseUserPrompt,
      ]);
      const promptMetrics = {
        systemPromptChars: renderedSystemPromptExtension.length,
        promptChars: userPrompt.length,
        bootstrapPromptChars: attemptBootstrapPrompt.length,
        wakePromptChars: attemptWakePrompt.length,
        taskContextChars: attemptSections.taskContextNote.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: attemptRenderedHeartbeatPrompt.length,
      };
      const args = buildArgs(sessionFile, userPrompt);
      if (onMeta) {
        await onMeta({
          adapterType: "pi_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: args,
          env: loggedEnv,
          prompt: userPrompt,
          promptMetrics: { ...promptMetrics, promptChars: userPrompt.length },
          context,
        });
      }

      // Buffer stdout by lines to handle partial JSON chunks
      let stdoutBuffer = "";
      const compactStdoutLine = createPiStdoutCompactor(stdoutLogMode);
      // Compaction only affects the persisted run log; parsePiJsonl reads the unfiltered proc.stdout.
      const emitCompacted = async (line: string, suffix: string) => {
        const compacted = compactStdoutLine(line);
        if (compacted !== null) {
          await onLog("stdout", compacted + suffix);
        }
      };
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr") {
          // Pass stderr through immediately (not JSONL)
          await onLog(stream, chunk);
          return;
        }

        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line) {
            await emitCompacted(line, "\n");
          }
        }
      };

      const consumeAccounting = createPiJsonlParser();
      let hasAccounting = false;
      const accountingLog = createUsageCheckpointLog(bufferedOnLog, ctx.onUsage ?? (async () => {}), stdout => {
        hasAccounting = true;
        const parsed = consumeAccounting(stdout);
        return { usage: parsed.usage, costUsd: parsed.usage.costUsd, usageBasis: "per_run", provider, biller: resolvePiBiller(runtimeEnv, provider), billingType: "unknown", model, complete: parsed.sawAgentEnd };
      });
      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        onProcessStopped: providerStop.beginInvocation(),
        cwd,
        env: executionTargetIsRemote ? env : runtimeEnv,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: accountingLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
      });
      await accountingLog.flush();

      // Copy the session off the pod before the between-turn scrub deletes it.
      if (remoteSessionExec) {
        try {
          const saved = await saveRemoteSession({ exec: remoteSessionExec, storeDir: PAPERCLIP_SESSIONS_DIR, sessionPath: sessionFile, secrets: sessionSecrets });
          if (!saved) await onLog("stderr", "[paperclip] Pi session was not saved to the server; the next wake may start cold.\n");
        } catch (err) {
          await onLog("stderr", `[paperclip] Could not save the Pi session to the server: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }

      // Flush any remaining buffer content
      if (stdoutBuffer) {
        await emitCompacted(stdoutBuffer, "");
      }

      // Display output is capped by the process transport. Keep accounting
      // from the full stream, including when no checkpoint callback is installed.
      const parsed = parsePiJsonl(proc.stdout);
      if (hasAccounting) {
        const retained = consumeAccounting("");
        parsed.usage = retained.usage;
        parsed.sawAgentEnd = retained.sawAgentEnd;
      }
      return { proc, rawStderr: proc.stderr, parsed };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parsePiJsonl>;
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          usageComplete: attempt.parsed.sawAgentEnd,
        usage: attempt.parsed.usage, usageBasis: "per_run", provider, biller: resolvePiBiller(runtimeEnv, provider), model, billingType: "unknown", costUsd: attempt.parsed.usage.costUsd,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId = clearSessionOnMissingSession ? null : sessionPath;
      const resolvedSessionParams = resolvedSessionId
        ? {
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          }
        : null;

      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const parsedError = attempt.parsed.errors.find((error) => error.trim().length > 0) ?? "";
      const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
      // The guard aborts Pi after repeated blocked calls; Pi then reports only a bare "This operation was aborted".
      // Surface the guard's own stop line so the run record says why (TECH-10085).
      const guardStopLine = attempt.proc.stderr.split(/\r?\n/).find((line) => line.startsWith("[paperclip-guard] stopping run:"))?.trim();
      const fallbackErrorMessage = guardStopLine || parsedError || stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;

      return {
        exitCode: effectiveExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        usageComplete: attempt.parsed.sawAgentEnd,
      usageBasis: "per_run",
        errorMessage: (effectiveExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        // Forward the transport-level error code from the run-disposition seam.
        // A lost duplex control channel surfaces the typed `duplex_channel_lost`
        // code; every other result carries no code here.
        errorCode: attempt.proc.errorCode ?? null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: provider,
        biller: resolvePiBiller(runtimeEnv, provider),
        model: model,
        billingType: "unknown",
        costUsd: attempt.parsed.usage.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
        clearSession: Boolean(clearSessionOnMissingSession),
      };
    };

    try {
      const initial = await runAttempt(sessionPath);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);

      if (
        canResumeSession &&
        initialFailed &&
        isPiUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Pi session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const newSessionPath = executionTargetIsRemote && remoteRuntimeRootDir
          ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
          : buildSessionPath(agent.id, new Date().toISOString());
        if (executionTargetIsRemote) {
          await ensureAdapterExecutionTargetFile(runId, executionTarget, newSessionPath, {
            cwd,
            env,
            timeoutSec: 15,
            graceSec: 5,
            onLog,
          });
          if (remoteSessionExec) await protectRemoteSessionDir(remoteSessionExec, newSessionPath).catch((err) => onLog("stderr", `[paperclip] Could not protect the Pi session dir from Git: ${err instanceof Error ? err.message : String(err)}\n`));
        } else {
          try {
            await fs.writeFile(newSessionPath, "", { flag: "wx" });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
              throw err;
            }
          }
        }
        const retry = await runAttempt(newSessionPath);
        return toResult(retry, true);
      }

      return toResult(initial);
    } finally {
      try {
        await providerStop.collectBeforeRestore();
      } finally {
        await Promise.all([
          paperclipBridge?.stop(),
          restoreRemoteWorkspace?.(),
          localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        ]);
      }
    }
  } finally {
    disposeModelRelay();
    await Promise.all([preparedRuntimeConfig.cleanup(), attributionExtension?.cleanup(), guardExtension?.cleanup(), memoryExtension?.cleanup()]);
  }
}

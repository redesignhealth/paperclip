/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Shared regular expression escaping utility from @paperclipai/adapter-utils.
 * Exported via @paperclipai/adapter-utils/regex and root @paperclipai/adapter-utils.
 */
import { escapeRegExp } from "@paperclipai/adapter-utils/regex";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  VALID_PROVIDERS,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";
import { normalizeConfiguredModel, resolveModelArg } from "./model-arg.js";
import { reconcileHermesPaperclipSkills } from "./skills.js";
import { prepareHermesMcpHome, cleanupHermesMcpHome } from "./mcp-config.js";
import {
  validateHermesMemoryConfig,
  extractMemorySensitiveValues,
  createChunkAwareStreamingRedactor,
  redactSensitiveString,
  canSafelyRedactSecret,
  MAX_CONFIG_STRING_LENGTH,
  type ValidatedHermesMemoryConfig,
} from "./memory-config.js";

export const HERMES_FORBIDDEN_ENV_VARS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGPASSFILE",
  "PAPERCLIP_MEMORY_ADMIN_DATABASE_URL",
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "PAPERCLIP_DB_BACKUP_DIR",
] as const;

export const HERMES_LIBPQ_ENV_VARS = HERMES_FORBIDDEN_ENV_VARS;

/**
 * Classifies whether a stderr log line is benign and should be reclassified as stdout
 * to avoid appearing as a spurious error in the Paperclip UI.
 *
 * Rules:
 * - Reject any line indicating errors, critical failures, fatal crashes, or tracebacks (even if timestamped).
 * - Allow structured timestamps only if accompanied by benign levels (INFO, DEBUG, WARN, WARNING) or neutral status.
 * - Allow anchored log levels: [INFO], INFO:, etc. with strict word and punctuation boundaries.
 * - Allow anchored MCP lifecycle and application initialization messages.
 */
export function isBenignStderrLog(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true; // empty lines on stderr should not appear as alarm errors

  // Never classify genuine errors, fatal issues, or tracebacks as benign
  if (/\b(?:ERROR|CRITICAL|FATAL)\b|Traceback \(most recent call last\):/i.test(trimmed)) {
    return false;
  }

  // Structured timestamps followed by benign log levels or neutral status
  const timestampPrefixMatch = trimmed.match(
    /^\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*(?:-\s+)?/,
  );
  if (timestampPrefixMatch) {
    const afterTimestamp = trimmed.slice(timestampPrefixMatch[0].length).trim();
    return (
      /^\[(?:INFO|DEBUG|WARN|WARNING)\](?:\s*[:-]|\s+|$)/i.test(afterTimestamp) ||
      /^(?:[A-Za-z0-9_.-]+:\s*)?(?:INFO|DEBUG|WARN|WARNING):\s*/i.test(afterTimestamp) ||
      /^(?:[A-Za-z0-9_.-]+\s+-\s+)?\b(?:INFO|DEBUG|WARN|WARNING)\b(?:\s*[:-]|\s+)/i.test(
        afterTimestamp,
      ) ||
      /^(?:Application initialized|Successfully registered all tools|Registered MCP tool|MCP [Ss]erver(?::|\s+(?:connected|initialized|ready|running|started)\b)|(?:MCP\s+)?tool registered successfully\b)/i.test(
        afterTimestamp,
      )
    );
  }

  // Anchored log levels without timestamps (must have explicit brackets, colon, or dash delimiters)
  if (
    /^\[(?:INFO|DEBUG|WARN|WARNING)\](?:\s*[:-]|\s+|$)/i.test(trimmed) ||
    /^(?:[A-Za-z0-9_.-]+:\s*)?(?:INFO|DEBUG|WARN|WARNING):\s*/i.test(trimmed) ||
    /^(?:[A-Za-z0-9_.-]+\s+-\s+)?\b(?:INFO|DEBUG|WARN|WARNING)\b(?:\s*[:-]|\s+)/i.test(trimmed)
  ) {
    return true;
  }

  // Anchored MCP lifecycle and application initialization patterns
  return (
    /^(?:\[INFO\]\s*)?Successfully registered all tools\b/i.test(trimmed) ||
    /^(?:\[INFO\]\s*)?Registered MCP tool\b/i.test(trimmed) ||
    /^(?:\[INFO\]\s*)?(?:MCP\s+)?tool registered successfully\b/i.test(trimmed) ||
    /^(?:\[INFO\]\s*)?MCP [Ss]erver(?::|\s+(?:connected|initialized|ready|running|started)\b)/i.test(
      trimmed,
    ) ||
    /^(?:\[INFO\]\s*)?Application initialized\b/i.test(trimmed)
  );
}

/**
 * Sentinel file placed in /opt/hermes during production Docker image builds.
 * Verifies that the hash-locked requirements closure was baked into the image.
 */
export const HERMES_PRODUCTION_CLOSURE_SENTINEL = ".hermes-production-closure";

/**
 * Required Python modules for Hermes runtime memory capability (mem0 + pgvector).
 * Bundled in the production Docker image closure under /opt/hermes.
 */
export const HERMES_MEMORY_REQUIRED_MODULES = ["mem0", "psycopg", "psycopg2"] as const;

/**
 * Standard Python import statement for verifying runtime memory capability.
 */
export const HERMES_MEMORY_PYTHON_IMPORT_CHECK = `import ${HERMES_MEMORY_REQUIRED_MODULES.join(", ")}`;

/**
 * Resolves the Hermes opt directory path for capability checks.
 * In production environments, this is strictly "/opt/hermes".
 * PAPERCLIP_HERMES_OPT_PATH is strictly constrained to test environments (NODE_ENV === "test")
 * to prevent accidental or malicious bypass of the production preflight check.
 */
export function resolveOptHermesPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  if (process.env.NODE_ENV === "production") {
    return "/opt/hermes";
  }
  if (process.env.NODE_ENV === "test") {
    return process.env.PAPERCLIP_HERMES_OPT_PATH || "/opt/hermes";
  }
  return "/opt/hermes";
}

/**
 * Detects whether execution is occurring inside a Paperclip production container.
 */
export function isPaperclipProductionContainer(): boolean {
  return (
    existsSync("/paperclip") ||
    process.env.PAPERCLIP_HOME === "/paperclip"
  );
}

/**
 * Actionable preflight check for Hermes memory capability in Docker/local environments.
 * Nonblocking async implementation.
 *
 * Distinguishes between:
 * 1. Production Docker image: marked with .hermes-production-closure sentinel in optHermesPath.
 *    Fails explicitly if Python interpreter is missing or required modules (mem0, psycopg, psycopg2) fail to import.
 * 2. Stale pre-sentinel Paperclip production image:
 *    Paperclip container detected without the sentinel; reports that the production container is stale.
 * 3. Unmarked environment (e.g. Daytona runner or custom /opt/hermes):
 *    Verifies required modules if Python exists, but produces a Daytona-appropriate error rather than claiming stale production image.
 * 4. Local/ambient environment (optHermesPath does not exist):
 *    Permits execution without requiring /opt/hermes.
 */
export async function checkHermesMemoryCapability(
  optHermesPath?: string,
): Promise<{
  available: boolean;
  error?: string;
}> {
  const resolvedOptPath = resolveOptHermesPath(optHermesPath);
  if (!existsSync(resolvedOptPath)) {
    return { available: true };
  }

  const sentinelPath = path.join(resolvedOptPath, HERMES_PRODUCTION_CLOSURE_SENTINEL);
  const isProductionClosure = existsSync(sentinelPath);
  const pythonBin = path.join(resolvedOptPath, "bin", "python3");

  const isProductionContainer = isPaperclipProductionContainer();

  if (isProductionClosure) {
    if (!existsSync(pythonBin)) {
      return {
        available: false,
        error: `Hermes runtime memory is enabled, but the marked production closure (${resolvedOptPath}) is missing the Python interpreter (${pythonBin}). The container image appears corrupted. Rebuild or pull the latest Paperclip image.`,
      };
    }

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(pythonBin, ["-c", HERMES_MEMORY_PYTHON_IMPORT_CHECK], { timeout: 5000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return { available: true };
    } catch {
      return {
        available: false,
        error:
          `Hermes runtime memory is enabled, but the production Docker image lacks required dependencies (${HERMES_MEMORY_REQUIRED_MODULES.join("/")}). The container image appears stale. Rebuild or pull the latest Paperclip image containing the updated Hermes requirements closure.`,
      };
    }
  }

  // Pre-sentinel stale Paperclip production image:
  // Running in a Paperclip container environment, but lacking the production closure sentinel
  if (isProductionContainer) {
    return {
      available: false,
      error:
        "Hermes runtime memory is enabled, but the current Paperclip production container image is stale (pre-sentinel image missing the memory requirements closure). Rebuild or pull the latest Paperclip image containing the updated Hermes requirements closure.",
    };
  }

  // Unmarked environment where resolvedOptPath exists (e.g. Daytona runner or custom venv)
  if (existsSync(pythonBin)) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(pythonBin, ["-c", HERMES_MEMORY_PYTHON_IMPORT_CHECK], { timeout: 5000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return { available: true };
    } catch {
      return {
        available: false,
        error:
          `Hermes runtime memory is enabled, but the environment (${resolvedOptPath}) lacks the required memory dependencies (${HERMES_MEMORY_REQUIRED_MODULES.join("/")}) and is not a Paperclip production image with the baked memory closure. Daytona and custom environments require installing the Hermes memory closure.`,
      };
    }
  }

  return {
    available: false,
    error: `Hermes runtime memory is enabled, but Python interpreter (${pythonBin}) was not found in ${resolvedOptPath}.`,
  };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

export function resolveHermesCommand(config: Record<string, unknown>): string {
  return cfgString(config.hermesCommand) || cfgString(config.command) || HERMES_CLI;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const HERMES_DEFAULT_PROMPT_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
  "",
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Displayed command logs may redact secrets; rely on environment variables instead of printed token values.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "- For multiline comments or status updates, preserve newlines with `jq --arg` or a heredoc-fed helper rather than hand-escaping JSON.",
  "",
  "Safe multiline update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "",
  "body=$(cat <<'MD'",
  "Summary line",
  "",
  "- Detail one",
  "- Detail two",
  "MD",
  ")",
  "jq -n --arg status done --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/{{context.issueId}}\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: { resumedSession?: boolean } = {},
): string {
  const context = (ctx as any).context || {};
  const template = cfgString(config.promptTemplate) || (context.conversationMode === true
    ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
    : HERMES_DEFAULT_PROMPT_TEMPLATE);
  const taskId = cfgString(context.taskId) || cfgString(context.issueId) || cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(context.taskTitle) || cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(context.commentId) || cfgString(context.wakeCommentId) || cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(context.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const paperclipTaskMarkdown = selectPaperclipTaskMarkdown(context, {
    resumedSession: options.resumedSession === true,
  });
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    conversationMode: context.conversationMode === true,
    resumedSession: options.resumedSession === true,
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: paperclipTaskMarkdown.length > 0,
  });
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake) || "";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown,
    taskContext: paperclipTaskMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const runtimeGuidance = cfgString(ctx.runtimeTools?.guidance)?.trim() || "";

  const rendered = isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(renderConditionalSections(template, vars), vars);
  return joinPromptSections([
    wakePrompt,
    sessionHandoffMarkdown,
    runtimeGuidance,
    paperclipTaskMarkdown,
    rendered,
  ]);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch?.[1] ?? null;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

/**
 * Augments error messages when stderr specifically indicates missing mem0ai/psycopg dependencies.
 * Narrows detection to actual module import errors, avoiding spurious augmentation on benign
 * log mentions of class names.
 */
export function augmentStaleImageError(
  message: string,
  memoryConfig: unknown,
  stderr: string,
): string {
  const modulePattern = HERMES_MEMORY_REQUIRED_MODULES.map(escapeRegExp).join("|");
  const regex = new RegExp(
    `(?:ModuleNotFoundError|ImportError).*?\\b(?:${modulePattern})\\b|No module named ['"](?:${modulePattern})['"]`,
    "i",
  );
  if (memoryConfig != null && regex.test(stderr)) {
    return `${message} (Stale Docker image detected: missing mem0ai/psycopg dependencies in container. Please update to the latest image.)`;
  }
  return message;
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = resolveHermesCommand(config);
  const configuredModel = normalizeConfiguredModel(cfgString(config.model));
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  // ── Resolve runtime memory ─────────────────────────────────────────────
  let memoryConfig: ValidatedHermesMemoryConfig | null = null;
  if (ctx.runtimeMemory) {
    try {
      const rawMemory = await ctx.runtimeMemory.getConfig();
      memoryConfig = validateHermesMemoryConfig(rawMemory);
    } catch {
      await ctx.onLog(
        "stderr",
        "[hermes] Failed to resolve runtime memory configuration (details omitted for credential safety).\n",
      );
      throw new Error("Failed to resolve runtime memory configuration");
    }
  }

  const runtimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
  const usingIsolatedHome = runtimeMcpServers.length > 0 || memoryConfig != null;

  // The server adds this runtime inventory at the run boundary. Requiring the
  // marker avoids touching a developer's real Hermes home in direct unit or
  // library calls that did not opt into Paperclip runtime skills.
  if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
    try {
      const selectedSkills = await reconcileHermesPaperclipSkills(config);
      if (selectedSkills.length > 0) {
        await ctx.onLog(
          "stdout",
          `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the Hermes skills home.\n`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
      throw err;
    }
  }

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  // Hermes' own default model is also needed when no model is configured, to
  // decide whether `-m` can be omitted.
  if (!explicitProvider || !configuredModel) {
    try {
      detectedConfig = await detectModel();
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model: configuredModel,
  });

  const modelArg = resolveModelArg({
    configuredModel,
    explicitProvider,
    hermesDefaultModel: detectedConfig?.model,
  });
  if (!modelArg.ok) {
    await ctx.onLog("stderr", `[hermes] ${modelArg.message}\n`);
    throw new Error(modelArg.message);
  }
  const model = modelArg.effectiveModel;

  // ── Load agent instructions file (Paperclip instruction bundles) ──────
  // Paperclip can materialize managed instructions into instructionsFilePath;
  // when present, inject that bundle into the Hermes prompt.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      const instructionsFileDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}/.`;
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${loadedInstructionsLength} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Non-fatal: log to stdout with an explicit "Warning:" prefix so the
      // Paperclip UI doesn't render this as a red error (stderr output is
      // surfaced as an error signal even when execution continues).
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  let prompt = buildPrompt(ctx, config, { resumedSession: Boolean(prevSessionId && !usingIsolatedHome) });
  if (agentInstructions) {
    prompt = agentInstructions + "\n\n---\n\n" + prompt;
  }

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) === true; // default false
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  // Never pass a placeholder: omit -m so Hermes uses its configured default.
  if (modelArg.arg) {
    args.push("-m", modelArg.arg);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.).
  //
  // Security posture: A --yolo agent process must not persist code or
  // toolchain modifications across runs. In production Docker containers,
  // /opt/hermes is root-owned and non-writable by the runtime node user,
  // and HERMES_DISABLE_LAZY_INSTALLS=1 blocks runtime pip installs so
  // missing optional dependencies fail closed rather than mutating the environment.
  args.push("--yolo");

  if (persistSession && prevSessionId && !usingIsolatedHome) {
    args.push("--resume", prevSessionId);
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Build environment ──────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent),
  };

  // Ensure no duplicate or leaked runtime tools credentials reach the child
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_RUNTIME_TOOLS_")) {
      delete env[key];
    }
  }

  // Ensure Hermes lazy package installation is disabled so the agent
  // fails closed on unavailable optional plugins and never executes runtime pip installs.
  // This is a protected security invariant that cannot be overridden by user config.env.
  env.HERMES_DISABLE_LAZY_INSTALLS = "1";

  // Unconditionally strip forbidden database and credential environment variables
  const strippedForbiddenEnvKeys: string[] = [];
  for (const key of HERMES_FORBIDDEN_ENV_VARS) {
    if (key in env) {
      strippedForbiddenEnvKeys.push(key);
      delete env[key];
    }
  }

  // Unconditionally disable mem0 telemetry on every run
  env.MEM0_TELEMETRY = "False";

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // PAPERCLIP_API_KEY is never accepted from config — the harness-minted run
  // token is the only source of Paperclip API identity.
  delete env.PAPERCLIP_API_KEY;
  if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;

  // BUG FIX: Read task context from ctx.context (wake context), not ctx.config (adapter config)
  const ctxContext = (ctx as any).context || {};
  const envTaskId = cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason = cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
  const envCommentId = cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;
  const wakePayloadJson = stringifyPaperclipWakePayload(ctxContext.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  // ── Resolve working directory ──────────────────────────────────────────
  const cwd =
    cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model ?? "hermes-default"}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (strippedForbiddenEnvKeys.length > 0) {
    await ctx.onLog(
      "stdout",
      `[hermes] Notice: Stripped ${strippedForbiddenEnvKeys.length} forbidden database environment variable(s) from execution environment: ${strippedForbiddenEnvKeys.join(", ")}.\n`,
    );
  } else {
    await ctx.onLog(
      "stdout",
      `[hermes] Notice: Database environment sanitization active (0 forbidden DB env keys present).\n`,
    );
  }

  // Preflight check for runtime memory capability when memory is enabled
  if (memoryConfig != null) {
    const memoryPreflight = await checkHermesMemoryCapability();
    if (!memoryPreflight.available && memoryPreflight.error) {
      await ctx.onLog("stderr", `[hermes] Error: ${memoryPreflight.error}\n`);
      throw new Error(memoryPreflight.error);
    }
  }
  if (prevSessionId) {
    if (usingIsolatedHome) {
      const reason = runtimeMcpServers.length > 0 && memoryConfig != null
        ? "runtime MCP servers and memory"
        : memoryConfig != null
        ? "runtime memory"
        : "runtime MCP servers";
      await ctx.onLog(
        "stdout",
        `[hermes] Resuming session suppressed: isolated HERMES_HOME is active for ${reason}.\n`,
      );
    } else {
      await ctx.onLog(
        "stdout",
        `[hermes] Resuming session: ${prevSessionId}\n`,
      );
    }
  }

  // ── Secret scrubbing ───────────────────────────────────────────────────
  const sensitiveValues: string[] = [];
  if (memoryConfig) {
    sensitiveValues.push(...extractMemorySensitiveValues(memoryConfig));
  }
  for (const s of runtimeMcpServers) {
    if (s.token && s.token.length > 0) {
      if (s.token.length > MAX_CONFIG_STRING_LENGTH) {
        const safeServerName =
          (typeof s.name === "string" ? s.name.replace(/[\r\n\0]/g, " ").trim().slice(0, 100) : "") || "unknown";
        const errorMsg = `Cannot safely redact MCP server token: token for server '${safeServerName}' exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`;
        await ctx.onLog("stderr", `[hermes] Error: ${errorMsg}\n`);
        throw new Error(errorMsg);
      }
      sensitiveValues.push(s.token);
    }
  }
  // Sort descending by length so longer patterns are redacted before shorter ones
  sensitiveValues.sort((a, b) => b.length - a.length);

  // Defense-in-depth pre-spawn credential gate: ensure all collected secrets are within length limits
  // and contain boundary-safe characters before spawning child process.
  for (const secret of sensitiveValues) {
    if (secret.length > MAX_CONFIG_STRING_LENGTH) {
      const errorMsg = `Cannot safely redact sensitive credential: collected secret exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`;
      await ctx.onLog("stderr", `[hermes] Error: ${errorMsg}\n`);
      throw new Error(errorMsg);
    }
    if (!canSafelyRedactSecret(secret)) {
      const errorMsg = "Cannot safely redact sensitive credential: collected secret contains no boundary-safe characters";
      await ctx.onLog("stderr", `[hermes] Error: ${errorMsg}\n`);
      throw new Error(errorMsg);
    }
  }

  const redactor = createChunkAwareStreamingRedactor(sensitiveValues);

  const scrubSecrets = (text: string): string => {
    return redactSensitiveString(text, sensitiveValues);
  };

  const emitClassifiedChunk = async (stream: "stdout" | "stderr", rawChunk: string, redactedChunk: string) => {
    if (stream === "stderr") {
      // Evaluate raw lines before redaction so short-secret replacements (e.g. replacing milliseconds in timestamps)
      // do not cause benign log patterns to fail classification.
      if (rawChunk.includes("\n") || rawChunk.includes("\r")) {
        const rawLines = rawChunk.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g) || [rawChunk];
        const redactedLines = redactedChunk.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g) || [redactedChunk];
        for (let i = 0; i < rawLines.length; i++) {
          const rawLine = rawLines[i];
          const redactedLine = redactedLines[i] ?? scrubSecrets(rawLine);
          const streamToUse = isBenignStderrLog(rawLine) ? "stdout" : "stderr";
          await ctx.onLog(streamToUse, redactedLine);
        }
        return;
      }
      const streamToUse = isBenignStderrLog(rawChunk) ? "stdout" : "stderr";
      return ctx.onLog(streamToUse, redactedChunk);
    }
    return ctx.onLog(stream, redactedChunk);
  };

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Classify raw chunks with isBenignStderrLog before redaction, while passing only
  // the redacted text downstream for storage and display.
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    const items = redactor.processDetailed(stream, chunk);
    for (const item of items) {
      await emitClassifiedChunk(stream, item.raw, item.redacted);
    }
  };

  const onCleanupWarning = (msg: string) => {
    void ctx.onLog("stdout", `[hermes] Warning: ${msg}\n`).catch(() => {});
  };

  let tempHome: string | null = null;
  try {
    if (usingIsolatedHome) {
      const preparedHome = await prepareHermesMcpHome({
        servers: runtimeMcpServers,
        memory: memoryConfig ?? undefined,
        config,
        onWarning: onCleanupWarning,
      });
      tempHome = preparedHome.homeDir;
      env.HERMES_HOME = tempHome;
      Object.assign(env, preparedHome.env);
      if (preparedHome.providerEnv) {
        for (const [key, value] of Object.entries(preparedHome.providerEnv)) {
          if (env[key] === undefined) {
            env[key] = value;
          }
        }
      }
      if (runtimeMcpServers.length > 0 && memoryConfig != null) {
        await ctx.onLog(
          "stdout",
          `[hermes] Prepared isolated HERMES_HOME with runtime memory and ${runtimeMcpServers.length} runtime MCP server(s).\n`,
        );
      } else if (memoryConfig != null) {
        await ctx.onLog(
          "stdout",
          `[hermes] Prepared isolated HERMES_HOME with runtime memory.\n`,
        );
      } else {
        await ctx.onLog(
          "stdout",
          `[hermes] Prepared isolated HERMES_HOME with ${runtimeMcpServers.length} runtime MCP server(s).\n`,
        );
      }
    }

    // Re-enforce protected security invariants after all runtime profile & provider merges
    env.HERMES_DISABLE_LAZY_INSTALLS = "1";

    const result = await runChildProcess(ctx.runId, hermesCmd, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
      unsetEnvKeys: HERMES_FORBIDDEN_ENV_VARS,
    });

    const flushedLogs = redactor.flushDetailed();
    for (const fl of flushedLogs) {
      await emitClassifiedChunk(fl.stream, fl.rawChunk, fl.chunk);
    }

    // ── Parse output ───────────────────────────────────────────────────────
    const scrubbedStdout = scrubSecrets(result.stdout || "");
    const scrubbedStderr = scrubSecrets(result.stderr || "");
    const parsed = parseHermesOutput(scrubbedStdout, scrubbedStderr);

    await ctx.onLog(
      "stdout",
      `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
    );
    if (parsed.sessionId) {
      await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
    }

    // ── Build result ───────────────────────────────────────────────────────
    const executionResult: AdapterExecutionResult = {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      provider: resolvedProvider,
      model,
    };

    if (usingIsolatedHome) {
      executionResult.clearSession = true;
    }

    if (parsed.errorMessage) {
      executionResult.errorMessage = augmentStaleImageError(
        scrubSecrets(parsed.errorMessage),
        memoryConfig,
        scrubbedStderr,
      );
    } else if (!result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0) {
      executionResult.errorMessage = augmentStaleImageError(
        `Hermes exited with code ${result.exitCode}`,
        memoryConfig,
        scrubbedStderr,
      );
    }

    if (parsed.usage) {
      executionResult.usage = parsed.usage;
    }

    if (parsed.costUsd !== undefined) {
      executionResult.costUsd = parsed.costUsd;
    }

    // Summary from agent response
    if (parsed.response) {
      executionResult.summary = scrubSecrets(parsed.response.slice(0, 2000));
    }

    // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
    executionResult.resultJson = {
      result: scrubSecrets(parsed.response || ""),
      session_id: parsed.sessionId || null,
      usage: parsed.usage || null,
      cost_usd: parsed.costUsd ?? null,
    };

    // Store session ID for next run
    if (persistSession && parsed.sessionId && !usingIsolatedHome) {
      executionResult.sessionParams = { sessionId: parsed.sessionId };
      executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
    }

    return executionResult;
  } finally {
    const remainingFlushed = redactor.flushDetailed();
    for (const fl of remainingFlushed) {
      await emitClassifiedChunk(fl.stream, fl.rawChunk, fl.chunk).catch(() => {});
    }
    if (tempHome) {
      await cleanupHermesMcpHome(tempHome, onCleanupWarning);
    }
  }
}

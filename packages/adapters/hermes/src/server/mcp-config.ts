import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";

import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { resolveHostHermesDir, resolveHostHermesSkillsDir } from "./skills.js";

export interface HermesMcpServerConfig {
  url: string;
  headers: {
    Authorization: string;
  };
  enabled: true;
  skip_preflight: true;
  tools: {
    resources: false;
    prompts: false;
    include: string[];
  };
}

export interface PrepareHermesMcpHomeOptions {
  servers: AdapterRuntimeMcpServer[];
  config?: Record<string, unknown>;
  tempDirPrefix?: string;
  onWarning?: (msg: string) => void;
}

export interface PreparedHermesMcpHome {
  homeDir: string;
  configPath: string;
  envPath: string;
  env: Record<string, string>;
  providerEnv: Record<string, string>;
  serverCount: number;
}

/**
 * Closed allowlist of top-level keys in host `config.yaml` permitted to be inherited
 * into the isolated temporary profile configuration.
 *
 * Excludes host `mcp_servers`, `memory`, `database`/`session`/`state`, `telemetry`,
 * and browser/messaging integrations to guarantee strictly isolated, ephemeral state.
 */
export const ALLOWED_HOST_CONFIG_KEYS = new Set([
  "model",
  "provider",
  "temperature",
  "top_p",
  "max_tokens",
  "context_window",
  "code_execution",
  "command_allowlist",
  "tool_loop_guardrails",
  "prompt_caching",
  "streaming",
  "compression",
]);

/**
 * Closed allowlist of provider credential and endpoint environment variable names
 * permitted to be inherited from host `.env`.
 *
 * These variables are injected directly into the child process environment only,
 * never copied to the temporary `.env` file or logged.
 */
export const HERMES_PROVIDER_ENV_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "MISTRAL_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "GROQ_API_KEY",
  "GROQ_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_HOST",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_ANTHROPIC_KEY",
  "DASHSCOPE_API_KEY",
  "GLM_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CN_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MINIMAX_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "NOUS_API_KEY",
  "NOUS_BASE_URL",
  "NOUS_PORTAL_URL",
  "ARCEEAI_API_KEY",
  "GMI_API_KEY",
  "KILOCODE_API_KEY",
  "XIAOMI_API_KEY",
  "TOKENHUB_API_KEY",
  "NOVITA_API_KEY",
  "NVIDIA_API_KEY",
  "STEPFUN_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "OPENCODE_GO_API_KEY",
  "COHERE_API_KEY",
  "BEDROCK_AWS_ACCESS_KEY_ID",
  "BEDROCK_AWS_SECRET_ACCESS_KEY",
  "BEDROCK_AWS_REGION",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "ANYSCALE_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
  "HYPERBOLIC_API_KEY",
]);

/**
 * Validates that an MCP server definition meets security and protocol constraints.
 * Fails closed if any field contains CR/LF, invalid characters, or lacks a finite tool allowlist.
 * Rejects glob metacharacters (*, ?, [, ]) in tool names to preserve exact bare name semantics.
 */
export function validateMcpServer(server: AdapterRuntimeMcpServer): void {
  if (!server || typeof server !== "object") {
    throw new Error("Invalid MCP server: expected server object");
  }

  if (typeof server.name !== "string" || server.name.trim().length === 0) {
    throw new Error("Invalid MCP server: name must be a non-empty string");
  }
  if (/[\r\n\0]/.test(server.name)) {
    throw new Error(`Invalid MCP server name "${server.name}": contains control characters or newlines`);
  }

  if (typeof server.url !== "string" || !/^https?:\/\//i.test(server.url.trim())) {
    throw new Error(`Invalid MCP server URL for "${server.name}": must be an HTTP or HTTPS URL`);
  }
  if (/[\r\n\0]/.test(server.url)) {
    throw new Error(`Invalid MCP server URL for "${server.name}": contains control characters or newlines`);
  }

  if (typeof server.token !== "string" || server.token.length === 0) {
    throw new Error(`Invalid MCP server token for "${server.name}": token must be non-empty`);
  }
  if (/[\r\n\0]/.test(server.token)) {
    throw new Error(`Unsafe token for MCP server "${server.name}": token contains control characters or newlines`);
  }

  if (!Array.isArray(server.allowedTools) || server.allowedTools.length === 0) {
    throw new Error(`Cannot configure Hermes MCP server "${server.name}": no allowed tools provided; a finite non-empty allowlist is required`);
  }
  for (const tool of server.allowedTools) {
    if (typeof tool !== "string" || tool.trim().length === 0) {
      throw new Error(`Invalid tool name in allowlist for MCP server "${server.name}": must be a non-empty string`);
    }
    if (/[\r\n\0]/.test(tool)) {
      throw new Error(`Invalid tool name "${tool}" for MCP server "${server.name}": contains control characters or newlines`);
    }
    if (/[*?\[\]{}]/.test(tool)) {
      throw new Error(`Invalid tool name "${tool}" for MCP server "${server.name}": contains glob metacharacters (*, ?, [, ], {, })`);
    }
  }
}

/**
 * Sanitizes a server name for use as a key in Hermes `mcp_servers`.
 * Collisions are handled deterministically using the connectionId and an incrementing suffix.
 */
export function sanitizeServerKey(rawName: string, connectionId: string, usedKeys: Set<string>): string {
  const sanitized = rawName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  let key = sanitized.length > 0 ? sanitized : "mcp_server";

  if (usedKeys.has(key)) {
    const connSuffix = (connectionId || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 16);
    if (connSuffix.length > 0) {
      key = `${key}_${connSuffix}`;
    }
  }

  let counter = 2;
  const baseKey = key;
  while (usedKeys.has(key)) {
    key = `${baseKey}_${counter}`;
    counter++;
  }
  usedKeys.add(key);
  return key;
}

/**
 * Derives a deterministic environment variable name for an MCP server's bearer token.
 */
export function sanitizeEnvVarName(serverKey: string, usedEnvVars: Set<string>): string {
  const upper = serverKey.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const baseVar = `HERMES_MCP_TOKEN_${upper}`;
  let envVar = baseVar;
  let counter = 2;
  while (usedEnvVars.has(envVar)) {
    envVar = `${baseVar}_${counter}`;
    counter++;
  }
  usedEnvVars.add(envVar);
  return envVar;
}

/**
 * Safely parses and sanitizes host config YAML content using a real YAML parser.
 * Fail-closed: returns empty string if rawYaml is empty, invalid, multi-document,
 * or not a mapping/object. Retains only exact keys matching ALLOWED_HOST_CONFIG_KEYS.
 */
export function sanitizeHostConfigYaml(rawYaml: string): string {
  if (!rawYaml || typeof rawYaml !== "string" || rawYaml.trim().length === 0) {
    return "";
  }

  let docs: YAML.Document.Parsed[];
  try {
    docs = YAML.parseAllDocuments(rawYaml);
  } catch {
    return "";
  }

  // Reject multi-document YAML fail-closed
  if (docs.length !== 1) {
    return "";
  }

  const doc = docs[0];
  if (!doc || doc.errors.length > 0 || doc.contents === null) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = doc.toJS();
  } catch {
    return "";
  }

  // Require a mapping / plain object
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "";
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (ALLOWED_HOST_CONFIG_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return "";
  }

  return YAML.stringify(sanitized).trim();
}

/**
 * Filters host .env content through HERMES_PROVIDER_ENV_ALLOWLIST using dotenv.parse.
 */
export function filterProviderEnv(dotenvContent: string): Record<string, string> {
  if (!dotenvContent || typeof dotenvContent !== "string") return {};

  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(dotenvContent);
  } catch {
    return {};
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (HERMES_PROVIDER_ENV_ALLOWLIST.has(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}

/**
 * Deterministically serializes Hermes MCP configuration to YAML format.
 * Quotes all strings safely to guarantee valid PyYAML parsing without third-party dependencies.
 * Emits `resources: false` and `prompts: false` to disable utility tool generation.
 */
export function serializeHermesMcpYaml(
  mcpServers: Record<string, HermesMcpServerConfig>,
  inheritedHostYaml = "",
): string {
  const lines: string[] = [];

  const trimmedHost = inheritedHostYaml.trim();
  if (trimmedHost.length > 0) {
    lines.push(trimmedHost);
    lines.push("");
  }

  lines.push("mcp_servers:");
  for (const [key, server] of Object.entries(mcpServers)) {
    lines.push(`  ${key}:`);
    lines.push(`    url: ${JSON.stringify(server.url)}`);
    lines.push("    headers:");
    lines.push(`      Authorization: ${JSON.stringify(server.headers.Authorization)}`);
    lines.push("    enabled: true");
    lines.push("    skip_preflight: true");
    lines.push("    tools:");
    lines.push("      resources: false");
    lines.push("      prompts: false");
    lines.push("      include:");
    for (const tool of server.tools.include) {
      lines.push(`        - ${JSON.stringify(tool)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Serializes environment variables into `.env` format.
 */
export function serializeHermesDotenv(envVars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(envVars)) {
    // Quote with JSON.stringify for safe dotenv parsing
    lines.push(`${key}=${JSON.stringify(val)}`);
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

/**
 * Cleans up stale ephemeral Paperclip run profiles under `<hostHermesHome>/profiles`.
 * Scoped safely strictly to directories starting with `paperclip-run-`.
 */
export async function cleanupStaleHermesProfiles(
  profilesDir: string,
  maxAgeMs = 24 * 3600_000,
  onWarning?: (msg: string) => void,
): Promise<void> {
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("paperclip-run-")) {
        continue;
      }
      const dirPath = path.join(profilesDir, entry.name);
      try {
        const stat = await fs.stat(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(dirPath, { recursive: true, force: true });
        }
      } catch {
        // Non-fatal per-directory cleanup
      }
    }
  } catch {
    if (onWarning) {
      onWarning("Stale profile directory cleanup warning");
    }
  }
}

/**
 * Prepares an isolated HERMES_HOME temporary directory for a run with runtime MCP servers.
 *
 * Security & Isolation invariants:
 * - Temporary profile created under `<hostHermesHome>/profiles/` with permissions 0700.
 *   This ensures Hermes's built-in global auth fallback resolves `<hostHermesHome>/auth.json`
 *   as read-only, while all runtime writes remain confined to the ephemeral profile.
 * - Host auth.json is NEVER symlinked or written through.
 * - config.yaml and .env written with permissions 0600.
 * - Host config posture (model/provider/guardrails) is inherited through a strict closed allowlist;
 *   host mcp_servers, memory, state, database, and telemetry are strictly excluded.
 * - Runtime MCP server definitions emit `resources: false` and `prompts: false`.
 * - Raw MCP tokens are placed in temp .env (mode 0600) and referenced via ${ENV_VAR}.
 * - Host provider credentials from .env are filtered by closed allowlist and returned for child process
 *   env injection only, never copied to temp .env or logged.
 * - Host skills are safely symlinked (read-only reference).
 */
export async function prepareHermesMcpHome(
  options: PrepareHermesMcpHomeOptions,
): Promise<PreparedHermesMcpHome> {
  const { servers, config } = options;
  if (!servers || servers.length === 0) {
    throw new Error("Cannot prepare Hermes MCP home: no servers provided");
  }

  // Validate all servers before creating temp directory
  for (const server of servers) {
    validateMcpServer(server);
  }

  const hostHermesDir = resolveHostHermesDir(config);
  let homeDir: string;

  if (options.tempDirPrefix) {
    homeDir = await fs.mkdtemp(options.tempDirPrefix);
  } else {
    const profilesDir = path.join(hostHermesDir, "profiles");
    try {
      await fs.mkdir(profilesDir, { recursive: true, mode: 0o700 });
      try {
        await fs.chmod(profilesDir, 0o700);
      } catch {
        if (options.onWarning) {
          options.onWarning("Failed to tighten permissions on Hermes profiles directory");
        }
      }
    } catch {
      throw new Error("Cannot create Hermes profiles directory for isolated execution");
    }

    // Clean up stale orphaned paperclip-run-* profile directories older than 24 hours.
    // Run tokens have a TTL of 1 hour, so any run profile older than 24 hours is
    // definitively dead/orphaned from an ungraceful crash or process termination.
    // Active runs are never impacted. Normal runs are cleaned up by finally blocks.
    await cleanupStaleHermesProfiles(profilesDir, 24 * 3600_000, options.onWarning);

    try {
      homeDir = await fs.mkdtemp(path.join(profilesDir, "paperclip-run-"));
    } catch {
      throw new Error("Cannot create temporary profile directory in Hermes profiles directory");
    }
  }

  try {
    await fs.chmod(homeDir, 0o700);
    const usedServerKeys = new Set<string>();
    const usedEnvVars = new Set<string>();
    const mcpServers: Record<string, HermesMcpServerConfig> = {};
    const envRecord: Record<string, string> = {};

    for (const server of servers) {
      const serverKey = sanitizeServerKey(server.name, server.connectionId, usedServerKeys);
      const envVar = sanitizeEnvVarName(serverKey, usedEnvVars);

      // Deduplicate tools preserving order
      const tools = Array.from(new Set(server.allowedTools));

      mcpServers[serverKey] = {
        url: server.url,
        headers: {
          Authorization: `Bearer \${${envVar}}`,
        },
        enabled: true,
        skip_preflight: true,
        tools: {
          resources: false,
          prompts: false,
          include: tools,
        },
      };
      envRecord[envVar] = server.token;
    }

    // 1. Inherit sanitized host config posture
    let inheritedHostYaml = "";
    try {
      const hostConfigPath = path.join(hostHermesDir, "config.yaml");
      const hostConfigContent = await fs.readFile(hostConfigPath, "utf8");
      inheritedHostYaml = sanitizeHostConfigYaml(hostConfigContent);
    } catch {
      // Host config absent or unreadable; proceed with runtime MCP configuration only
    }

    // 2. Inherit provider secrets from host .env (filtered by closed allowlist)
    let providerEnv: Record<string, string> = {};
    try {
      const hostEnvPath = path.join(hostHermesDir, ".env");
      const hostEnvContent = await fs.readFile(hostEnvPath, "utf8");
      providerEnv = filterProviderEnv(hostEnvContent);
    } catch {
      // Host .env absent or unreadable
    }

    const configPath = path.join(homeDir, "config.yaml");
    const envPath = path.join(homeDir, ".env");

    const yamlContent = serializeHermesMcpYaml(mcpServers, inheritedHostYaml);
    await fs.writeFile(configPath, yamlContent, { mode: 0o600 });
    await fs.chmod(configPath, 0o600);

    // Temp .env contains strictly run MCP tokens, never host provider secrets
    await fs.writeFile(envPath, serializeHermesDotenv(envRecord), { mode: 0o600 });
    await fs.chmod(envPath, 0o600);

    // Symlink host skills if present
    const hostSkillsDir = resolveHostHermesSkillsDir(config);
    try {
      const stat = await fs.stat(hostSkillsDir);
      if (stat.isDirectory()) {
        await fs.symlink(hostSkillsDir, path.join(homeDir, "skills"), "dir");
      }
    } catch {
      // Host skills directory does not exist or is inaccessible
    }

    return {
      homeDir,
      configPath,
      envPath,
      env: envRecord,
      providerEnv,
      serverCount: servers.length,
    };
  } catch (error) {
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Removes the isolated HERMES_HOME temporary directory.
 */
export async function cleanupHermesMcpHome(
  homeDir: string | null | undefined,
  onWarning?: (msg: string) => void,
): Promise<void> {
  if (!homeDir) return;
  try {
    await fs.rm(homeDir, { recursive: true, force: true });
  } catch {
    if (onWarning) {
      onWarning("Temporary Hermes home cleanup encountered an error");
    }
  }
}

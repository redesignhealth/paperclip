import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { resolveHermesHome } from "./skills.js";

export interface HermesMcpServerConfig {
  url: string;
  headers: {
    Authorization: string;
  };
  enabled: true;
  skip_preflight: true;
  tools: {
    include: string[];
  };
}

export interface PrepareHermesMcpHomeOptions {
  servers: AdapterRuntimeMcpServer[];
  config?: Record<string, unknown>;
  tempDirPrefix?: string;
}

export interface PreparedHermesMcpHome {
  homeDir: string;
  configPath: string;
  envPath: string;
  env: Record<string, string>;
  serverCount: number;
}

/**
 * Validates that an MCP server definition meets security and protocol constraints.
 * Fails closed if any field contains CR/LF, invalid characters, or lacks a finite tool allowlist.
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
 * Deterministically serializes Hermes MCP configuration to YAML format.
 * Quotes all strings safely to guarantee valid PyYAML parsing without third-party dependencies.
 */
export function serializeHermesMcpYaml(mcpServers: Record<string, HermesMcpServerConfig>): string {
  const lines: string[] = ["mcp_servers:"];
  for (const [key, server] of Object.entries(mcpServers)) {
    lines.push(`  ${key}:`);
    lines.push(`    url: ${JSON.stringify(server.url)}`);
    lines.push("    headers:");
    lines.push(`      Authorization: ${JSON.stringify(server.headers.Authorization)}`);
    lines.push("    enabled: true");
    lines.push("    skip_preflight: true");
    lines.push("    tools:");
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
 * Prepares an isolated HERMES_HOME temporary directory for a run with runtime MCP servers.
 *
 * Security & Isolation invariants:
 * - Temporary directory created with permissions 0700.
 * - config.yaml and .env written with permissions 0600.
 * - Only runtime-scoped MCP servers are written to config.yaml.
 * - Raw tokens are NEVER placed in config.yaml; they are placed in .env and referenced via ${ENV_VAR}.
 * - Host ~/.hermes/config.yaml and ~/.hermes/.env are never copied or merged.
 * - Hermes skills from the host are safely symlinked (if present) so existing skills remain
 *   available to the agent without copying files or mutating host installations.
 * - Session state and SQLite state.db are intentionally omitted (ephemeral per-run state).
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

  const prefix = options.tempDirPrefix ?? path.join(os.tmpdir(), "paperclip-hermes-home-");
  const homeDir = await fs.mkdtemp(prefix);
  await fs.chmod(homeDir, 0o700);

  try {
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
          include: tools,
        },
      };
      envRecord[envVar] = server.token;
    }

    const configPath = path.join(homeDir, "config.yaml");
    const envPath = path.join(homeDir, ".env");

    await fs.writeFile(configPath, serializeHermesMcpYaml(mcpServers), { mode: 0o600 });
    await fs.chmod(configPath, 0o600);

    await fs.writeFile(envPath, serializeHermesDotenv(envRecord), { mode: 0o600 });
    await fs.chmod(envPath, 0o600);

    // Preserve skills safely via symlink:
    // Symlinking rather than copying avoids replicating files, ensures Paperclip-reconciled
    // skills and host skills are accessible, and guarantees host files are not mutated or deleted
    // when the temporary home directory is unlinked.
    if (config) {
      const hostSkillsDir = path.join(resolveHermesHome(config), ".hermes", "skills");
      try {
        const stat = await fs.stat(hostSkillsDir);
        if (stat.isDirectory()) {
          await fs.symlink(hostSkillsDir, path.join(homeDir, "skills"), "dir");
        }
      } catch {
        // Host skills directory does not exist or is inaccessible; leave skills unlinked
      }
    }

    return {
      homeDir,
      configPath,
      envPath,
      env: envRecord,
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
export async function cleanupHermesMcpHome(homeDir: string | null | undefined): Promise<void> {
  if (!homeDir) return;
  await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
}

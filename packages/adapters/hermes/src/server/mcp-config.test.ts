import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  prepareHermesMcpHome,
  cleanupHermesMcpHome,
  cleanupStaleHermesProfiles,
  sanitizeServerKey,
  sanitizeEnvVarName,
  sanitizeHostConfigYaml,
  filterProviderEnv,
  serializeHermesMcpYaml,
  serializeHermesDotenv,
  validateMcpServer,
  ALLOWED_HOST_CONFIG_KEYS,
  HERMES_PROVIDER_ENV_ALLOWLIST,
} from "./mcp-config.js";
import { resolveHermesHome, resolveHostHermesSkillsDir } from "./skills.js";

describe("Hermes MCP Config", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  describe("Validation & Rejection", () => {
    it("rejects tokens containing carriage return or newline or null byte", () => {
      const baseServer: AdapterRuntimeMcpServer = {
        name: "test-server",
        url: "https://mcp.example.com",
        token: "clean-token",
        connectionId: "conn-1",
        allowedTools: ["tool1"],
      };

      expect(() => validateMcpServer({ ...baseServer, token: "bad\ntoken" })).toThrow(
        /Unsafe token for MCP server/,
      );
      expect(() => validateMcpServer({ ...baseServer, token: "bad\rtoken" })).toThrow(
        /Unsafe token for MCP server/,
      );
      expect(() => validateMcpServer({ ...baseServer, token: "bad\r\ntoken" })).toThrow(
        /Unsafe token for MCP server/,
      );
      expect(() => validateMcpServer({ ...baseServer, token: "bad\0token" })).toThrow(
        /Unsafe token for MCP server/,
      );
    });

    it("rejects empty token", () => {
      expect(() =>
        validateMcpServer({
          name: "test-server",
          url: "https://mcp.example.com",
          token: "",
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).toThrow(/token must be non-empty/);
    });

    it("rejects non-HTTP/HTTPS URLs and URLs with CR/LF", () => {
      const baseServer: AdapterRuntimeMcpServer = {
        name: "test-server",
        url: "ftp://mcp.example.com",
        token: "tok",
        connectionId: "conn-1",
        allowedTools: ["tool1"],
      };

      expect(() => validateMcpServer(baseServer)).toThrow(/must be an HTTP or HTTPS URL/);
      expect(() =>
        validateMcpServer({ ...baseServer, url: "https://mcp.example.com\n" }),
      ).toThrow(/contains control characters or newlines/);
    });

    it("rejects server names with CR/LF", () => {
      expect(() =>
        validateMcpServer({
          name: "test\nserver",
          url: "https://mcp.example.com",
          token: "tok",
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).toThrow(/contains control characters or newlines/);
    });

    it("fails closed when allowedTools is empty or missing or contains invalid tools", () => {
      const baseServer = {
        name: "test-server",
        url: "https://mcp.example.com",
        token: "tok",
        connectionId: "conn-1",
      };

      expect(() => validateMcpServer({ ...baseServer, allowedTools: [] })).toThrow(
        /no allowed tools provided; a finite non-empty allowlist is required/,
      );
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: undefined as unknown as string[] }),
      ).toThrow(/no allowed tools provided/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["valid_tool", "bad\ntool"] }),
      ).toThrow(/contains control characters or newlines/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: [""] }),
      ).toThrow(/must be a non-empty string/);
    });

    it("rejects unsafe glob metacharacters (*, ?, [, ]) in tool names", () => {
      const baseServer = {
        name: "test-server",
        url: "https://mcp.example.com",
        token: "tok",
        connectionId: "conn-1",
      };

      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["tool*"] }),
      ).toThrow(/contains glob metacharacters/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["tool?"] }),
      ).toThrow(/contains glob metacharacters/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["tool[1-3]"] }),
      ).toThrow(/contains glob metacharacters/);
    });

    it("accepts valid tool names with punctuation without prefixes (verbatim names)", () => {
      const baseServer: AdapterRuntimeMcpServer = {
        name: "test-server",
        url: "https://mcp.example.com",
        token: "tok",
        connectionId: "conn-1",
        allowedTools: [
          "connections_search",
          "connection-request",
          "mcp.github-app:create_issue",
          "v1.tool.read",
        ],
      };

      expect(() => validateMcpServer(baseServer)).not.toThrow();
    });
  });

  describe("Sanitization & Collision Handling", () => {
    it("sanitizes server keys deterministically", () => {
      const usedKeys = new Set<string>();
      const k1 = sanitizeServerKey("Paperclip connections", "conn-1", usedKeys);
      expect(k1).toBe("paperclip_connections");

      const k2 = sanitizeServerKey("paperclip-assigned", "conn-2", usedKeys);
      expect(k2).toBe("paperclip_assigned");
    });

    it("resolves duplicate server names deterministically using connectionId and counter", () => {
      const usedKeys = new Set<string>();
      const k1 = sanitizeServerKey("Paperclip connections", "conn-alpha-1234", usedKeys);
      const k2 = sanitizeServerKey("Paperclip connections", "conn-beta-5678", usedKeys);
      const k3 = sanitizeServerKey("Paperclip connections", "conn-beta-5678", usedKeys);

      expect(k1).toBe("paperclip_connections");
      expect(k2).toBe("paperclip_connections_conn_beta_5678");
      expect(k3).toBe("paperclip_connections_conn_beta_5678_2");
    });

    it("sanitizes env var names deterministically and avoids collisions", () => {
      const usedEnvVars = new Set<string>();
      const v1 = sanitizeEnvVarName("paperclip_connections", usedEnvVars);
      expect(v1).toBe("HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS");

      const v2 = sanitizeEnvVarName("paperclip_connections", usedEnvVars);
      expect(v2).toBe("HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS_2");
    });
  });

  describe("Host Config & Provider Env Sanitization", () => {
    it("inherits only allowed provider/runtime posture keys from host config.yaml", () => {
      const rawHostConfig = `
model:
  default: "anthropic/claude-3-7-sonnet"
  provider: "anthropic"

mcp_servers:
  forbidden_host_server:
    url: "http://malicious.local/mcp"

memory:
  enabled: true
  dir: "/host/memories"

database:
  path: "/host/state.db"

telemetry:
  enabled: true

browser:
  enabled: true

slack:
  token: "xoxb-secret"

terminal:
  enabled: true

providers:
  custom_provider:
    api_key: "nested-secret"

tool_loop_guardrails:
  max_iterations: 25

code_execution:
  timeout: 60
`;

      const sanitized = sanitizeHostConfigYaml(rawHostConfig);

      expect(sanitized).toContain("model:\n  default: \"anthropic/claude-3-7-sonnet\"\n  provider: \"anthropic\"");
      expect(sanitized).toContain("tool_loop_guardrails:\n  max_iterations: 25");
      expect(sanitized).toContain("code_execution:\n  timeout: 60");

      // Strictly excludes dangerous/stateful/integration sections and nested unredacted credential sections
      expect(sanitized).not.toContain("mcp_servers:");
      expect(sanitized).not.toContain("forbidden_host_server");
      expect(sanitized).not.toContain("memory:");
      expect(sanitized).not.toContain("database:");
      expect(sanitized).not.toContain("telemetry:");
      expect(sanitized).not.toContain("browser:");
      expect(sanitized).not.toContain("slack:");
      expect(sanitized).not.toContain("terminal:");
      expect(sanitized).not.toContain("providers:");
      expect(sanitized).not.toContain("nested-secret");

      expect(ALLOWED_HOST_CONFIG_KEYS.has("terminal")).toBe(false);
      expect(ALLOWED_HOST_CONFIG_KEYS.has("providers")).toBe(false);
    });

    it("filters host .env secrets using closed provider allowlist and includes auth aliases", () => {
      const rawDotenv = `
# Core AI credentials and aliases
ANTHROPIC_API_KEY="sk-ant-123"
ANTHROPIC_TOKEN="ant-token"
CLAUDE_CODE_OAUTH_TOKEN="claude-token"
OPENAI_BASE_URL=https://custom.openai.api/v1
OPENROUTER_API_KEY=sk-or-456
GOOGLE_API_KEY=AIzaSyTest
AWS_SESSION_TOKEN="aws-session-token"

# Unsafe/host secrets (must be omitted)
DATABASE_URL=postgres://user:pass@localhost:5432/db
PAPERCLIP_RUNTIME_TOOLS_TOKEN=rt-secret-123
SLACK_BOT_TOKEN=xoxb-1234
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_secret
AWS_SECRET_ACCESS_KEY="aws-secret-789"
`;

      const filtered = filterProviderEnv(rawDotenv);

      expect(filtered.ANTHROPIC_API_KEY).toBe("sk-ant-123");
      expect(filtered.ANTHROPIC_TOKEN).toBe("ant-token");
      expect(filtered.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-token");
      expect(filtered.OPENAI_BASE_URL).toBe("https://custom.openai.api/v1");
      expect(filtered.OPENROUTER_API_KEY).toBe("sk-or-456");
      expect(filtered.GOOGLE_API_KEY).toBe("AIzaSyTest");
      expect(filtered.AWS_SESSION_TOKEN).toBe("aws-session-token");
      expect(filtered.AWS_SECRET_ACCESS_KEY).toBe("aws-secret-789");

      // Verify closed allowlist contains required aliases
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("ANTHROPIC_TOKEN")).toBe(true);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_SESSION_TOKEN")).toBe(true);

      // Denies non-allowlisted credentials
      expect(filtered.DATABASE_URL).toBeUndefined();
      expect(filtered.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBeUndefined();
      expect(filtered.SLACK_BOT_TOKEN).toBeUndefined();
      expect(filtered.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    });
  });

  describe("YAML and Dotenv Serialization", () => {
    it("serializes config.yaml containing only runtime-scoped MCP servers with resources and prompts false", () => {
      const mcpServers = {
        paperclip_connections: {
          url: "https://api.paperclip.test/mcp/runtime-tools",
          headers: {
            Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS}",
          },
          enabled: true as const,
          skip_preflight: true as const,
          tools: {
            resources: false as const,
            prompts: false as const,
            include: ["connections_search", "connection_request"],
          },
        },
      };

      const yaml = serializeHermesMcpYaml(mcpServers);
      expect(yaml).toContain("mcp_servers:\n");
      expect(yaml).toContain("  paperclip_connections:\n");
      expect(yaml).toContain('    url: "https://api.paperclip.test/mcp/runtime-tools"\n');
      expect(yaml).toContain('      Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS}"\n');
      expect(yaml).toContain("    enabled: true\n");
      expect(yaml).toContain("    skip_preflight: true\n");
      expect(yaml).toContain("    tools:\n");
      expect(yaml).toContain("      resources: false\n");
      expect(yaml).toContain("      prompts: false\n");
      expect(yaml).toContain("      include:\n");
      expect(yaml).toContain('        - "connections_search"\n');
      expect(yaml).toContain('        - "connection_request"\n');

      // Verify no raw token is in the YAML
      expect(yaml).not.toContain("raw-secret-token");
    });

    it("serializes .env safely quoting strings", () => {
      const envVars = {
        HERMES_MCP_TOKEN_SRV1: "token-value-123",
        HERMES_MCP_TOKEN_SRV2: 'token-with-"quotes"&symbols',
      };
      const dotenv = serializeHermesDotenv(envVars);
      expect(dotenv).toContain('HERMES_MCP_TOKEN_SRV1="token-value-123"\n');
      expect(dotenv).toContain('HERMES_MCP_TOKEN_SRV2="token-with-\\"quotes\\"&symbols"\n');
    });

    it("ensures PyYAML parses the generated config.yaml faithfully", () => {
      const mcpServers = {
        paperclip_assigned: {
          url: "http://127.0.0.1:3100/mcp/gateways/gw_abc",
          headers: {
            Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED}",
          },
          enabled: true as const,
          skip_preflight: true as const,
          tools: {
            resources: false as const,
            prompts: false as const,
            include: ["mcp.github-app:create_issue", "mcp.github-app:get_issue"],
          },
        },
      };

      const yamlText = serializeHermesMcpYaml(mcpServers);
      try {
        const pythonResult = execFileSync(
          "python3",
          [
            "-c",
            `
import yaml, json, sys
data = yaml.safe_load(sys.stdin.read())
print(json.dumps(data))
`,
          ],
          { input: yamlText, encoding: "utf8" },
        );
        const parsed = JSON.parse(pythonResult);
        expect(parsed).toEqual({
          mcp_servers: {
            paperclip_assigned: {
              url: "http://127.0.0.1:3100/mcp/gateways/gw_abc",
              headers: {
                Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED}",
              },
              enabled: true,
              skip_preflight: true,
              tools: {
                resources: false,
                prompts: false,
                include: ["mcp.github-app:create_issue", "mcp.github-app:get_issue"],
              },
            },
          },
        });
      } catch (err) {
        // Skip PyYAML check if python3 or pyyaml is not available in environment
        if ((err as { code?: string }).code === "ENOENT") {
          return;
        }
        throw err;
      }
    });
  });

  describe("prepareHermesMcpHome", () => {
    it("creates isolated temp profile under ~/.hermes/profiles with config.yaml and .env", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-home-"));
      cleanupDirs.push(mockHome);

      const hostHermesDir = path.join(mockHome, ".hermes");
      await fs.mkdir(hostHermesDir, { recursive: true });

      // Write mock host config.yaml and .env
      await fs.writeFile(
        path.join(hostHermesDir, "config.yaml"),
        "model:\n  default: 'openai-codex/gpt-5'\n\nmemory:\n  enabled: true\n",
      );
      await fs.writeFile(
        path.join(hostHermesDir, ".env"),
        "OPENAI_API_KEY=sk-host-key\nDATABASE_URL=postgres://unsafe\n",
      );

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "paperclip-assigned",
          url: "http://localhost:3100/mcp/gateways/gw_1",
          token: "pcgw_assigned_secret",
          connectionId: "conn-assigned",
          allowedTools: ["mcp.tool:one", "mcp.tool:two"],
        },
      ];

      const prepared = await prepareHermesMcpHome({
        servers,
        config: { env: { HOME: mockHome } },
      });
      cleanupDirs.push(prepared.homeDir);

      // Verify temp profile directory is created under <hostHermesHome>/profiles/paperclip-run-
      expect(prepared.homeDir).toContain(path.join(mockHome, ".hermes", "profiles", "paperclip-run-"));

      // Verify directory permissions 0700
      const dirStat = await fs.stat(prepared.homeDir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      // Verify config.yaml permissions 0600
      const configStat = await fs.stat(prepared.configPath);
      expect(configStat.mode & 0o777).toBe(0o600);

      // Verify .env permissions 0600
      const envStat = await fs.stat(prepared.envPath);
      expect(envStat.mode & 0o777).toBe(0o600);

      // Verify config.yaml inherits model posture but strips memory
      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("model:\n  default: 'openai-codex/gpt-5'");
      expect(configYaml).not.toContain("memory:");
      expect(configYaml).toContain("resources: false");
      expect(configYaml).toContain("prompts: false");

      // Verify temp .env contains ONLY run MCP tokens, NEVER provider secrets
      const envContent = await fs.readFile(prepared.envPath, "utf8");
      expect(envContent).toContain('HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED="pcgw_assigned_secret"');
      expect(envContent).not.toContain("OPENAI_API_KEY");
      expect(envContent).not.toContain("sk-host-key");

      // Verify prepared.providerEnv carries allowlisted provider secret for child env injection
      expect(prepared.providerEnv).toEqual({
        OPENAI_API_KEY: "sk-host-key",
      });
    });

    it("symlinks host skills if present and preserves host skills on cleanup", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-host-home-"));
      cleanupDirs.push(mockHome);

      const hostSkillsDir = path.join(mockHome, ".hermes", "skills");
      await fs.mkdir(hostSkillsDir, { recursive: true });
      await fs.writeFile(path.join(hostSkillsDir, "test-skill.md"), "# Test Skill");

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "mcp-server",
          url: "http://localhost:3100/mcp",
          token: "tok",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      const prepared = await prepareHermesMcpHome({
        servers,
        config: { env: { HOME: mockHome } },
      });
      cleanupDirs.push(prepared.homeDir);

      const symlinkPath = path.join(prepared.homeDir, "skills");
      const stat = await fs.lstat(symlinkPath);
      expect(stat.isSymbolicLink()).toBe(true);

      const readSkill = await fs.readFile(path.join(symlinkPath, "test-skill.md"), "utf8");
      expect(readSkill).toBe("# Test Skill");

      // Cleanup temp home
      await cleanupHermesMcpHome(prepared.homeDir);

      // Verify host skills was NOT deleted
      const hostSkillContent = await fs.readFile(path.join(hostSkillsDir, "test-skill.md"), "utf8");
      expect(hostSkillContent).toBe("# Test Skill");
    });

    it("resolves host skills properly even when config is omitted", async () => {
      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "mcp-server",
          url: "http://localhost:3100/mcp",
          token: "tok",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      // Calling without config must not crash
      const home = resolveHermesHome();
      expect(typeof home).toBe("string");
      const skillsDir = resolveHostHermesSkillsDir();
      expect(skillsDir).toContain(".hermes");
    });

    it("cleans up temporary directory on failure during preparation", async () => {
      const badServers: AdapterRuntimeMcpServer[] = [
        {
          name: "bad-server",
          url: "http://localhost:3100/mcp",
          token: "token\nwith\nnewline",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      await expect(prepareHermesMcpHome({ servers: badServers })).rejects.toThrow(
        /Unsafe token for MCP server/,
      );
    });

    it("fails loudly when host profiles directory cannot be created without falling back", async () => {
      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok-1",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      await expect(
        prepareHermesMcpHome({
          servers,
          config: { env: { HOME: "/dev/null/impossible-path" } },
        }),
      ).rejects.toThrow(/Cannot create Hermes profiles directory/);
    });

    it("cleans up created temp directory if a post-mkdtemp step throws", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-post-mkdtemp-fail-"));
      cleanupDirs.push(mockHome);

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      let createdDir: string | null = null;
      const originalWriteFile = fs.writeFile;
      const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (filePath, data, opts) => {
        if (typeof filePath === "string" && filePath.endsWith("config.yaml")) {
          createdDir = path.dirname(filePath);
          // Confirm directory exists right before throwing
          expect(await fs.access(createdDir).then(() => true).catch(() => false)).toBe(true);
          throw new Error("Simulated disk error during config.yaml write");
        }
        return originalWriteFile(filePath, data, opts);
      });

      try {
        await expect(
          prepareHermesMcpHome({
            servers,
            config: { env: { HOME: mockHome } },
          }),
        ).rejects.toThrow("Simulated disk error during config.yaml write");

        // Verify that the created homeDir was cleaned up in the catch block
        expect(createdDir).toBeTruthy();
        await expect(fs.access(createdDir!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("Stale Profile Cleanup & Error Callbacks", () => {
    it("cleans up only expired paperclip-run-* profiles and preserves user profiles", async () => {
      const mockProfilesDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-profiles-"));
      cleanupDirs.push(mockProfilesDir);

      const staleDir = path.join(mockProfilesDir, "paperclip-run-stale-123");
      const freshDir = path.join(mockProfilesDir, "paperclip-run-fresh-456");
      const userProfileDir = path.join(mockProfilesDir, "my-coder-profile");

      await fs.mkdir(staleDir, { recursive: true });
      await fs.mkdir(freshDir, { recursive: true });
      await fs.mkdir(userProfileDir, { recursive: true });

      // Set old mtime on staleDir (2 hours ago)
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      await fs.utimes(staleDir, twoHoursAgo, twoHoursAgo);

      await cleanupStaleHermesProfiles(mockProfilesDir, 3600_000);

      // staleDir should be deleted
      await expect(fs.access(staleDir)).rejects.toMatchObject({ code: "ENOENT" });

      // freshDir should remain
      await expect(fs.access(freshDir)).resolves.toBeUndefined();

      // userProfileDir should remain untouched
      await expect(fs.access(userProfileDir)).resolves.toBeUndefined();
    });

    it("invokes warning callback with redacted message on cleanup error", async () => {
      const warnings: string[] = [];
      // Cleanup a read-only or invalid dir simulation
      await cleanupHermesMcpHome("/dev/null/impossible-path", (msg) => {
        warnings.push(msg);
      });
      // Should not throw, but report non-sensitive warning
      expect(warnings.length).toBe(1);
      expect(warnings[0]).not.toContain("/dev/null/impossible-path");
      expect(warnings[0]).toContain("Temporary Hermes home cleanup encountered an error");
    });
  });
});

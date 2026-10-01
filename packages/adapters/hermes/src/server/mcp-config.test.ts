import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import dotenv from "dotenv";
import YAML from "yaml";

import type { AdapterRuntimeMcpServer, AdapterSkillContext } from "@paperclipai/adapter-utils";
import {
  prepareHermesMcpHome,
  cleanupHermesMcpHome,
  cleanupStaleHermesProfiles,
  copyIsolatedSkills,
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
import { validateHermesMemoryConfig } from "./memory-config.js";
import { resolveHermesHome, resolveHostHermesDir, resolveHostHermesSkillsDir, listHermesSkills } from "./skills.js";

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

    it("rejects unsafe glob metacharacters (*, ?, [, ], {, }) in tool names", () => {
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
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["tool{1,2}"] }),
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
    it("inherits only allowed provider/runtime posture keys from host config.yaml using real YAML parser", () => {
      const rawHostConfig = `
model:
  default: "anthropic/claude-sonnet-4"
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
      const parsed = YAML.parse(sanitized);

      expect(parsed.model).toEqual({
        default: "anthropic/claude-sonnet-4",
        provider: "anthropic",
      });
      expect(parsed.tool_loop_guardrails).toEqual({ max_iterations: 25 });
      expect(parsed.code_execution).toEqual({ timeout: 60 });

      // Strictly excludes dangerous/stateful/integration sections and nested unredacted credential sections
      expect(parsed.mcp_servers).toBeUndefined();
      expect(parsed.forbidden_host_server).toBeUndefined();
      expect(parsed.memory).toBeUndefined();
      expect(parsed.database).toBeUndefined();
      expect(parsed.telemetry).toBeUndefined();
      expect(parsed.browser).toBeUndefined();
      expect(parsed.slack).toBeUndefined();
      expect(parsed.terminal).toBeUndefined();
      expect(parsed.providers).toBeUndefined();
      expect(sanitized).not.toContain("nested-secret");

      expect(ALLOWED_HOST_CONFIG_KEYS.has("terminal")).toBe(false);
      expect(ALLOWED_HOST_CONFIG_KEYS.has("providers")).toBe(false);
    });

    it("fails closed on multi-document YAML or non-mapping input", () => {
      // Multi-document YAML must return empty string
      const multiDoc = "model:\n  default: 'm1'\n---\nmodel:\n  default: 'm2'\n";
      expect(sanitizeHostConfigYaml(multiDoc)).toBe("");

      // Sequence/array root must return empty string
      const arrayYaml = "- item1\n- item2\n";
      expect(sanitizeHostConfigYaml(arrayYaml)).toBe("");

      // Primitive string or number root must return empty string
      expect(sanitizeHostConfigYaml("just a plain string")).toBe("");
      expect(sanitizeHostConfigYaml("42")).toBe("");
      expect(sanitizeHostConfigYaml("")).toBe("");

      // Syntax error must fail closed
      expect(sanitizeHostConfigYaml("model: [unclosed")).toBe("");
    });

    it("does not warn on empty or comment-only host config YAML", () => {
      const warnings: string[] = [];
      const onWarn = (msg: string) => warnings.push(msg);

      expect(sanitizeHostConfigYaml("", onWarn)).toBe("");
      expect(sanitizeHostConfigYaml("   \n\n  ", onWarn)).toBe("");
      expect(sanitizeHostConfigYaml("# just comments\n# second line", onWarn)).toBe("");
      expect(sanitizeHostConfigYaml("---\n# document separator with comment", onWarn)).toBe("");
      expect(warnings).toHaveLength(0);
    });

    it("emits warning on malformed or multi-document host config YAML", () => {
      const warnings: string[] = [];
      const onWarn = (msg: string) => warnings.push(msg);

      expect(sanitizeHostConfigYaml("model: [unclosed", onWarn)).toBe("");
      expect(warnings).toContain("Failed to parse host configuration: malformed YAML document");

      warnings.length = 0;
      expect(sanitizeHostConfigYaml("model:\n  default: 'a'\n---\nmodel:\n  default: 'b'", onWarn)).toBe("");
      expect(warnings).toContain("Failed to inherit host configuration: multi-document YAML is not supported");

      warnings.length = 0;
      expect(sanitizeHostConfigYaml("- item1\n- item2", onWarn)).toBe("");
      expect(warnings).toContain("Failed to inherit host configuration: expected a mapping at the root");
    });

    it("emits warning on dotenv parse failure", () => {
      const warnings: string[] = [];
      const parseSpy = vi.spyOn(dotenv, "parse").mockImplementationOnce(() => {
        throw new Error("Simulated dotenv syntax error");
      });
      try {
        const filtered = filterProviderEnv("BAD_DOTENV", (msg) => warnings.push(msg));
        expect(filtered).toEqual({});
        expect(warnings).toContain("Failed to parse host environment file");
      } finally {
        parseSpy.mockRestore();
      }
    });

    it("correctly ignores quoted forbidden keys and whitespace variations", () => {
      const quotedYaml = `
"mcp_servers":
  bad_server:
    url: "http://bad.local"
'memory'  :
  enabled: true
"model"  :
  default: "anthropic/claude-sonnet-4"
`;
      const sanitized = sanitizeHostConfigYaml(quotedYaml);
      const parsed = YAML.parse(sanitized);

      expect(parsed.mcp_servers).toBeUndefined();
      expect(parsed.memory).toBeUndefined();
      expect(parsed.model).toEqual({ default: "anthropic/claude-sonnet-4" });
    });

    it("filters host .env secrets using dotenv.parse with closed allowlist and aliases, excluding generic AWS keys", () => {
      const rawDotenv = `
# Core AI credentials and aliases
ANTHROPIC_API_KEY="sk-ant-123"
ANTHROPIC_TOKEN="ant-token"
CLAUDE_CODE_OAUTH_TOKEN="claude-token"
  OPENAI_BASE_URL  =  https://custom.openai.api/v1  # inline comment
OPENROUTER_API_KEY='sk-or-456'
GOOGLE_API_KEY=AIzaSyTest

# Provider-scoped Bedrock variables (allowed)
BEDROCK_AWS_ACCESS_KEY_ID="AKIA-BEDROCK"
BEDROCK_AWS_SECRET_ACCESS_KEY="secret-bedrock"
BEDROCK_AWS_SESSION_TOKEN="session-bedrock"
BEDROCK_AWS_REGION="us-east-1"

# Generic AWS keys (must be omitted from host inheritance)
AWS_ACCESS_KEY_ID="AKIA-GENERIC"
AWS_SECRET_ACCESS_KEY="generic-secret"
AWS_SESSION_TOKEN="aws-session-token"
AWS_REGION="us-west-2"
AWS_DEFAULT_REGION="us-west-2"

# Other unsafe/host secrets (must be omitted)
DATABASE_URL=postgres://user:pass@localhost:5432/db
PAPERCLIP_RUNTIME_TOOLS_TOKEN=rt-secret-123
SLACK_BOT_TOKEN=xoxb-1234
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_secret
`;

      const filtered = filterProviderEnv(rawDotenv);

      expect(filtered.ANTHROPIC_API_KEY).toBe("sk-ant-123");
      expect(filtered.ANTHROPIC_TOKEN).toBe("ant-token");
      expect(filtered.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-token");
      expect(filtered.OPENAI_BASE_URL).toBe("https://custom.openai.api/v1");
      expect(filtered.OPENROUTER_API_KEY).toBe("sk-or-456");
      expect(filtered.GOOGLE_API_KEY).toBe("AIzaSyTest");

      // Bedrock variables allowed
      expect(filtered.BEDROCK_AWS_ACCESS_KEY_ID).toBe("AKIA-BEDROCK");
      expect(filtered.BEDROCK_AWS_SECRET_ACCESS_KEY).toBe("secret-bedrock");
      expect(filtered.BEDROCK_AWS_SESSION_TOKEN).toBe("session-bedrock");
      expect(filtered.BEDROCK_AWS_REGION).toBe("us-east-1");

      // Generic AWS variables strictly excluded
      expect(filtered.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(filtered.AWS_SESSION_TOKEN).toBeUndefined();
      expect(filtered.AWS_REGION).toBeUndefined();
      expect(filtered.AWS_DEFAULT_REGION).toBeUndefined();

      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("BEDROCK_AWS_SESSION_TOKEN")).toBe(true);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_ACCESS_KEY_ID")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_SECRET_ACCESS_KEY")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_SESSION_TOKEN")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_REGION")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_DEFAULT_REGION")).toBe(false);

      // Denies non-allowlisted credentials
      expect(filtered.DATABASE_URL).toBeUndefined();
      expect(filtered.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBeUndefined();
      expect(filtered.SLACK_BOT_TOKEN).toBeUndefined();
      expect(filtered.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    });

    it("parses dotenv edge cases: escaped backslashes, quotes, and whitespace around '='", () => {
      const dotenvContent = [
        '  OPENAI_API_KEY   =   "sk-test-val"  ',
        "  ANTHROPIC_BASE_URL = 'https://anthropic.test/api'",
        '  OPENROUTER_BASE_URL = "https:\\\\custom.router\\\\v1" # trailing comment',
      ].join("\n");
      const filtered = filterProviderEnv(dotenvContent);
      expect(filtered.OPENAI_API_KEY).toBe("sk-test-val");
      expect(filtered.ANTHROPIC_BASE_URL).toBe("https://anthropic.test/api");
      expect(filtered.OPENROUTER_BASE_URL).toBe("https:\\\\custom.router\\\\v1");
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

    it("ensures PyYAML parses the generated config.yaml faithfully", (ctx) => {
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

      let pyyamlAvailable = false;
      try {
        execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" });
        pyyamlAvailable = true;
      } catch {
        // Skip PyYAML check if python3 or pyyaml is not available in environment
      }

      if (!pyyamlAvailable) {
        ctx.skip();
        return;
      }

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
      expect(configYaml).toContain("default: openai-codex/gpt-5");
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

    it("snapshots host skills into isolated directory, preventing write-through to host", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-host-home-"));
      cleanupDirs.push(mockHome);

      const hostSkillsDir = path.join(mockHome, ".hermes", "skills");
      await fs.mkdir(hostSkillsDir, { recursive: true });
      const hostSkillFile = path.join(hostSkillsDir, "test-skill.md");
      await fs.writeFile(hostSkillFile, "# Initial Host Skill Content");

      // An unsafe external symlink pointing outside of host skills directory
      const outsideFile = path.join(mockHome, "outside.txt");
      await fs.writeFile(outsideFile, "secret host data");
      await fs.symlink(outsideFile, path.join(hostSkillsDir, "unsafe-symlink.txt"));

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

      const isolatedSkillsPath = path.join(prepared.homeDir, "skills");
      const stat = await fs.lstat(isolatedSkillsPath);
      // Isolated copy is a directory, NOT a symlink
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);

      const isolatedSkillFile = path.join(isolatedSkillsPath, "test-skill.md");
      const readSkill = await fs.readFile(isolatedSkillFile, "utf8");
      expect(readSkill).toBe("# Initial Host Skill Content");

      // Verify unsafe external symlink was skipped and never copied
      const unsafeInIsolated = await fs.lstat(path.join(isolatedSkillsPath, "unsafe-symlink.txt")).catch(() => null);
      expect(unsafeInIsolated).toBeNull();

      // Write-through regression: mutating isolated skills MUST NOT affect host skill
      await fs.writeFile(isolatedSkillFile, "# Mutated By Isolated Run");
      await fs.writeFile(path.join(isolatedSkillsPath, "new-isolated-skill.md"), "# New Isolated Skill");

      const hostSkillAfterMutate = await fs.readFile(hostSkillFile, "utf8");
      expect(hostSkillAfterMutate).toBe("# Initial Host Skill Content");
      const newFileInHost = await fs.stat(path.join(hostSkillsDir, "new-isolated-skill.md")).catch(() => null);
      expect(newFileInHost).toBeNull();

      // Cleanup temp home preserves host skills
      await cleanupHermesMcpHome(prepared.homeDir);

      const hostSkillContentAfterCleanup = await fs.readFile(hostSkillFile, "utf8");
      expect(hostSkillContentAfterCleanup).toBe("# Initial Host Skill Content");
    });

    it("resolves host skills properly even when config is omitted", async () => {
      // Calling without config must not crash
      const home = resolveHermesHome();
      expect(typeof home).toBe("string");
      const skillsDir = resolveHostHermesSkillsDir();
      expect(skillsDir).toContain(".hermes");
    });

    it("respects explicit HERMES_HOME in buildHermesSkillSnapshot / listHermesSkills", async () => {
      const mockHermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-custom-hermes-"));
      cleanupDirs.push(mockHermesHome);

      const skillDir = path.join(mockHermesHome, "skills", "custom-category", "custom-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: Custom Skill\ndescription: Test description\n---\n# Custom Skill\n",
      );

      const ctx: AdapterSkillContext = {
        agentId: "agent-1",
        companyId: "company-1",
        adapterType: "hermes_local",
        config: { env: { HERMES_HOME: mockHermesHome } },
      };
      const snapshot = await listHermesSkills(ctx);

      expect(snapshot.entries.some((e) => e.key === "custom-skill")).toBe(true);
    });

    it("emits warning on non-ENOENT read failure for host config.yaml or .env", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-read-warn-"));
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

      const warnings: string[] = [];
      const originalReadFile = fs.readFile;
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, opts) => {
        if (typeof filePath === "string" && filePath.endsWith("config.yaml")) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        if (typeof filePath === "string" && filePath.endsWith(".env")) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return originalReadFile(filePath, opts);
      });

      try {
        const prepared = await prepareHermesMcpHome({
          servers,
          config: { env: { HOME: mockHome } },
          onWarning: (w) => warnings.push(w),
        });
        cleanupDirs.push(prepared.homeDir);

        expect(warnings).toContain("Failed to read host configuration file");
        expect(warnings).toContain("Failed to read host environment file");
      } finally {
        readSpy.mockRestore();
      }
    });

    it("hard-fails and cleans up temp home when chmod on config.yaml fails", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chmod-cfg-fail-"));
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
      const originalChmod = fs.chmod;
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (targetPath, mode) => {
        if (typeof targetPath === "string" && targetPath.endsWith("config.yaml")) {
          createdDir = path.dirname(targetPath);
          throw new Error("Simulated chmod failure on config.yaml");
        }
        return originalChmod(targetPath, mode);
      });

      try {
        await expect(
          prepareHermesMcpHome({
            servers,
            config: { env: { HOME: mockHome } },
          }),
        ).rejects.toThrow("Simulated chmod failure on config.yaml");

        expect(createdDir).toBeTruthy();
        await expect(fs.access(createdDir!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        chmodSpy.mockRestore();
      }
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

    it("reports warning when chmod on profiles directory fails", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chmod-fail-"));
      cleanupDirs.push(mockHome);

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok-1",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      const warnings: string[] = [];
      const originalChmod = fs.chmod;
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (targetPath, mode) => {
        if (typeof targetPath === "string" && targetPath.endsWith("profiles")) {
          throw new Error("Simulated EPERM chmod failure");
        }
        return originalChmod(targetPath, mode);
      });

      try {
        const prepared = await prepareHermesMcpHome({
          servers,
          config: { env: { HOME: mockHome } },
          onWarning: (w) => warnings.push(w),
        });
        cleanupDirs.push(prepared.homeDir);

        expect(warnings).toContain("Failed to tighten permissions on Hermes profiles directory");
      } finally {
        chmodSpy.mockRestore();
      }
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

  describe("resolveHostHermesDir and resolveHostHermesSkillsDir precedence", () => {
    const originalHermesHome = process.env.HERMES_HOME;
    const originalHome = process.env.HOME;

    afterEach(() => {
      if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = originalHermesHome;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    it("prefers config.env.HERMES_HOME over everything else", () => {
      process.env.HERMES_HOME = "/env/hermes";
      process.env.HOME = "/env/home";
      const config = {
        env: {
          HERMES_HOME: "/config/hermes",
          HOME: "/config/home",
        },
      };

      expect(resolveHostHermesDir(config)).toBe(path.resolve("/config/hermes"));
      expect(resolveHostHermesSkillsDir(config)).toBe(path.resolve("/config/hermes/skills"));
    });

    it("prefers process.env.HERMES_HOME over HOME when config.env.HERMES_HOME is absent", () => {
      process.env.HERMES_HOME = "/process/hermes";
      process.env.HOME = "/process/home";
      const config = {
        env: {
          HOME: "/config/home",
        },
      };

      expect(resolveHostHermesDir(config)).toBe(path.resolve("/process/hermes"));
      expect(resolveHostHermesSkillsDir(config)).toBe(path.resolve("/process/hermes/skills"));
    });

    it("falls back to config.env.HOME/.hermes when HERMES_HOME is unset", () => {
      delete process.env.HERMES_HOME;
      process.env.HOME = "/process/home";
      const config = {
        env: {
          HOME: "/config/home",
        },
      };

      expect(resolveHostHermesDir(config)).toBe(path.resolve("/config/home/.hermes"));
      expect(resolveHostHermesSkillsDir(config)).toBe(path.resolve("/config/home/.hermes/skills"));
    });

    it("falls back safely to os.homedir()/.hermes when config is omitted", () => {
      delete process.env.HERMES_HOME;
      const expectedDir = path.join(os.homedir(), ".hermes");

      expect(resolveHostHermesDir()).toBe(expectedDir);
      expect(resolveHostHermesSkillsDir()).toBe(path.join(expectedDir, "skills"));
    });
  });

  describe("Stale Profile Cleanup & Error Callbacks", () => {
    it("cleans up only expired paperclip-run-* profiles older than 24h and preserves user profiles", async () => {
      const mockProfilesDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-profiles-"));
      cleanupDirs.push(mockProfilesDir);

      const staleDir = path.join(mockProfilesDir, "paperclip-run-stale-123");
      const freshDir = path.join(mockProfilesDir, "paperclip-run-fresh-456");
      const userProfileDir = path.join(mockProfilesDir, "my-coder-profile");

      await fs.mkdir(staleDir, { recursive: true });
      await fs.mkdir(freshDir, { recursive: true });
      await fs.mkdir(userProfileDir, { recursive: true });

      // Set old mtime on staleDir (25 hours ago)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600_000);
      await fs.utimes(staleDir, twentyFiveHoursAgo, twentyFiveHoursAgo);

      // Fresh dir mtime is recent (2 hours ago)
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      await fs.utimes(freshDir, twoHoursAgo, twoHoursAgo);

      await cleanupStaleHermesProfiles(mockProfilesDir, 24 * 3600_000);

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

  describe("copyIsolatedSkills", () => {
    it("copies skills across multiple sibling directories without false suppression", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-src-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-dest-"));
      cleanupDirs.push(srcDir, destDir);

      await fs.mkdir(path.join(srcDir, "catA", "skill1"), { recursive: true });
      await fs.writeFile(path.join(srcDir, "catA", "skill1", "SKILL.md"), "# Skill 1\n");

      await fs.mkdir(path.join(srcDir, "catB", "skill2"), { recursive: true });
      await fs.writeFile(path.join(srcDir, "catB", "skill2", "SKILL.md"), "# Skill 2\n");

      await copyIsolatedSkills(srcDir, destDir);

      const dest1 = path.join(destDir, "catA", "skill1", "SKILL.md");
      const dest2 = path.join(destDir, "catB", "skill2", "SKILL.md");

      expect(await fs.readFile(dest1, "utf8")).toBe("# Skill 1\n");
      expect(await fs.readFile(dest2, "utf8")).toBe("# Skill 2\n");
    });

    it("detects and terminates symlink cycles without infinite recursion", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-cycle-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-cycledest-"));
      cleanupDirs.push(srcDir, destDir);

      const parentDir = path.join(srcDir, "cycle_parent");
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(path.join(parentDir, "SKILL.md"), "# Cycle test\n");

      // Symlink pointing back to parentDir creates an internal cycle
      await fs.symlink(parentDir, path.join(parentDir, "loop"));

      const warnings: string[] = [];
      await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));

      expect(await fs.readFile(path.join(destDir, "cycle_parent", "SKILL.md"), "utf8")).toBe("# Cycle test\n");
      expect(warnings.some((w) => w.includes("cycle"))).toBe(true);
    });

    it("emits a single incomplete-snapshot warning when copying an alias of a snapshot with skipped source entries", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-incomp-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-incompdest-"));
      cleanupDirs.push(srcDir, destDir);

      // Create canonical skill with one good file and one faulty file that fails to read
      const realDir = path.join(srcDir, "real_skill");
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, "good.txt"), "Good file\n");
      await fs.writeFile(path.join(realDir, "faulty.txt"), "Faulty file\n");

      // Create an alias pointing to real_skill (processed after real_skill in alphabetical order)
      await fs.symlink(realDir, path.join(srcDir, "z_alias_skill"));

      const originalReadFile = fs.readFile;
      (fs as any).readFile = async (filePath: any, opts: any) => {
        if (typeof filePath === "string" && filePath.includes("faulty.txt")) {
          const err = new Error("EIO: disk read error");
          (err as any).code = "EIO";
          throw err;
        }
        return originalReadFile(filePath, opts as any);
      };

      const warnings: string[] = [];
      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));
      } finally {
        (fs as any).readFile = originalReadFile;
      }

      // Initial read of faulty file emits warning
      expect(warnings.some((w) => w.includes("Failed to read source file") && w.includes("faulty.txt"))).toBe(true);

      // Reusing incomplete snapshot for alias emits exactly one warning
      const incompleteWarnings = warnings.filter((w) => w.includes("incomplete"));
      expect(incompleteWarnings.length).toBe(1);
      expect(incompleteWarnings[0]).toContain("z_alias_skill");

      // Verify good file was copied to both real and alias destination
      expect(await fs.readFile(path.join(destDir, "real_skill", "good.txt"), "utf8")).toBe("Good file\n");
      expect(await fs.readFile(path.join(destDir, "z_alias_skill", "good.txt"), "utf8")).toBe("Good file\n");
    });

    it("safely skips broken symlinks without error", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-broken-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-brokendest-"));
      cleanupDirs.push(srcDir, destDir);

      const validDir = path.join(srcDir, "valid");
      await fs.mkdir(validDir, { recursive: true });
      await fs.writeFile(path.join(validDir, "SKILL.md"), "# Valid skill\n");

      // Broken symlink to nonexistent file
      await fs.symlink(path.join(srcDir, "nonexistent"), path.join(validDir, "broken_link"));

      await copyIsolatedSkills(srcDir, destDir);

      expect(await fs.readFile(path.join(destDir, "valid", "SKILL.md"), "utf8")).toBe("# Valid skill\n");
    });

    it("handles diamond DAG without exponential traversal, reading shared canonical directory only once", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-diamond-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-diamonddest-"));
      cleanupDirs.push(srcDir, destDir);

      // Create a shared directory inside srcDir
      const sharedDir = path.join(srcDir, "shared_skill");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SKILL.md"), "# Shared Skill\n");

      // Create two categories that both symlink to the same shared directory (diamond DAG)
      const catA = path.join(srcDir, "category_a");
      const catB = path.join(srcDir, "category_b");
      await fs.mkdir(catA, { recursive: true });
      await fs.mkdir(catB, { recursive: true });
      await fs.symlink(sharedDir, path.join(catA, "shared_link"));
      await fs.symlink(sharedDir, path.join(catB, "shared_link"));

      let sharedReaddirCount = 0;
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (dirPath, opts) => {
        if (typeof dirPath === "string" && dirPath.includes("shared_skill")) {
          sharedReaddirCount++;
        }
        return originalReaddir(dirPath, opts);
      });

      const warnings: string[] = [];
      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));
        // Shared directory should only be read once from source
        expect(sharedReaddirCount).toBe(1);

        // Both destination paths must receive complete cached isolated contents
        const destA = path.join(destDir, "category_a", "shared_link", "SKILL.md");
        const destB = path.join(destDir, "category_b", "shared_link", "SKILL.md");
        expect(await fs.readFile(destA, "utf8")).toBe("# Shared Skill\n");
        expect(await fs.readFile(destB, "utf8")).toBe("# Shared Skill\n");

        // Verify restrictive perms and no symlinks in destination
        const statA = await fs.lstat(path.join(destDir, "category_a", "shared_link"));
        expect(statA.isSymbolicLink()).toBe(false);
        expect(statA.isDirectory()).toBe(true);
        expect(statA.mode & 0o777).toBe(0o700);

        const statB = await fs.lstat(path.join(destDir, "category_b", "shared_link"));
        expect(statB.isSymbolicLink()).toBe(false);
        expect(statB.isDirectory()).toBe(true);
        expect(statB.mode & 0o777).toBe(0o700);

        const fileStat = await fs.stat(destB);
        expect(fileStat.mode & 0o777).toBe(0o600);
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("handles alias-first traversal order leaving both destinations complete with restrictive perms and no symlinks", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-aliasfirst-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-aliasdest-"));
      cleanupDirs.push(srcDir, destDir);

      // Create target directory named 'z_real_skill' so 'a_alias_link' is traversed first
      const realDir = path.join(srcDir, "z_real_skill");
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, "SKILL.md"), "# Alias First Skill\n");

      // Symlink 'a_alias_link' points to 'z_real_skill'
      await fs.symlink(realDir, path.join(srcDir, "a_alias_link"));

      const srcReal = await fs.realpath(srcDir);
      let realDirReaddirCount = 0;
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (dirPath, opts) => {
        if (typeof dirPath === "string" && (dirPath.startsWith(srcDir) || dirPath.startsWith(srcReal)) && dirPath.includes("z_real_skill")) {
          realDirReaddirCount++;
        }
        return originalReaddir(dirPath, opts);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir);
        // Source should only be traversed once
        expect(realDirReaddirCount).toBe(1);

        // Both destinations must be complete
        const aliasSkill = path.join(destDir, "a_alias_link", "SKILL.md");
        const realSkill = path.join(destDir, "z_real_skill", "SKILL.md");
        expect(await fs.readFile(aliasSkill, "utf8")).toBe("# Alias First Skill\n");
        expect(await fs.readFile(realSkill, "utf8")).toBe("# Alias First Skill\n");

        // Verify restrictive permissions and no symlinks
        const aliasStat = await fs.lstat(path.join(destDir, "a_alias_link"));
        expect(aliasStat.isSymbolicLink()).toBe(false);
        expect(aliasStat.isDirectory()).toBe(true);
        expect(aliasStat.mode & 0o777).toBe(0o700);

        const realStat = await fs.lstat(path.join(destDir, "z_real_skill"));
        expect(realStat.isSymbolicLink()).toBe(false);
        expect(realStat.isDirectory()).toBe(true);
        expect(realStat.mode & 0o777).toBe(0o700);
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("handles real-first traversal order leaving both destinations complete with restrictive perms and no symlinks", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-realfirst-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-realdest-"));
      cleanupDirs.push(srcDir, destDir);

      // Create target directory named 'a_real_skill' so it is traversed before 'z_alias_link'
      const realDir = path.join(srcDir, "a_real_skill");
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, "SKILL.md"), "# Real First Skill\n");

      // Symlink 'z_alias_link' points to 'a_real_skill'
      await fs.symlink(realDir, path.join(srcDir, "z_alias_link"));

      const srcReal = await fs.realpath(srcDir);
      let realDirReaddirCount = 0;
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (dirPath, opts) => {
        if (typeof dirPath === "string" && (dirPath.startsWith(srcDir) || dirPath.startsWith(srcReal)) && dirPath.includes("a_real_skill")) {
          realDirReaddirCount++;
        }
        return originalReaddir(dirPath, opts);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir);
        // Source should only be traversed once
        expect(realDirReaddirCount).toBe(1);

        // Both destinations must be complete
        const realSkill = path.join(destDir, "a_real_skill", "SKILL.md");
        const aliasSkill = path.join(destDir, "z_alias_link", "SKILL.md");
        expect(await fs.readFile(realSkill, "utf8")).toBe("# Real First Skill\n");
        expect(await fs.readFile(aliasSkill, "utf8")).toBe("# Real First Skill\n");

        // Verify restrictive permissions and no symlinks
        const realStat = await fs.lstat(path.join(destDir, "a_real_skill"));
        expect(realStat.isSymbolicLink()).toBe(false);
        expect(realStat.isDirectory()).toBe(true);
        expect(realStat.mode & 0o777).toBe(0o700);

        const aliasStat = await fs.lstat(path.join(destDir, "z_alias_link"));
        expect(aliasStat.isSymbolicLink()).toBe(false);
        expect(aliasStat.isDirectory()).toBe(true);
        expect(aliasStat.mode & 0o777).toBe(0o700);
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("skips entry and emits warning when source readFile encounters EIO error without aborting run", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-eio-src-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-eio-dest-"));
      cleanupDirs.push(srcDir, destDir);

      const faultyFile = path.join(srcDir, "faulty.txt");
      const okFile = path.join(srcDir, "ok.txt");
      await fs.writeFile(faultyFile, "Faulty source data");
      await fs.writeFile(okFile, "Good source data");

      const warnings: string[] = [];
      const originalReadFile = fs.readFile;
      const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, opts) => {
        if (typeof filePath === "string" && filePath.includes("faulty.txt")) {
          const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return originalReadFile(filePath, opts as any);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));

        // Must emit warning for the failed file read
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.some((w) => w.includes("Failed to read source file") && w.includes("faulty.txt"))).toBe(true);

        // Good file must still be copied
        expect(await fs.readFile(path.join(destDir, "ok.txt"), "utf8")).toBe("Good source data");
      } finally {
        readFileSpy.mockRestore();
      }
    });

    it("aborts fail-closed when destination writeFile encounters EIO error", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-desteio-src-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-desteio-dest-"));
      cleanupDirs.push(srcDir, destDir);

      await fs.writeFile(path.join(srcDir, "SKILL.md"), "# Content\n");

      const originalWriteFile = fs.writeFile;
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (filePath, data, opts) => {
        if (typeof filePath === "string" && filePath.startsWith(destDir)) {
          const err = new Error("EIO: disk write error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return originalWriteFile(filePath, data, opts as any);
      });

      try {
        await expect(copyIsolatedSkills(srcDir, destDir)).rejects.toThrow("EIO: disk write error");
      } finally {
        writeFileSpy.mockRestore();
      }
    });

    it("emits redacted warning and skips entry on non-ENOENT source read failure without aborting run", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-perm-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-permdest-"));
      cleanupDirs.push(srcDir, destDir);

      const restrictedDir = path.join(srcDir, "restricted");
      await fs.mkdir(restrictedDir, { recursive: true });
      const validDir = path.join(srcDir, "valid");
      await fs.mkdir(validDir, { recursive: true });
      await fs.writeFile(path.join(validDir, "SKILL.md"), "# Valid skill\n");

      const warnings: string[] = [];
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (dirPath, opts) => {
        if (typeof dirPath === "string" && dirPath.includes("restricted")) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return originalReaddir(dirPath, opts);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));

        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain("Failed to read directory");
        expect(await fs.readFile(path.join(destDir, "valid", "SKILL.md"), "utf8")).toBe("# Valid skill\n");
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("continues without skills when top-level host skills directory is unreadable", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-toplevel-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-topleveldest-"));
      cleanupDirs.push(srcDir, destDir);

      const warnings: string[] = [];
      const originalStat = fs.stat;
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (filePath, opts) => {
        if (typeof filePath === "string" && filePath === srcDir) {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return originalStat(filePath, opts as any);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("Failed to stat skills directory");
      } finally {
        statSpy.mockRestore();
      }
    });

    it("fails closed when destination write or chmod fails", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-destfail-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-destfaildest-"));
      cleanupDirs.push(srcDir, destDir);

      await fs.writeFile(path.join(srcDir, "SKILL.md"), "# Skill\n");

      // Make destination read-only so writes fail
      await fs.chmod(destDir, 0o500);

      try {
        await expect(copyIsolatedSkills(srcDir, path.join(destDir, "sub"))).rejects.toThrow();
      } finally {
        await fs.chmod(destDir, 0o700);
      }
    });
  });

  describe("Runtime Memory in Isolated Home", () => {
    const validMemConfig = validateHermesMemoryConfig({
      provider: "mem0",
      mode: "oss",
      userId: "company",
      agentId: "agent-test-mem-1",
      llm: {
        provider: "openai",
        config: { model: "gpt-5.4-mini" },
      },
      embedder: {
        provider: "openai",
        config: { model: "text-embedding-3-small" },
      },
      vectorStore: {
        provider: "pgvector",
        config: {
          host: "postgres-tenant-node.internal",
          port: 5432,
          user: "tenant_user",
          password: "SuperSecretPassword123!",
          dbname: "tenant_isolated_db",
          sslmode: "require",
          collectionName: "mem0_collection",
        },
      },
    });

    it("prepares isolated home with memory when servers list is empty", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mem-"));
      cleanupDirs.push(mockHost);

      const prepared = await prepareHermesMcpHome({
        servers: [],
        memory: validMemConfig,
        config: { env: { HERMES_HOME: mockHost } },
      });
      cleanupDirs.push(prepared.homeDir);

      // Verify all created directories and files are beneath the temp test root
      expect(prepared.homeDir.startsWith(mockHost)).toBe(true);
      expect(prepared.configPath.startsWith(mockHost)).toBe(true);
      expect(prepared.envPath.startsWith(mockHost)).toBe(true);
      expect(prepared.mem0JsonPath?.startsWith(mockHost)).toBe(true);

      expect(prepared.serverCount).toBe(0);
      expect(prepared.hasMemory).toBe(true);
      expect(prepared.mem0JsonPath).toBe(path.join(prepared.homeDir, "mem0.json"));

      // Verify that secrets are NOT exposed in prepared home result
      expect((prepared as any).password).toBeUndefined();
      expect(JSON.stringify(prepared)).not.toContain("SuperSecretPassword123!");

      // Verify mem0.json contents and 0600 mode
      const mem0Content = await fs.readFile(prepared.mem0JsonPath!, "utf8");
      const parsedMem0 = JSON.parse(mem0Content);
      expect(parsedMem0.mode).toBe("oss");
      expect(parsedMem0.user_id).toBe("company");
      expect(parsedMem0.agent_id).toBe("agent-test-mem-1");
      expect(parsedMem0.oss.vector_store.config.password).toBe("SuperSecretPassword123!");
      expect(parsedMem0.oss.vector_store.config.host).toBe("postgres-tenant-node.internal");

      const mem0Stat = await fs.stat(prepared.mem0JsonPath!);
      expect(mem0Stat.mode & 0o777).toBe(0o600);

      // Verify config.yaml includes memory.provider: mem0 and NO mcp_servers
      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("memory:\n  provider: mem0");
      expect(configYaml).not.toContain("mcp_servers:");

      // Verify .env mode 0600
      const envStat = await fs.stat(prepared.envPath);
      expect(envStat.mode & 0o777).toBe(0o600);
    });

    it("prepares isolated home with BOTH servers and memory", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mem-"));
      cleanupDirs.push(mockHost);

      const server: AdapterRuntimeMcpServer = {
        name: "test-gw",
        url: "https://gateway.example.com",
        token: "gw-token-xyz",
        connectionId: "conn-1",
        allowedTools: ["fetch_records"],
      };

      const prepared = await prepareHermesMcpHome({
        servers: [server],
        memory: validMemConfig,
        config: { env: { HERMES_HOME: mockHost } },
      });
      cleanupDirs.push(prepared.homeDir);

      expect(prepared.homeDir.startsWith(mockHost)).toBe(true);
      expect(prepared.serverCount).toBe(1);
      expect(prepared.hasMemory).toBe(true);

      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("memory:\n  provider: mem0");
      expect(configYaml).toContain("mcp_servers:");
      expect(configYaml).toContain("test_gw:");

      const envContent = await fs.readFile(prepared.envPath, "utf8");
      expect(envContent).toContain("HERMES_MCP_TOKEN_TEST_GW=");
    });

    it("rejects preparing isolated home when neither servers nor memory is provided", async () => {
      await expect(
        prepareHermesMcpHome({
          servers: [],
        }),
      ).rejects.toThrow("Cannot prepare Hermes isolated home: no servers or memory provided");

      await expect(
        prepareHermesMcpHome({}),
      ).rejects.toThrow("Cannot prepare Hermes isolated home: no servers or memory provided");
    });

    it("cleans up directory and fails if writing or chmodding mem0.json fails", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mem-"));
      cleanupDirs.push(mockHost);

      // 1. Test chmod failure on mem0.json
      const realChmod = fs.chmod;
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (filePath, mode) => {
        if (typeof filePath === "string" && filePath.endsWith("mem0.json")) {
          throw new Error("Simulated chmod EPERM on mem0.json");
        }
        return realChmod(filePath, mode);
      });

      try {
        await expect(
          prepareHermesMcpHome({
            servers: [],
            memory: validMemConfig,
            config: { env: { HERMES_HOME: mockHost } },
          }),
        ).rejects.toThrow("Simulated chmod EPERM on mem0.json");
      } finally {
        chmodSpy.mockRestore();
      }

      // Check profiles dir: no orphaned directories should exist
      const profilesDir = path.join(mockHost, "profiles");
      let entries = await fs.readdir(profilesDir).catch(() => []);
      expect(entries).toEqual([]);

      // 2. Test writeFile failure on mem0.json
      const realWriteFile = fs.writeFile;
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (filePath, data, options) => {
        if (typeof filePath === "string" && filePath.endsWith("mem0.json")) {
          throw new Error("Simulated writeFile ENOSPC on mem0.json");
        }
        return realWriteFile(filePath, data, options as any);
      });

      try {
        await expect(
          prepareHermesMcpHome({
            servers: [],
            memory: validMemConfig,
            config: { env: { HERMES_HOME: mockHost } },
          }),
        ).rejects.toThrow("Simulated writeFile ENOSPC on mem0.json");
      } finally {
        writeFileSpy.mockRestore();
      }

      entries = await fs.readdir(profilesDir).catch(() => []);
      expect(entries).toEqual([]);
    });

    it("serializeHermesMcpYaml handles combinations of hostYaml, memory, and mcpServers", () => {
      // Memory only
      const memOnly = serializeHermesMcpYaml({}, "", true);
      expect(memOnly).toBe("memory:\n  provider: mem0\n");

      // Inherited host + memory only
      const hostAndMem = serializeHermesMcpYaml({}, "model: gpt-5.4", true);
      expect(hostAndMem).toBe("model: gpt-5.4\n\nmemory:\n  provider: mem0\n");

      // Memory + MCP server
      const memAndMcp = serializeHermesMcpYaml(
        {
          my_server: {
            url: "https://mcp.test",
            headers: { Authorization: "Bearer ${TOKEN}" },
            enabled: true,
            skip_preflight: true,
            tools: { resources: false, prompts: false, include: ["t1"] },
          },
        },
        "",
        true,
      );
      expect(memAndMcp).toContain("memory:\n  provider: mem0");
      expect(memAndMcp).toContain("mcp_servers:");
      expect(memAndMcp).toContain("my_server:");
    });
  });
});

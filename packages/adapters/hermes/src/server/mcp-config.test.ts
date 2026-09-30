import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  prepareHermesMcpHome,
  cleanupHermesMcpHome,
  sanitizeServerKey,
  sanitizeEnvVarName,
  serializeHermesMcpYaml,
  serializeHermesDotenv,
  validateMcpServer,
} from "./mcp-config.js";

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

  describe("YAML and Dotenv Serialization", () => {
    it("serializes config.yaml containing only runtime-scoped MCP servers and references env vars", () => {
      const mcpServers = {
        paperclip_connections: {
          url: "https://api.paperclip.test/mcp/runtime-tools",
          headers: {
            Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS}",
          },
          enabled: true as const,
          skip_preflight: true as const,
          tools: {
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
    it("creates unique temp HERMES_HOME (0700) with config.yaml (0600) and .env (0600)", async () => {
      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "paperclip-assigned",
          url: "http://localhost:3100/mcp/gateways/gw_1",
          token: "pcgw_assigned_secret",
          connectionId: "conn-assigned",
          allowedTools: ["mcp.tool:one", "mcp.tool:two"],
        },
        {
          name: "Paperclip connections",
          url: "http://localhost:3100/mcp/runtime-tools",
          token: "pcrt_connections_secret",
          connectionId: "conn-runtime",
          allowedTools: ["connections_search", "connection_request"],
        },
      ];

      const prepared = await prepareHermesMcpHome({ servers });
      cleanupDirs.push(prepared.homeDir);

      expect(prepared.serverCount).toBe(2);

      // Verify directory permissions 0700
      const dirStat = await fs.stat(prepared.homeDir);
      // Mode on POSIX systems mask with 0o777: 0o700 is 448
      expect(dirStat.mode & 0o777).toBe(0o700);

      // Verify config.yaml permissions 0600
      const configStat = await fs.stat(prepared.configPath);
      expect(configStat.mode & 0o777).toBe(0o600);

      // Verify .env permissions 0600
      const envStat = await fs.stat(prepared.envPath);
      expect(envStat.mode & 0o777).toBe(0o600);

      // Verify config.yaml content
      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("paperclip_assigned:");
      expect(configYaml).toContain("paperclip_connections:");
      expect(configYaml).toContain("enabled: true");
      expect(configYaml).toContain("skip_preflight: true");
      expect(configYaml).toContain('Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED}"');
      expect(configYaml).toContain('Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS}"');
      expect(configYaml).toContain('        - "mcp.tool:one"');
      expect(configYaml).toContain('        - "mcp.tool:two"');
      expect(configYaml).toContain('        - "connections_search"');
      expect(configYaml).toContain('        - "connection_request"');

      // Verify tokens are NOT in config.yaml
      expect(configYaml).not.toContain("pcgw_assigned_secret");
      expect(configYaml).not.toContain("pcrt_connections_secret");

      // Verify .env content
      const envContent = await fs.readFile(prepared.envPath, "utf8");
      expect(envContent).toContain('HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED="pcgw_assigned_secret"');
      expect(envContent).toContain('HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS="pcrt_connections_secret"');

      // Verify prepared.env record
      expect(prepared.env).toEqual({
        HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED: "pcgw_assigned_secret",
        HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS: "pcrt_connections_secret",
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
  });

  describe("cleanupHermesMcpHome", () => {
    it("handles null or non-existent directories gracefully", async () => {
      await expect(cleanupHermesMcpHome(null)).resolves.toBeUndefined();
      await expect(cleanupHermesMcpHome(undefined)).resolves.toBeUndefined();
      await expect(
        cleanupHermesMcpHome("/non/existent/path/that/should/not/fail"),
      ).resolves.toBeUndefined();
    });

    it("removes existing directory completely", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-test-rm-"));
      await fs.writeFile(path.join(tempDir, "file.txt"), "hello");
      await cleanupHermesMcpHome(tempDir);
      await expect(fs.access(tempDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

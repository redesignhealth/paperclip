import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// TECH-7228: the comms-board provisioner tokens follow the platform-default OpenAI key's early
// capture / re-scrub pattern. Real subprocesses, because the guarantee is about module evaluation order.
describe("comms-board provisioner credential startup capture order (TECH-7228)", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const serverRoot = path.join(repoRoot, "server");
  const tsxCliCandidates = [
    path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs"),
    path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
    path.join(serverRoot, "node_modules/tsx/dist/cli.mjs"),
  ];
  const tsxCli = tsxCliCandidates.find((c) => existsSync(c)) ?? tsxCliCandidates[0];

  const DEPLOY = {
    PAPERCLIP_COMMS_BOARD_MCP_URL: "https://board.deploy.test/mcp",
    PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN: "deploy-admin-token-fixture",
    PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL: "https://ownership.deploy.test/api",
    PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN: "deploy-ownership-token-fixture",
  };
  const FILE = [
    "PAPERCLIP_COMMS_BOARD_MCP_URL=https://attacker.file.test/mcp",
    "PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN=file-admin-token-fixture",
    "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL=https://attacker.file.test/api",
    "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN=file-ownership-token-fixture",
    "",
  ].join("\n");

  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(files: { instanceEnv?: string; cwdEnv?: string }) {
    const root = mkdtempSync(path.join(os.tmpdir(), "pcp-test-comms-startup-"));
    tmpDirs.push(root);
    const instanceDir = path.join(root, "instance");
    const cwd = path.join(root, "cwd");
    mkdirSync(instanceDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    if (files.instanceEnv !== undefined) writeFileSync(path.join(instanceDir, ".env"), files.instanceEnv);
    if (files.cwdEnv !== undefined) writeFileSync(path.join(cwd, ".env"), files.cwdEnv);
    return { root, cwd, configPath: path.join(instanceDir, "config.json") };
  }

  // Imports mirror index.ts: bootstrap first, then config (which runs both dotenv loads at module scope).
  function run(opts: { files: { instanceEnv?: string; cwdEnv?: string }; env: Record<string, string> }) {
    const { root, cwd, configPath } = setup(opts.files);
    const script = `
      import { spawnSync } from "node:child_process";
      import "${path.join(serverRoot, "src/bootstrap-platform-default-key.ts")}";
      import { readCommsBoardProvisionerSnapshot } from "${path.join(serverRoot, "src/secrets/comms-board-provisioner-credentials.ts")}";
      import "${path.join(serverRoot, "src/config.ts")}";

      // A default-env helper child: no env option, so it inherits process.env exactly as helpers do.
      const child = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.keys(process.env)))"], { encoding: "utf8" });
      const childKeys = JSON.parse(child.stdout.trim());
      console.log(JSON.stringify({
        snapshot: readCommsBoardProvisionerSnapshot(),
        parentCommsKeys: Object.keys(process.env).filter((k) => k.startsWith("PAPERCLIP_COMMS_BOARD_")),
        childCommsKeys: childKeys.filter((k) => k.startsWith("PAPERCLIP_COMMS_BOARD_")),
      }));
    `;
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string" && !k.startsWith("PAPERCLIP_")) baseEnv[k] = v;
    }
    const output = execFileSync(process.execPath, [tsxCli, "--input-type=module", "-e", script], {
      cwd,
      env: { ...baseEnv, HOME: root, PAPERCLIP_CONFIG: configPath, ...opts.env },
      encoding: "utf8",
    });
    return JSON.parse(output.trim().split("\n").pop()!) as {
      snapshot: Record<string, string | null>;
      parentCommsKeys: string[];
      childCommsKeys: string[];
    };
  }

  const TOKEN_KEYS = ["PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN", "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN"];

  // The CLI path (`paperclipai run`): the REAL CLI env loader (cli/src/config/env.ts ->
  // dotenv.config({ override: false })) preloads the instance .env into process.env BEFORE the server
  // bootstrap is dynamically imported. Only the two bootstrap modules are imported, never the server
  // entry, so no listener, database, or onboarding runs.
  function runCliPreload(opts: { instanceEnv: string; env: Record<string, string> }) {
    const { root, cwd, configPath } = setup({ instanceEnv: opts.instanceEnv });
    const script = `
      import { spawnSync } from "node:child_process";
      import { loadPaperclipEnvFile } from "${path.join(repoRoot, "cli/src/config/env.ts")}";

      const commsKeys = () => Object.keys(process.env).filter((k) => k.startsWith("PAPERCLIP_COMMS_BOARD_"));

      loadPaperclipEnvFile(process.env.PAPERCLIP_CONFIG);
      const afterCliPreload = commsKeys();

      await import("${path.join(serverRoot, "src/bootstrap-platform-default-key.ts")}");
      const credentials = await import("${path.join(serverRoot, "src/secrets/comms-board-provisioner-credentials.ts")}");
      const afterBootstrap = commsKeys();
      const firstSnapshot = credentials.readCommsBoardProvisionerSnapshot();

      await import("${path.join(serverRoot, "src/config.ts")}");
      const afterConfig = commsKeys();

      // A later fake environment repopulation (e.g. another dotenv load) must change nothing frozen.
      process.env.PAPERCLIP_COMMS_BOARD_MCP_URL = "https://attacker.late.test/mcp";
      process.env.PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN = "late-admin-token-fixture";
      process.env.PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL = "https://attacker.late.test/api";
      process.env.PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN = "late-ownership-token-fixture";
      credentials.captureAndScrubCommsBoardProvisionerCredentials();

      const child = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.keys(process.env)))"], { encoding: "utf8" });
      console.log(JSON.stringify({
        afterCliPreload,
        afterBootstrap,
        afterConfig,
        firstSnapshot,
        finalSnapshot: credentials.readCommsBoardProvisionerSnapshot(),
        parentCommsKeys: commsKeys(),
        childCommsKeys: JSON.parse(child.stdout.trim()).filter((k) => k.startsWith("PAPERCLIP_COMMS_BOARD_")),
      }));
    `;
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string" && !k.startsWith("PAPERCLIP_")) baseEnv[k] = v;
    }
    const output = execFileSync(process.execPath, [tsxCli, "--input-type=module", "-e", script], {
      cwd,
      env: { ...baseEnv, HOME: root, PAPERCLIP_CONFIG: configPath, ...opts.env },
      encoding: "utf8",
    });
    return JSON.parse(output.trim().split("\n").pop()!) as {
      afterCliPreload: string[];
      afterBootstrap: string[];
      afterConfig: string[];
      firstSnapshot: Record<string, string | null>;
      finalSnapshot: Record<string, string | null>;
      parentCommsKeys: string[];
      childCommsKeys: string[];
    };
  }

  it("bootstraps the comms capture beside the OpenAI capture, and config.ts re-scrubs after BOTH dotenv loads", () => {
    const bootstrap = readFileSync(path.join(serverRoot, "src/bootstrap-platform-default-key.ts"), "utf8");
    expect(bootstrap).toContain("captureAndScrubPlatformDefaultOpenAiKey();");
    expect(bootstrap).toContain("captureAndScrubCommsBoardProvisionerCredentials();");

    const config = readFileSync(path.join(serverRoot, "src/config.ts"), "utf8");
    const loads = [...config.matchAll(/loadDotenv\(\{[^}]*\}\);([^}]*)\}/g)];
    expect(loads).toHaveLength(2);
    for (const [, after] of loads) {
      expect(after).toContain("captureAndScrubPlatformDefaultOpenAiKey();");
      expect(after).toContain("captureAndScrubCommsBoardProvisionerCredentials();");
    }
  });

  it("deployment values win over BOTH dotenv files, tokens leave process.env, and a default-env child sees zero tokens", () => {
    const result = run({ files: { instanceEnv: FILE, cwdEnv: FILE }, env: DEPLOY });

    expect(result.snapshot).toEqual({
      boardMcpUrl: DEPLOY.PAPERCLIP_COMMS_BOARD_MCP_URL,
      boardAdminToken: DEPLOY.PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN,
      ownershipApiUrl: DEPLOY.PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL,
      ownershipApiToken: DEPLOY.PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN,
    });
    for (const key of TOKEN_KEYS) {
      expect(result.parentCommsKeys).not.toContain(key);
      expect(result.childCommsKeys).not.toContain(key);
    }
  });

  it("a token only the instance .env supplies is neither adopted nor left in the environment", () => {
    const result = run({ files: { instanceEnv: FILE, cwdEnv: "UNRELATED=1\n" }, env: {} });
    expect(result.snapshot).toEqual({ boardMcpUrl: null, boardAdminToken: null, ownershipApiUrl: null, ownershipApiToken: null });
    for (const key of TOKEN_KEYS) {
      expect(result.parentCommsKeys).not.toContain(key);
      expect(result.childCommsKeys).not.toContain(key);
    }
  });

  it("a token only the working-directory .env supplies is neither adopted nor left in the environment", () => {
    const result = run({ files: { cwdEnv: FILE }, env: {} });
    expect(result.snapshot).toEqual({ boardMcpUrl: null, boardAdminToken: null, ownershipApiUrl: null, ownershipApiToken: null });
    for (const key of TOKEN_KEYS) {
      expect(result.parentCommsKeys).not.toContain(key);
      expect(result.childCommsKeys).not.toContain(key);
    }
  });

  it("endpoint URLs absent at boot are not adopted from dotenv, while deployment tokens still capture", () => {
    const { PAPERCLIP_COMMS_BOARD_MCP_URL: _mcp, PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL: _own, ...tokensOnly } = DEPLOY;
    const result = run({ files: { cwdEnv: FILE }, env: tokensOnly });
    // URLs were absent from the deployment environment: the file URLs are not adopted either.
    expect(result.snapshot.boardMcpUrl).toBeNull();
    expect(result.snapshot.ownershipApiUrl).toBeNull();
    expect(result.snapshot.boardAdminToken).toBe(DEPLOY.PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN);
    for (const key of TOKEN_KEYS) expect(result.childCommsKeys).not.toContain(key);
  });

  it("CLI path: with an empty initial environment, the CLI-preloaded .env values become the FIRST snapshot, and later repopulation changes nothing", () => {
    const result = runCliPreload({ instanceEnv: FILE, env: {} });

    // Not vacuous: the real CLI loader really did put all four values into process.env first.
    expect([...result.afterCliPreload].sort()).toEqual(Object.keys(DEPLOY).sort());

    const fromFile = {
      boardMcpUrl: "https://attacker.file.test/mcp",
      boardAdminToken: "file-admin-token-fixture",
      ownershipApiUrl: "https://attacker.file.test/api",
      ownershipApiToken: "file-ownership-token-fixture",
    };
    expect(result.firstSnapshot).toEqual(fromFile);
    // Tokens are gone right after the bootstrap import and stay gone after config.ts's own dotenv loads.
    for (const key of TOKEN_KEYS) {
      expect(result.afterBootstrap).not.toContain(key);
      expect(result.afterConfig).not.toContain(key);
      expect(result.parentCommsKeys).not.toContain(key);
      expect(result.childCommsKeys).not.toContain(key);
    }
    // Later repopulation (tokens and URLs) never changes the frozen snapshot.
    expect(result.finalSnapshot).toEqual(fromFile);
  });

  it("CLI path: deployment values already in the environment stay the first snapshot over the CLI-preloaded .env", () => {
    const result = runCliPreload({ instanceEnv: FILE, env: DEPLOY });

    expect(result.firstSnapshot).toEqual({
      boardMcpUrl: DEPLOY.PAPERCLIP_COMMS_BOARD_MCP_URL,
      boardAdminToken: DEPLOY.PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN,
      ownershipApiUrl: DEPLOY.PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL,
      ownershipApiToken: DEPLOY.PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN,
    });
    expect(result.finalSnapshot).toEqual(result.firstSnapshot);
    for (const key of TOKEN_KEYS) {
      expect(result.afterBootstrap).not.toContain(key);
      expect(result.afterConfig).not.toContain(key);
      expect(result.parentCommsKeys).not.toContain(key);
      expect(result.childCommsKeys).not.toContain(key);
    }
  });
});

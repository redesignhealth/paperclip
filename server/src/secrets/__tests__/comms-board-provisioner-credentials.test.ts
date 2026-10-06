import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  captureAndScrubCommsBoardProvisionerCredentials,
  readCommsBoardProvisionerSnapshot,
  snapshotFromEnv,
  __resetForTests,
} from "../comms-board-provisioner-credentials.js";
import { resolveCommsBoardProvisionerConfig } from "../../services/comms-board-provisioner-client.js";

const ALL_KEYS = [
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
];

const ADMIN_TOKEN = "board-admin-token-fixture-aaaa";
const OWNERSHIP_TOKEN = "ownership-token-fixture-bbbb";
const BOARD_URL = "https://board.internal.test/mcp";
const OWNERSHIP_URL = "https://ownership.internal.test/api";

function fullEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
    [COMMS_BOARD_ADMIN_TOKEN_ENV]: ADMIN_TOKEN,
    [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
    [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    ...overrides,
  };
}

function clearProcessEnv() {
  for (const key of ALL_KEYS) delete process.env[key];
}

describe("comms-board-provisioner-credentials (TECH-7228)", () => {
  beforeEach(() => {
    __resetForTests();
    clearProcessEnv();
  });

  afterEach(() => {
    __resetForTests();
    clearProcessEnv();
  });

  it("captures the four settings, trimmed, and deletes ONLY the token variables", () => {
    const env = fullEnv({
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: `  ${ADMIN_TOKEN}\n`,
      [COMMS_BOARD_MCP_URL_ENV]: ` ${BOARD_URL} `,
      OTHER_VAR: "preserve-me",
    });

    expect(captureAndScrubCommsBoardProvisionerCredentials(env)).toEqual({ configured: true });

    expect(readCommsBoardProvisionerSnapshot()).toEqual({
      boardMcpUrl: BOARD_URL,
      boardAdminToken: ADMIN_TOKEN,
      ownershipApiUrl: OWNERSHIP_URL,
      ownershipApiToken: OWNERSHIP_TOKEN,
    });
    expect(COMMS_BOARD_ADMIN_TOKEN_ENV in env).toBe(false);
    expect(COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV in env).toBe(false);
    expect(env[COMMS_BOARD_MCP_URL_ENV]).toBe(` ${BOARD_URL} `);
    expect(env[COMMS_BOARD_OWNERSHIP_API_URL_ENV]).toBe(OWNERSHIP_URL);
    expect(env.OTHER_VAR).toBe("preserve-me");
  });

  it("scrubs process.env by default", () => {
    Object.assign(process.env, fullEnv());
    captureAndScrubCommsBoardProvisionerCredentials();
    expect(process.env[COMMS_BOARD_ADMIN_TOKEN_ENV]).toBeUndefined();
    expect(process.env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]).toBeUndefined();
    expect(readCommsBoardProvisionerSnapshot().boardAdminToken).toBe(ADMIN_TOKEN);
  });

  it("first capture wins: a later repopulation is deleted every time and never adopted", () => {
    const env = fullEnv();
    captureAndScrubCommsBoardProvisionerCredentials(env);

    for (let i = 0; i < 3; i++) {
      env[COMMS_BOARD_ADMIN_TOKEN_ENV] = `dotenv-admin-${i}`;
      env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV] = `dotenv-ownership-${i}`;
      env[COMMS_BOARD_MCP_URL_ENV] = "https://attacker.test/mcp";
      env[COMMS_BOARD_OWNERSHIP_API_URL_ENV] = "https://attacker.test/api";
      captureAndScrubCommsBoardProvisionerCredentials(env);
      expect(COMMS_BOARD_ADMIN_TOKEN_ENV in env).toBe(false);
      expect(COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV in env).toBe(false);
    }

    expect(readCommsBoardProvisionerSnapshot()).toEqual({
      boardMcpUrl: BOARD_URL,
      boardAdminToken: ADMIN_TOKEN,
      ownershipApiUrl: OWNERSHIP_URL,
      ownershipApiToken: OWNERSHIP_TOKEN,
    });
  });

  it("missing at first capture stays missing: a later dotenv-style value is scrubbed, not adopted", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(captureAndScrubCommsBoardProvisionerCredentials(env)).toEqual({ configured: false });

    Object.assign(env, fullEnv());
    expect(captureAndScrubCommsBoardProvisionerCredentials(env)).toEqual({ configured: false });

    expect(COMMS_BOARD_ADMIN_TOKEN_ENV in env).toBe(false);
    expect(COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV in env).toBe(false);
    expect(readCommsBoardProvisionerSnapshot()).toEqual({
      boardMcpUrl: null,
      boardAdminToken: null,
      ownershipApiUrl: null,
      ownershipApiToken: null,
    });
  });

  it("treats blank values as missing and reports not configured unless all four are present", () => {
    const env = fullEnv({ [COMMS_BOARD_ADMIN_TOKEN_ENV]: "   \t", [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: "" });
    expect(captureAndScrubCommsBoardProvisionerCredentials(env)).toEqual({ configured: false });
    const snapshot = readCommsBoardProvisionerSnapshot();
    expect(snapshot.boardAdminToken).toBeNull();
    expect(snapshot.ownershipApiUrl).toBeNull();
    expect(snapshot.ownershipApiToken).toBe(OWNERSHIP_TOKEN);
    expect(COMMS_BOARD_ADMIN_TOKEN_ENV in env).toBe(false);
  });

  it("does not impose a token format or minimum length (supported configs keep working)", () => {
    const env = fullEnv({ [COMMS_BOARD_ADMIN_TOKEN_ENV]: "x", [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: "y" });
    expect(captureAndScrubCommsBoardProvisionerCredentials(env)).toEqual({ configured: true });
    expect(readCommsBoardProvisionerSnapshot().boardAdminToken).toBe("x");
  });

  it("returns the empty snapshot before any capture and never reads process.env", () => {
    Object.assign(process.env, fullEnv());
    expect(readCommsBoardProvisionerSnapshot()).toEqual({
      boardMcpUrl: null,
      boardAdminToken: null,
      ownershipApiUrl: null,
      ownershipApiToken: null,
    });
  });

  it("the snapshot is immutable", () => {
    captureAndScrubCommsBoardProvisionerCredentials(fullEnv());
    const snapshot = readCommsBoardProvisionerSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { boardAdminToken: string | null }).boardAdminToken = "tampered";
    }).toThrow(TypeError);
    expect(readCommsBoardProvisionerSnapshot().boardAdminToken).toBe(ADMIN_TOKEN);
    expect(Object.isFrozen(snapshotFromEnv(fullEnv()))).toBe(true);
  });

  it("snapshotFromEnv is pure: no mutation of the input, process.env, or the boot snapshot", () => {
    captureAndScrubCommsBoardProvisionerCredentials(fullEnv());
    const injected = fullEnv({ [COMMS_BOARD_ADMIN_TOKEN_ENV]: "injected-token" });
    const before = { ...injected };

    expect(snapshotFromEnv(injected).boardAdminToken).toBe("injected-token");

    expect(injected).toEqual(before);
    expect(process.env[COMMS_BOARD_ADMIN_TOKEN_ENV]).toBeUndefined();
    expect(readCommsBoardProvisionerSnapshot().boardAdminToken).toBe(ADMIN_TOKEN);
  });

  it("never echoes a token value through any returned status", () => {
    const status = captureAndScrubCommsBoardProvisionerCredentials(fullEnv());
    expect(JSON.stringify(status)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(status)).not.toContain(OWNERSHIP_TOKEN);
  });
});

describe("resolveCommsBoardProvisionerConfig source selection (TECH-7228)", () => {
  beforeEach(() => {
    __resetForTests();
    clearProcessEnv();
  });

  afterEach(() => {
    __resetForTests();
    clearProcessEnv();
  });

  it("defaults to the frozen boot snapshot, not the live environment", () => {
    captureAndScrubCommsBoardProvisionerCredentials(fullEnv());
    // A later write to the live environment (e.g. dotenv on writable storage) must change nothing.
    Object.assign(process.env, fullEnv({ [COMMS_BOARD_MCP_URL_ENV]: "https://attacker.test/mcp", [COMMS_BOARD_ADMIN_TOKEN_ENV]: "late" }));

    const expected = {
      ok: true,
      config: {
        boardMcpUrl: BOARD_URL,
        boardAdminToken: ADMIN_TOKEN,
        ownershipApiUrl: OWNERSHIP_URL,
        ownershipApiToken: OWNERSHIP_TOKEN,
      },
    };
    expect(resolveCommsBoardProvisionerConfig()).toEqual(expected);
    expect(resolveCommsBoardProvisionerConfig(process.env)).toEqual(expected);
  });

  it("does not revive the lazy process.env lookup when the bootstrap never ran", () => {
    Object.assign(process.env, fullEnv());
    expect(resolveCommsBoardProvisionerConfig()).toEqual({ ok: false, reason: "provisioner_not_configured" });
    expect(resolveCommsBoardProvisionerConfig(process.env)).toEqual({ ok: false, reason: "provisioner_not_configured" });
  });

  it("converts a genuinely injected env object purely, ignoring the boot snapshot", () => {
    captureAndScrubCommsBoardProvisionerCredentials(fullEnv());
    const injected = fullEnv({
      [COMMS_BOARD_MCP_URL_ENV]: "https://injected.test/mcp",
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: "injected-admin",
    });
    const result = resolveCommsBoardProvisionerConfig(injected);
    expect(result).toMatchObject({ ok: true, config: { boardMcpUrl: "https://injected.test/mcp", boardAdminToken: "injected-admin" } });
    // Injected objects are never scrubbed.
    expect(injected[COMMS_BOARD_ADMIN_TOKEN_ENV]).toBe("injected-admin");
    expect(resolveCommsBoardProvisionerConfig({})).toEqual({ ok: false, reason: "provisioner_not_configured" });
  });

  it("keeps missing vs invalid classification on the snapshot path, with no secret in the result", () => {
    captureAndScrubCommsBoardProvisionerCredentials(fullEnv({ [COMMS_BOARD_MCP_URL_ENV]: `http://user:${ADMIN_TOKEN}@board.test/mcp?t=1` }));
    const invalid = resolveCommsBoardProvisionerConfig();
    expect(invalid).toEqual({ ok: false, reason: "provisioner_config_invalid" });
    expect(JSON.stringify(invalid)).not.toContain(ADMIN_TOKEN);

    __resetForTests();
    captureAndScrubCommsBoardProvisionerCredentials(fullEnv({ [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: undefined }));
    expect(resolveCommsBoardProvisionerConfig()).toEqual({ ok: false, reason: "provisioner_not_configured" });
  });
});

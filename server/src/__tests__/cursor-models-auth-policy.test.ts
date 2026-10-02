/**
 * TECH-7095: `agent models` must never inherit the full server env, and under the enforced
 * managed-only policy it must not list models through a host Cursor login.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import {
  listCursorModels,
  resetCursorModelsCacheForTests,
  setCursorModelsRunnerForTests,
} from "../adapters/cursor-models.js";

const HOST_SECRET = "sentinel-host-cursor-models-7095";
const BOUND_KEY = "bound-cursor-key-value";
const ENV_KEYS = ["PAPERCLIP_AGENT_AUTH_POLICY", "CURSOR_API_KEY", "PAPERCLIP_SERVER_ONLY_SECRET", "HOME", "XDG_CONFIG_HOME"];
const saved: Record<string, string | undefined> = {};

const okRunner = () =>
  vi.fn((_env: NodeJS.ProcessEnv) => ({
    status: 0,
    stdout: "Available models: auto, composer-1.5",
    stderr: "",
    hasError: false,
  }));

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.CURSOR_API_KEY = HOST_SECRET;
  process.env.PAPERCLIP_SERVER_ONLY_SECRET = HOST_SECRET;
  process.env.HOME = "/fake/host/home";
  process.env.XDG_CONFIG_HOME = "/fake/host/home/.config";
  resetCursorModelsCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetCursorModelsCacheForTests();
  setCursorModelsRunnerForTests(null);
});

describe("listCursorModels auth policy", () => {
  it("managed_only without an explicit CURSOR_API_KEY binding skips host-login listing", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const runner = okRunner();
    setCursorModelsRunnerForTests(runner);

    const models = await listCursorModels();

    expect(runner).not.toHaveBeenCalled();
    expect(models).toEqual(cursorFallbackModels);
  });

  it("managed_only with an explicit binding lists with an allowlisted env and no host home", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const runner = okRunner();
    setCursorModelsRunnerForTests(runner);

    const models = await listCursorModels({ env: { CURSOR_API_KEY: BOUND_KEY } });

    expect(runner).toHaveBeenCalledTimes(1);
    const env = runner.mock.calls[0]![0];
    expect(env.CURSOR_API_KEY).toBe(BOUND_KEY);
    expect(env.PAPERCLIP_SERVER_ONLY_SECRET).toBeUndefined();
    expect(env.HOME).toBeDefined();
    expect(env.HOME).not.toBe("/fake/host/home");
    expect(env.XDG_CONFIG_HOME).not.toBe("/fake/host/home/.config");
    expect(JSON.stringify(env)).not.toContain(HOST_SECRET);
    expect(JSON.stringify(env)).not.toContain("/fake/host/home");
    expect(models.some((model) => model.id === "composer-1.5")).toBe(true);
  });

  it("host_fallback keeps the legacy host login/key but never the full server env", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const runner = okRunner();
    setCursorModelsRunnerForTests(runner);

    await listCursorModels();

    expect(runner).toHaveBeenCalledTimes(1);
    const env = runner.mock.calls[0]![0];
    expect(env.HOME).toBe("/fake/host/home");
    expect(env.CURSOR_API_KEY).toBe(HOST_SECRET);
    expect(env.PAPERCLIP_SERVER_ONLY_SECRET).toBeUndefined();
  });
});

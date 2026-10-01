/**
 * TECH-7095: under managed_only a managed checkout clone that fails for lack of credentials
 * (no managed GitHub connection; host/server fallbacks refused) is a pre-spawn configuration
 * blocker (github_connection_required), never a silent fallback. A failure unrelated to auth,
 * or any failure under host_fallback, keeps the legacy plain error.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const cloneBehaviour = vi.hoisted(() => ({
  stderr: "fatal: Authentication failed for 'https://github.com/example/private.git/'",
  calls: [] as Array<{ args: string[]; env: Record<string, string | undefined> }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify: realPromisify } = await import("node:util");
  const actualAsync = realPromisify(actual.execFile);
  const isClone = (args: unknown) => Array.isArray(args) && args.includes("clone");
  const fake = ((...params: any[]) => (actual.execFile as any)(...params)) as any;
  fake[realPromisify.custom] = async (file: string, args: string[], options: any) => {
    if (file === "git" && isClone(args)) {
      cloneBehaviour.calls.push({ args, env: { ...(options?.env ?? {}) } });
      const error = Object.assign(new Error(`Command failed: git clone\n${cloneBehaviour.stderr}`), { stderr: cloneBehaviour.stderr });
      throw error;
    }
    return actualAsync(file, args, options);
  };
  return { ...actual, execFile: fake };
});

import { ensureManagedProjectWorkspace, ConfigurationIncompleteFailure } from "../services/heartbeat.ts";
import { createGitRemoteAuthProvider } from "../services/git-credentials.ts";

const SENTINEL = "sentinel-server-github-7095";
let home = "";
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_AGENT_AUTH_POLICY", "GITHUB_TOKEN"]) saved[key] = process.env[key];
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-7095-clone-"));
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "clone-7095";
  process.env.GITHUB_TOKEN = SENTINEL;
});
afterEach(() => { cloneBehaviour.calls.length = 0; });
afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

function attempt(projectId: string) {
  return ensureManagedProjectWorkspace({
    companyId: "company-1",
    projectId,
    repoUrl: "https://github.com/example/private.git",
    resolveGitAuth: createGitRemoteAuthProvider(null as unknown as Db, "company-1", undefined, {
      secrets: { getByName: async () => null, resolveSecretValue: async () => "" },
    }),
  }).catch((error: unknown) => error);
}

describe("managed checkout clone under the agent auth policy", () => {
  it("managed_only: an auth failure becomes github_connection_required with no credential in it", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    cloneBehaviour.stderr = "fatal: Authentication failed for 'https://github.com/example/private.git/'";
    const error = await attempt("project-auth");
    expect(error).toBeInstanceOf(ConfigurationIncompleteFailure);
    expect((error as ConfigurationIncompleteFailure).resultJson).toEqual({ configurationIncomplete: { reason: "github_connection_required" } });
    expect(JSON.stringify({ m: (error as Error).message, r: (error as ConfigurationIncompleteFailure).resultJson })).not.toContain(SENTINEL);
    // The clone ran credential-free: the server-env token never reached git.
    expect(cloneBehaviour.calls).toHaveLength(1);
    expect(JSON.stringify(cloneBehaviour.calls[0])).not.toContain(SENTINEL);
    expect(cloneBehaviour.calls[0]!.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  it("managed_only: a non-auth failure stays a plain error (runs that never need auth are not blocked)", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    cloneBehaviour.stderr = "fatal: unable to access: Could not resolve host: github.com";
    const error = await attempt("project-network");
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConfigurationIncompleteFailure);
  });

  it("host_fallback: the legacy server-env token is used and failures stay plain errors", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    cloneBehaviour.stderr = "fatal: Authentication failed for 'https://github.com/example/private.git/'";
    const error = await attempt("project-legacy");
    expect(error).not.toBeInstanceOf(ConfigurationIncompleteFailure);
    expect(cloneBehaviour.calls[0]!.env.PAPERCLIP_GIT_TOKEN).toBe(SENTINEL);
    // The legacy error message must still scrub/omit the token.
    expect(String((error as Error).message)).not.toContain(SENTINEL);
  });
});


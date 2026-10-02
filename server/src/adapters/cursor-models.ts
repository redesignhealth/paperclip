import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgentChildBaseEnv } from "@paperclipai/adapter-utils/agent-child-env";
import { currentAgentAuthPolicy, isManagedOnlyEnforced } from "@paperclipai/adapter-utils/agent-auth-policy";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import type { AdapterModel } from "./types.js";

const CURSOR_MODELS_TIMEOUT_MS = 5_000;
const CURSOR_MODELS_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 512 * 1024;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

type CursorModelsCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  hasError: boolean;
};

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sanitizeModelId(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\(.*\)\s*$/g, "")
    .trim();
}

function isLikelyModelId(raw: string): boolean {
  const value = sanitizeModelId(raw);
  if (!value) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function pushModelId(target: AdapterModel[], raw: string) {
  const id = sanitizeModelId(raw);
  if (!isLikelyModelId(id)) return;
  target.push({ id, label: id });
}

function collectFromJsonValue(value: unknown, target: AdapterModel[]) {
  if (typeof value === "string") {
    pushModelId(target, value);
    return;
  }
  if (!Array.isArray(value)) return;

  for (const item of value) {
    if (typeof item === "string") {
      pushModelId(target, item);
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string") {
      pushModelId(target, id);
    }
  }
}

export function parseCursorModelsOutput(stdout: string, stderr: string): AdapterModel[] {
  const models: AdapterModel[] = [];
  const combined = `${stdout}\n${stderr}`;

  const trimmedStdout = stdout.trim();
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedStdout) as unknown;
      if (Array.isArray(parsed)) {
        collectFromJsonValue(parsed, models);
      } else if (typeof parsed === "object" && parsed !== null) {
        const rec = parsed as Record<string, unknown>;
        collectFromJsonValue(rec.models, models);
        collectFromJsonValue(rec.data, models);
      }
    } catch {
      // Ignore malformed JSON and continue parsing plain text formats.
    }
  }

  for (const match of combined.matchAll(/available models?:\s*([^\n]+)/gi)) {
    const list = match[1] ?? "";
    for (const token of list.split(",")) {
      pushModelId(models, token);
    }
  }

  for (const lineRaw of combined.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const bullet = line.replace(/^[-*]\s+/, "").trim();
    if (!bullet || bullet.includes(" ")) continue;
    pushModelId(models, bullet);
  }

  return dedupeModels(models);
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([...models, ...cursorFallbackModels]);
}

/** Home/XDG names that point a CLI at a login; under the enforced policy they never come from the host. */
const HOME_ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

export type ListCursorModelsOptions = {
  /** Explicit (resolved) env bindings for the listing, e.g. a CURSOR_API_KEY secret-ref binding. */
  env?: Record<string, string | undefined> | null;
};

function hasValue(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Build the env for `agent models`. Never the full server env (TECH-7076/7095): an allowlisted
 * OS/runtime base plus explicit bindings only. Under the enforced managed-only policy the base
 * carries no host home/XDG (so the CLI cannot pick up a host Cursor login) and the caller must
 * supply a home or a throwaway one is used. Returns null when host-login listing would be the
 * only way to authenticate (enforced policy without an explicit CURSOR_API_KEY binding).
 */
function buildCursorModelsEnv(
  options: ListCursorModelsOptions,
  enforced: boolean,
): { env: NodeJS.ProcessEnv; needsIsolatedHome: boolean } | null {
  const explicit: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (typeof value === "string") explicit[key] = value;
  }
  const base = buildAgentChildBaseEnv(process.env);
  if (!enforced) {
    // Legacy listing used the server's login and any host CURSOR_API_KEY.
    const hostCursorApiKey = process.env.CURSOR_API_KEY; // auth-policy: host_fallback
    return {
      env: { ...base, ...(hasValue(hostCursorApiKey) ? { CURSOR_API_KEY: hostCursorApiKey } : {}), ...explicit },
      needsIsolatedHome: false,
    };
  }
  if (!hasValue(explicit.CURSOR_API_KEY)) return null;
  for (const name of HOME_ENV_NAMES) delete base[name];
  return { env: { ...base, ...explicit }, needsIsolatedHome: !hasValue(explicit.HOME) };
}

function defaultCursorModelsRunner(env: NodeJS.ProcessEnv): CursorModelsCommandResult {
  const result = spawnSync("agent", ["models"], {
    encoding: "utf8",
    timeout: CURSOR_MODELS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    env,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    hasError: Boolean(result.error),
  };
}

let cursorModelsRunner: (env: NodeJS.ProcessEnv) => CursorModelsCommandResult = defaultCursorModelsRunner;

function fetchCursorModelsFromCli(options: ListCursorModelsOptions): AdapterModel[] {
  const enforced = isManagedOnlyEnforced(currentAgentAuthPolicy());
  const prepared = buildCursorModelsEnv(options, enforced);
  // Enforced policy without an explicit key: listing would rely on a host login. Skip it and
  // serve the static fallback list instead.
  if (!prepared) return [];
  let isolatedHome: string | null = null;
  try {
    const env = { ...prepared.env };
    if (prepared.needsIsolatedHome) {
      isolatedHome = mkdtempSync(path.join(os.tmpdir(), "paperclip-cursor-models-"));
      env.HOME = isolatedHome;
      env.USERPROFILE = isolatedHome;
      env.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");
    }
    const result = cursorModelsRunner(env);
    const { stdout, stderr } = result;
    if (result.hasError && stdout.trim().length === 0 && stderr.trim().length === 0) {
      return [];
    }
    if ((result.status ?? 1) !== 0 && !/available models?:/i.test(`${stdout}\n${stderr}`)) {
      return [];
    }

    return parseCursorModelsOutput(stdout, stderr);
  } finally {
    if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
  }
}

export async function listCursorModels(options: ListCursorModelsOptions = {}): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = fetchCursorModelsFromCli(options);
  if (discovered.length > 0) {
    const merged = mergedWithFallback(discovered);
    cached = {
      expiresAt: now + CURSOR_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.models.length > 0) {
    return cached.models;
  }

  return dedupeModels(cursorFallbackModels);
}

export function resetCursorModelsCacheForTests() {
  cached = null;
}

export function setCursorModelsRunnerForTests(
  runner: ((env: NodeJS.ProcessEnv) => CursorModelsCommandResult) | null,
) {
  cursorModelsRunner = runner ?? defaultCursorModelsRunner;
}

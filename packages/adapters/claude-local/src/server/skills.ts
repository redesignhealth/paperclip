import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { currentAgentAuthPolicy, isManagedOnlyEnforced } from "@paperclipai/adapter-utils/agent-auth-policy";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveClaudeSkillsHome(config: Record<string, unknown>): string | null {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  if (configuredHome) return path.join(path.resolve(configuredHome), ".claude", "skills");
  // TECH-7095: under the enforced managed-only policy the child's home is per-run and
  // isolated; never inspect the server user's ~/.claude/skills.
  if (isManagedOnlyEnforced(currentAgentAuthPolicy())) return null;
  // auth-policy: host_fallback
  return path.join(os.homedir(), ".claude", "skills");
}

async function buildClaudeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveClaudeSkillsHome(config);
  const installed = skillsHome ? await readInstalledSkillTargets(skillsHome) : new Map();
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "claude_local",
    availableEntries,
    desiredSkills,
    configuredDetail: "Will be materialized into the stable Paperclip-managed Claude prompt bundle on the next run.",
    externalInstalled: installed,
    externalLocationLabel: "~/.claude/skills",
    externalDetail: "Installed outside Paperclip management in the Claude skills home.",
    skillsHome: skillsHome ?? undefined,
  });
}

export async function listClaudeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildClaudeSkillSnapshot(ctx.config);
}

export async function syncClaudeSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildClaudeSkillSnapshot(ctx.config);
}

export function resolveClaudeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}

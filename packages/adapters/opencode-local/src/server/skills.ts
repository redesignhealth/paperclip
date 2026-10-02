import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { AgentAuthPolicyError, currentAgentAuthPolicy, isManagedOnlyEnforced } from "@paperclipai/adapter-utils/agent-auth-policy";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Skills home for the child. Under the enforced managed-only policy (TECH-7095) it derives ONLY
 * from the child's own HOME (config.env.HOME, the per-run home); there is no host fallback and
 * `null` means "no child home available" (callers must not touch the host ~/.claude/skills).
 */
export function resolveOpenCodeSkillsHomeOrNull(config: Record<string, unknown>): string | null {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  if (configuredHome) return path.join(path.resolve(configuredHome), ".claude", "skills");
  if (isManagedOnlyEnforced(currentAgentAuthPolicy())) return null;
  // auth-policy: host_fallback
  return path.join(os.homedir(), ".claude", "skills");
}

export function resolveOpenCodeSkillsHome(config: Record<string, unknown>) {
  const resolved = resolveOpenCodeSkillsHomeOrNull(config);
  if (!resolved) {
    throw new AgentAuthPolicyError("agent_home_isolation_required", { adapterType: "opencode_local" });
  }
  return resolved;
}

const PER_RUN_SKILLS_HOME_LABEL = "~/.claude/skills";
const PER_RUN_SKILLS_WARNING =
  "This deployment gives every run an isolated home; skills are linked into that run home at run time.";

async function buildOpenCodeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const childSkillsHome = resolveOpenCodeSkillsHomeOrNull(config);
  const skillsHome = childSkillsHome ?? PER_RUN_SKILLS_HOME_LABEL;
  const installed = childSkillsHome ? await readInstalledSkillTargets(childSkillsHome) : new Map();
  return buildPersistentSkillSnapshot({
    adapterType: "opencode_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.claude/skills",
    installedDetail: "Installed in the shared Claude/OpenCode skills home.",
    missingDetail: "Configured but not currently linked into the shared Claude/OpenCode skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation in the shared skills home.",
    externalDetail: "Installed outside Paperclip management in the shared skills home.",
    warnings: childSkillsHome
      ? ["OpenCode currently uses the shared Claude skills home (~/.claude/skills)."]
      : [PER_RUN_SKILLS_WARNING],
  });
}

export async function listOpenCodeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config);
}

export async function syncOpenCodeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const skillsHome = resolveOpenCodeSkillsHomeOrNull(ctx.config);
  // Enforced policy with no child home: nothing persistent to sync; never write the host home.
  if (!skillsHome) return buildOpenCodeSkillSnapshot(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildOpenCodeSkillSnapshot(ctx.config);
}

export function resolveOpenCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}

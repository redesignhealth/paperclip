import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  type InstalledSkillTarget,
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import {
  AgentAuthPolicyError,
  currentAgentAuthPolicy,
  isManagedOnlyEnforced,
} from "@paperclipai/adapter-utils/agent-auth-policy";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const SKILLS_LOCATION_LABEL = "~/.cursor/skills";

/**
 * Resolve the Cursor skills home from the child's HOME (adapter config env), or null when
 * the managed-only auth policy is enforced and no child HOME was supplied. Under the enforced
 * policy the server user's home is never a fallback (TECH-7095).
 */
export function resolveCursorSkillsHomeOrNull(config: Record<string, unknown>): string | null {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  if (configuredHome) return path.join(path.resolve(configuredHome), ".cursor", "skills");
  if (isManagedOnlyEnforced(currentAgentAuthPolicy())) return null;
  return path.join(os.homedir(), ".cursor", "skills"); // auth-policy: host_fallback
}

/** Like {@link resolveCursorSkillsHomeOrNull} but refuses (before any spawn) when no child HOME exists. */
export function resolveCursorSkillsHome(config: Record<string, unknown>): string {
  const skillsHome = resolveCursorSkillsHomeOrNull(config);
  if (!skillsHome) {
    throw new AgentAuthPolicyError("agent_home_isolation_required", { adapterType: "cursor" });
  }
  return skillsHome;
}

const RUN_HOME_SKILLS_WARNING =
  "Skills are linked into each run's isolated home at run time; no persistent skills home is used in this deployment.";

async function buildCursorSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const resolvedSkillsHome = resolveCursorSkillsHomeOrNull(config);
  const skillsHome = resolvedSkillsHome ?? SKILLS_LOCATION_LABEL;
  const installed = resolvedSkillsHome
    ? await readInstalledSkillTargets(resolvedSkillsHome)
    : new Map<string, InstalledSkillTarget>();
  return buildPersistentSkillSnapshot({
    ...(resolvedSkillsHome ? {} : { warnings: [RUN_HOME_SKILLS_WARNING] }),
    adapterType: "cursor",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: SKILLS_LOCATION_LABEL,
    missingDetail: "Configured but not currently linked into the Cursor skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listCursorSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildCursorSkillSnapshot(ctx.config);
}

export async function syncCursorSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const skillsHome = resolveCursorSkillsHomeOrNull(ctx.config);
  // Managed-only with no child HOME: nothing persistent to write; execute links skills into
  // the per-run home instead.
  if (!skillsHome) return buildCursorSkillSnapshot(ctx.config);
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

  return buildCursorSkillSnapshot(ctx.config);
}

export function resolveCursorDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}

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
import { currentAgentAuthPolicy, isManagedOnlyEnforced } from "@paperclipai/adapter-utils/agent-auth-policy";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const SKILLS_LOCATION_LABEL = "~/.kimi-code/skills";
const RUN_HOME_SKILLS_WARNING =
  "Skills are delivered to each run from an isolated per-run directory; no persistent skills home is used in this deployment.";

/**
 * Resolve the Kimi skills home, honoring KIMI_CODE_HOME (adapter config env
 * first, then the server process env) and falling back to ~/.kimi-code/skills.
 * Under the enforced managed-only auth policy only the adapter config env counts
 * (never the server's KIMI_CODE_HOME or home); null when it supplies neither.
 */
function resolveKimiSkillsHome(config: Record<string, unknown>): string | null {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const enforced = isManagedOnlyEnforced(currentAgentAuthPolicy());
  const kimiCodeHome =
    asString(env.KIMI_CODE_HOME) ??
    (enforced ? null : asString(process.env.KIMI_CODE_HOME)); // auth-policy: host_fallback
  if (kimiCodeHome) return path.join(path.resolve(kimiCodeHome), "skills");
  const configuredHome = asString(env.HOME);
  if (configuredHome) return path.join(path.resolve(configuredHome), ".kimi-code", "skills");
  if (enforced) return null;
  return path.join(os.homedir(), ".kimi-code", "skills"); // auth-policy: host_fallback
}

async function buildKimiSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const resolvedSkillsHome = resolveKimiSkillsHome(config);
  const skillsHome = resolvedSkillsHome ?? SKILLS_LOCATION_LABEL;
  const installed = resolvedSkillsHome
    ? await readInstalledSkillTargets(resolvedSkillsHome)
    : new Map<string, InstalledSkillTarget>();
  return buildPersistentSkillSnapshot({
    ...(resolvedSkillsHome ? {} : { warnings: [RUN_HOME_SKILLS_WARNING] }),
    adapterType: "kimi_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: SKILLS_LOCATION_LABEL,
    missingDetail: "Configured but not currently linked into the Kimi skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listKimiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildKimiSkillSnapshot(ctx.config);
}

export async function syncKimiSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const skillsHome = resolveKimiSkillsHome(ctx.config);
  // Managed-only with no child home: nothing persistent to write (runs use --skills-dir).
  if (!skillsHome) return buildKimiSkillSnapshot(ctx.config);
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

  return buildKimiSkillSnapshot(ctx.config);
}

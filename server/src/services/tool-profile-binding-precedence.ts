import type { ToolProfileBindingTargetType } from "@paperclipai/shared";

type BindingLike = {
  profileId: string;
  targetType: ToolProfileBindingTargetType;
  targetId: string;
  priority: number;
  createdAt: Date | string;
  metadata?: unknown;
};

type ProfileLike = {
  id: string;
  profileKey: string;
  metadata: unknown;
};

const TOOL_PROFILE_SCOPE_PRECEDENCE: Record<ToolProfileBindingTargetType, number> = {
  // Named gateways bind one concrete MCP endpoint instance, so they should
  // override broader run, agent, and company defaults when both match.
  gateway: 0,
  issue: 1,
  routine: 2,
  agent: 3,
  project: 4,
  company: 5,
};

function createdAtMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function toolProfileBindingScopePrecedence(targetType: ToolProfileBindingTargetType): number {
  return TOOL_PROFILE_SCOPE_PRECEDENCE[targetType];
}

export function narrowestScopeBindings<T extends BindingLike>(bindings: T[]): T[] {
  if (bindings.length === 0) return [];
  const winningScope = Math.min(...bindings.map((binding) => toolProfileBindingScopePrecedence(binding.targetType)));
  return bindings
    .filter((binding) => toolProfileBindingScopePrecedence(binding.targetType) === winningScope)
    .sort((a, b) =>
      a.priority - b.priority
      || createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt)
      || a.profileId.localeCompare(b.profileId)
    );
}

export function profileIdsInBindingOrder<T extends Pick<BindingLike, "profileId">>(bindings: T[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.profileId)) continue;
    seen.add(binding.profileId);
    ordered.push(binding.profileId);
  }
  return ordered;
}

function isWizardAppProfile(profile: ProfileLike, connectionId?: string | null): boolean {
  if (!profile.metadata || typeof profile.metadata !== "object" || Array.isArray(profile.metadata)) return false;
  const metadata = profile.metadata as Record<string, unknown>;
  if (metadata.source !== "app_gallery_finish" || typeof metadata.connectionId !== "string") return false;
  if (profile.profileKey !== `app:${metadata.connectionId}`) return false;
  return connectionId === undefined || connectionId === null || metadata.connectionId === connectionId;
}

/**
 * A server-tagged default-MCP app offering: an agent-scoped binding whose metadata names
 * `default_mcp_spec` and the connection, onto that connection's own wizard-managed app profile. It
 * offers (permits) an app the org already curated; it is not the operator's explicit agent policy,
 * so it must not narrow away company-bound profiles. Anything that does not match this exact shape
 * (including a caller-written look-alike on another kind of profile) keeps ordinary precedence.
 */
function isDefaultAppOffering(binding: BindingLike, profilesById: Map<string, ProfileLike>): boolean {
  if (binding.targetType !== "agent") return false;
  const metadata = binding.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const { source, connectionId } = metadata as Record<string, unknown>;
  if (source !== "default_mcp_spec" || typeof connectionId !== "string") return false;
  const profile = profilesById.get(binding.profileId);
  return Boolean(profile && isWizardAppProfile(profile, connectionId));
}

/**
 * App-wizard assignments are additive capabilities: choosing an app for all
 * agents (or for one agent) must not disappear merely because that agent also
 * has a narrower general-purpose profile. Ordinary profiles still use the
 * narrowest-scope rule; only the profile managed by the app wizard is carried
 * alongside that winning tier.
 */
export function effectiveToolProfileBindings<T extends BindingLike>(
  bindings: T[],
  profiles: ProfileLike[],
  connectionId?: string | null,
  options?: { includeAdditiveAppProfiles?: boolean },
): T[] {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const offerings = new Set(bindings.filter((binding) => isDefaultAppOffering(binding, profilesById)));
  // Default offerings never take part in the narrowest-scope decision.
  const ordinary = bindings.filter((binding) => !offerings.has(binding));
  if (options?.includeAdditiveAppProfiles === false) {
    return narrowestScopeBindings(ordinary);
  }
  const appProfileIds = new Set(
    profiles.filter((profile) => isWizardAppProfile(profile, connectionId)).map((profile) => profile.id),
  );
  const selected = [
    ...narrowestScopeBindings(ordinary),
    ...bindings.filter((binding) => appProfileIds.has(binding.profileId)),
  ];
  const seen = new Set<string>();
  return selected.filter((binding) => {
    const key = `${binding.targetType}:${binding.targetId}:${binding.profileId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

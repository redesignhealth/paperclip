import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { commsWakeRegistrations, companies, companySecrets, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveCommsBoardProvisionerConfig, setCommsBoardWakeTarget } from "./comms-board-provisioner-client.js";
import { parseCommsWakeSecret } from "./comms-wake-signature.js";
import { resolveCommsBoardBinding, type DefaultMcpSetupHook } from "./default-mcp-setup.js";
import { secretService } from "./secrets.js";

/**
 * Comms-board wake registration of a NEW agent (TECH-9912), run as the setup hook of the `comms-wake` default-MCP entry.
 * The entry is only written for a company whose `commsBoardWakeEnabled` setting is on, so the existing setup machinery
 * (claim, backoff, durable sweep, visible state in agent metadata) is also the reconcile: a run that cannot finish stays
 * `pending` with a reason, and a later sweep runs it again.
 *
 * Order matters: the signing secret is stored and the registration row upserted BEFORE the board is told about it, so the
 * wake route can verify as soon as the board starts sending. Re-running is safe. The registration (and so the secret) is
 * reused, never regenerated, and the board call replaces the target with the same values. A finished (`ready`) entry is
 * never claimed again. The secret value lives only in the vault and in the one board call: it is never logged, put in agent
 * metadata or the activity log, or returned.
 */

export const COMMS_WAKE_ENTRY_KEY = "comms-wake";
export const COMMS_WAKE_SYSTEM_LABEL = "paperclip";
const COMMS_WAKE_SECRET_CONFIG_PATH = "comms_wake.registration";

let publicBaseUrl: string | null = null;

/** Boot-time: the instance's own externally reachable base URL (`auth.publicBaseUrl`, the one other features build callback URLs from). */
export function setCommsWakePublicBaseUrl(value: string | null | undefined): void {
  publicBaseUrl = value?.trim() ? value.trim() : null;
}

/** `<public origin>/api/comms-board/wake/<agentId>`, or null when no public base URL is set or it is not https. */
export function buildCommsWakeUrl(agentId: string, baseUrl: string | null = publicBaseUrl): string | null {
  if (!baseUrl) return null;
  try {
    const origin = new URL(baseUrl);
    if (origin.protocol !== "https:" || origin.username || origin.password) return null;
    return `${origin.origin}/api/comms-board/wake/${agentId}`;
  } catch {
    return null;
  }
}

export function generateCommsWakeSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

/**
 * Adapter types the AUTOMATIC paths never subscribe: a `process` agent gets no board tools and no guidance, so a wake would
 * only create an empty run. The operator enrol command is not restricted by this.
 */
export const COMMS_WAKE_AUTOMATIC_EXCLUDED_ADAPTER_TYPES: readonly string[] = ["process"];

/** New-agent creation: `comms-wake` is left out of the agent's setup state when the company's setting is off (it is on by default). */
export async function commsWakeExcludedSetupKeys(db: Pick<Db, "select">, companyId: string): Promise<Set<string>> {
  const [company] = await db
    .select({ enabled: companies.commsBoardWakeEnabled })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return company?.enabled === true ? new Set() : new Set([COMMS_WAKE_ENTRY_KEY]);
}

export const commsWakeRegistrationHook: DefaultMcpSetupHook = async (input) => {
  const { db, companyId, agentId } = input;
  const errorClass = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

  // Everything that can be missing is checked before anything is stored or called.
  const [company] = await db
    .select({ enabled: companies.commsBoardWakeEnabled })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (company?.enabled !== true) return { kind: "waiting", reason: "operator_excluded" };

  const board = await resolveCommsBoardBinding(db, companyId, agentId);
  if (!board?.boardAgentId) return { kind: "waiting", reason: "board_not_ready" };

  const wakeUrl = buildCommsWakeUrl(agentId);
  if (!wakeUrl) return { kind: "waiting", reason: "public_base_url_unavailable" };

  const provisioner = resolveCommsBoardProvisionerConfig(input.env);
  if (!provisioner.ok) return { kind: "waiting", reason: provisioner.reason };

  const secrets = secretService(db);
  let secretValue: string;
  try {
    const [registration] = await db
      .select({ id: commsWakeRegistrations.id, secretId: commsWakeRegistrations.signingSecretId, boardAgentId: commsWakeRegistrations.boardAgentId })
      .from(commsWakeRegistrations)
      .where(eq(commsWakeRegistrations.agentId, agentId))
      .limit(1);
    if (registration) {
      // A retry reuses the stored secret: the board gets the same value again and no second secret exists.
      secretValue = await secrets.resolveSecretValue(companyId, registration.secretId, "latest", {
        accessContext: { consumerType: "system", consumerId: agentId, configPath: COMMS_WAKE_SECRET_CONFIG_PATH, actorType: "system", actorId: null },
      });
      if (!parseCommsWakeSecret(secretValue)) return { kind: "error", reason: "secret_unavailable" };
      if (registration.boardAgentId !== board.boardAgentId) {
        await db
          .update(commsWakeRegistrations)
          .set({ boardAgentId: board.boardAgentId, updatedAt: new Date() })
          .where(eq(commsWakeRegistrations.id, registration.id));
      }
    } else {
      secretValue = generateCommsWakeSecret();
      const secretKey = `comms_wake.signing_secret.${agentId}`;
      // A crash between the secret and the registration can leave this agent's own secret behind: it is not referenced by
      // any registration, so it is rotated to the new value. One that was revoked on purpose is never revived.
      const rows = await db
        .select({ id: companySecrets.id, status: companySecrets.status, deletedAt: companySecrets.deletedAt, latestVersion: companySecrets.latestVersion })
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, secretKey)));
      if (rows.length > 1) return { kind: "error", reason: "secret_unavailable" };
      let secretId: string;
      const existing = rows[0];
      if (existing) {
        if (existing.status !== "active" || existing.deletedAt) return { kind: "error", reason: "secret_unavailable" };
        await secrets.rotate(existing.id, { value: secretValue, expectedLatestVersion: existing.latestVersion }, { userId: input.current().ownerUserId });
        secretId = existing.id;
      } else {
        const created = await secrets.create(
          companyId,
          {
            name: `Comms wake signing secret (agent ${agentId})`,
            key: secretKey,
            provider: "local_encrypted",
            value: secretValue,
            description: `Managed signing secret for comms board wake events of agent ${agentId}. Provisioned at agent creation.`,
          },
          { userId: input.current().ownerUserId },
        );
        secretId = created.id;
      }
      await db
        .insert(commsWakeRegistrations)
        .values({ companyId, agentId, boardAgentId: board.boardAgentId, signingSecretId: secretId })
        .onConflictDoUpdate({
          target: commsWakeRegistrations.agentId,
          set: { boardAgentId: board.boardAgentId, signingSecretId: secretId, updatedAt: new Date() },
        });
    }
  } catch (err) {
    // Only the error class is logged: never a message, key or value.
    logger.warn({ agentId, errorClass: errorClass(err) }, "comms wake registration could not be stored");
    return { kind: "waiting", reason: "binding_failed" };
  }

  const outcome = await setCommsBoardWakeTarget(
    provisioner.config,
    { boardAgentId: board.boardAgentId, url: wakeUrl, secret: secretValue, system: COMMS_WAKE_SYSTEM_LABEL },
    input.fetchImpl,
  );
  if (outcome.ok) return { kind: "ready" };
  // The call replaces the target, so every failure is safe to run again: it waits (capped backoff) and stays visible.
  return { kind: "waiting", reason: outcome.reason === "rejected" ? "board_rejected" : "board_failed" };
};

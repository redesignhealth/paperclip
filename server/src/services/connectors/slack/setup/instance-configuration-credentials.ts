import { eq, inArray, sql } from "drizzle-orm";
import { instanceSlackConfigurationCredentials } from "@paperclipai/db";
import type { SlackConfigurationCredential } from "@paperclipai/shared";
import { forbidden } from "../../../../errors.js";
import { logger } from "../../../../middleware/logger.js";
import { decryptInstanceSecretValue, encryptInstanceSecretValue } from "../../../../secrets/local-encrypted-provider.js";
import { object, providerFailure, type SlackSetupActor, type SlackRegistrationStore } from "./registration.js";

/**
 * RH-only: the instance-wide Slack app-configuration credential.
 *
 * An instance administrator saves one refresh token per Slack workspace, and
 * every company's Slack setup uses it, so people who cannot generate a Slack
 * configuration token never have to. It follows the same single-use rotation
 * protocol as the personal credentials in `configuration-credentials.ts` (a
 * short claim, the provider call with no transaction held, a fenced write), but
 * stores the token pair encrypted on a table with no company, because the
 * tenant policy would otherwise hide one company's row from another's requests.
 *
 * This file does not know how to talk to Slack or how long to wait: the
 * personal service hands those in, so there is one copy of that behaviour.
 */
type Database = SlackRegistrationStore["db"];
type Row = typeof instanceSlackConfigurationCredentials.$inferSelect;
type Material = Parameters<typeof decryptInstanceSecretValue>[0];
type Rotated = { token: string; refreshToken: string; expiresAt: Date; teamId: string; userId: string };

export type InstanceCredentialDeps = {
  db: Database;
  rotate: (refreshToken: string) => Promise<Rotated>;
  rethrowSaveFailure: (error: unknown) => never;
  withWriteRetry: <T>(work: () => Promise<T>) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  accessMarginMs: number;
  rotatingStaleMs: number;
  pollMs: number;
  timeoutMs: number;
};

/** Records a rotation in the company whose request started it; concurrent callers share that one flight. */
export type InstanceCredentialAudit = (action: string, workspaceId: string, details?: Record<string, unknown>) => Promise<void>;

export const INSTANCE_CREDENTIAL_ADMIN_ONLY = "slack_configuration_shared_forbidden";

export function createInstanceSlackConfigurationCredentials(deps: InstanceCredentialDeps) {
  const { db, rotate, rethrowSaveFailure, withWriteRetry, sleep } = deps;
  const table = instanceSlackConfigurationCredentials;
  const credentialLock = (id: string) => sql`select pg_advisory_xact_lock(hashtextextended(${`slack-instance-config-credential:${id}`}, 0))`;

  function requireAdministrator(actor: SlackSetupActor, what: string) {
    if (!actor.bypassPermissionCheck) {
      throw forbidden(`Only an instance administrator can ${what}.`, { code: INSTANCE_CREDENTIAL_ADMIN_ONLY });
    }
  }

  function summary(row: Row): SlackConfigurationCredential {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      slackUserId: row.slackUserId,
      // A live rotation is still usable; only a proven rejection needs a re-paste.
      status: row.status === "active" || row.status === "rotating" ? "active" : "reauthorize",
      lastRotatedAt: row.lastRotatedAt ? row.lastRotatedAt.toISOString() : null,
      shared: true,
    };
  }

  function read(credentialId: string, material: Row["accessMaterial"]): string {
    if (!material) throw providerFailure("slack_configuration_refresh_required");
    try {
      return decryptInstanceSecretValue(material as Material);
    } catch {
      // Never include the material or the decrypt error: a bad key must not echo ciphertext.
      // The log is what tells an operator this is the instance master key, not an expired Slack token.
      logger.error({ credentialId }, "Slack instance configuration credential could not be decrypted; check PAPERCLIP_SECRETS_MASTER_KEY");
      throw providerFailure("slack_configuration_refresh_required");
    }
  }

  async function has(id: string): Promise<boolean> {
    const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id));
    return Boolean(row);
  }

  async function list(): Promise<SlackConfigurationCredential[]> {
    const rows = await db.select().from(table)
      .where(inArray(table.status, ["active", "rotating", "reauthorize"]))
      .orderBy(table.workspaceId);
    return rows.map(summary);
  }

  async function save(actor: SlackSetupActor, refreshToken: string): Promise<SlackConfigurationCredential> {
    // Checked before the rotation below, which spends the pasted token.
    requireAdministrator(actor, "save a Slack token for every company");
    // Rotate on save: the pasted value is spent, so the stored token is the
    // only valid one and re-pasting the same value fails by design.
    let rotated: Rotated;
    try {
      rotated = await rotate(refreshToken);
    } catch (error) {
      throw rethrowSaveFailure(error);
    }
    try {
      const saved = await withWriteRetry(() => db.transaction(async tx => {
        // One credential per workspace: serialize saves on the workspace, then
        // on the credential. Every other path takes only the credential lock,
        // so this order can never invert.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-instance-config-credential-workspace:${rotated.teamId}`}, 0))`);
        const [existing] = await tx.select().from(table).where(eq(table.workspaceId, rotated.teamId));
        const values = {
          slackUserId: rotated.userId,
          savedByUserId: actor.userId,
          status: "active" as const,
          accessMaterial: encryptInstanceSecretValue(rotated.token) as unknown as Record<string, unknown>,
          refreshMaterial: encryptInstanceSecretValue(rotated.refreshToken) as unknown as Record<string, unknown>,
          accessExpiresAt: rotated.expiresAt,
          lastRotatedAt: new Date(),
          rotationStartedAt: null,
        };
        if (!existing) {
          const [row] = await tx.insert(table).values({ workspaceId: rotated.teamId, ...values }).returning();
          if (!row) throw new Error("Slack instance configuration credential was not saved");
          return row;
        }
        // A re-paste or a paste over a revoked row bumps the generation fence, so
        // a rotation already in flight discards its pair instead of overwriting this one.
        // The counters are incremented in SQL: `existing` was read before the credential
        // lock, and a rotation, a failed flight or a forget may have committed since.
        await tx.execute(credentialLock(existing.id));
        const [row] = await tx.update(table).set({
          ...values,
          revision: sql`${table.revision} + 1`,
          chainGeneration: sql`${table.chainGeneration} + 1`,
          updatedAt: new Date(),
        }).where(eq(table.id, existing.id)).returning();
        if (!row) throw new Error("Slack instance configuration credential was not saved");
        return row;
      }));
      return summary(saved);
    } catch (error) {
      // Never include the pair or the provider response in the log.
      logger.error({ credentialWorkspaceId: rotated.teamId, err: error instanceof Error ? error.message : "unknown" }, "Slack instance configuration credential could not be saved");
      throw providerFailure("slack_configuration_refresh_uncertain");
    }
  }

  /** Makes Paperclip forget the chain; revoking it with Slack is a separate Slack action. */
  async function forget(id: string, actor: SlackSetupActor): Promise<Row> {
    requireAdministrator(actor, "forget the Slack token shared with every company");
    return db.transaction(async tx => {
      await tx.execute(credentialLock(id));
      const [current] = await tx.select().from(table).where(eq(table.id, id));
      if (!current) throw providerFailure("slack_configuration_refresh_required");
      await tx.update(table).set({
        status: "revoked", accessMaterial: null, refreshMaterial: null,
        chainGeneration: current.chainGeneration + 1, revision: current.revision + 1, updatedAt: new Date(),
      }).where(eq(table.id, id));
      return current;
    });
  }

  type PhaseA =
    | { kind: "cached"; row: Row; token: string }
    | { kind: "busy" }
    | { kind: "claimed"; row: Row; refreshToken: string; revision: number; chainGeneration: number; recovery: boolean };

  /** SHORT tx. Decides whether this request needs a rotation and durably claims it before Slack is contacted. */
  async function phaseA(id: string): Promise<PhaseA> {
    return db.transaction(async tx => {
      await tx.execute(credentialLock(id));
      const [row] = await tx.select().from(table).where(eq(table.id, id));
      if (!row || row.status === "revoked") throw providerFailure("slack_configuration_refresh_required");
      if (row.status === "reauthorize") throw providerFailure("slack_configuration_refresh_invalid");
      if (row.status === "active" && row.accessExpiresAt && row.accessExpiresAt.getTime() > Date.now() + deps.accessMarginMs) {
        return { kind: "cached", row, token: read(id, row.accessMaterial) };
      }
      if (row.status === "rotating" && !row.rotationStartedAt) throw providerFailure("slack_configuration_refresh_uncertain");
      if (row.status === "rotating" && row.rotationStartedAt!.getTime() > Date.now() - deps.rotatingStaleMs) return { kind: "busy" };
      // Stale `rotating` (crash or lost response): the stored refresh token was
      // never overwritten, so reclaiming is the only way the chain survives.
      const recovery = row.status === "rotating";
      const refreshToken = read(id, row.refreshMaterial);
      const [claimed] = await tx.update(table).set({
        status: "rotating", rotationStartedAt: new Date(), revision: row.revision + 1, updatedAt: new Date(),
      }).where(eq(table.id, id)).returning();
      if (!claimed) throw providerFailure("slack_configuration_refresh_required");
      return { kind: "claimed", row: claimed, refreshToken, revision: claimed.revision, chainGeneration: claimed.chainGeneration, recovery };
    });
  }

  /** SHORT tx closing a failed flight. Only a matching fence may write. */
  async function markReauthorize(id: string, fence: { revision: number; chainGeneration: number }) {
    return db.transaction(async tx => {
      await tx.execute(credentialLock(id));
      const [row] = await tx.select().from(table).where(eq(table.id, id));
      if (!row || row.status === "revoked") return false;
      if (row.revision !== fence.revision || row.chainGeneration !== fence.chainGeneration) return false;
      await tx.update(table).set({ status: "reauthorize", rotationStartedAt: null, revision: row.revision + 1, updatedAt: new Date() }).where(eq(table.id, id));
      return true;
    });
  }

  type PhaseC =
    | { kind: "persisted"; token: string }
    /** Chain moved on mid-flight; `revoked` distinguishes forget from a re-paste. */
    | { kind: "discarded"; token: string; revoked: boolean }
    | { kind: "revoked" };

  /**
   * SHORT tx. Runs immediately after the provider call. `revision` is
   * deliberately not required to match (latest success wins); `chain_generation`
   * is, as the fence against a newer paste or a forget.
   */
  async function phaseC(id: string, claim: { chainGeneration: number }, rotated: Rotated): Promise<PhaseC> {
    return db.transaction(async tx => {
      await tx.execute(credentialLock(id));
      const [row] = await tx.select().from(table).where(eq(table.id, id));
      if (!row) return { kind: "discarded" as const, token: rotated.token, revoked: false };
      if (row.chainGeneration !== claim.chainGeneration) {
        return { kind: "discarded" as const, token: rotated.token, revoked: row.status === "revoked" };
      }
      // A revoked row must never be resurrected.
      if (row.status === "revoked") return { kind: "revoked" as const };
      await tx.update(table).set({
        status: "active",
        accessMaterial: encryptInstanceSecretValue(rotated.token) as unknown as Record<string, unknown>,
        refreshMaterial: encryptInstanceSecretValue(rotated.refreshToken) as unknown as Record<string, unknown>,
        accessExpiresAt: rotated.expiresAt,
        lastRotatedAt: new Date(),
        rotationStartedAt: null,
        revision: row.revision + 1,
        updatedAt: new Date(),
      }).where(eq(table.id, id));
      return { kind: "persisted" as const, token: rotated.token };
    });
  }

  const tokenRequests = new Map<string, Promise<string>>();

  /**
   * Returns a usable configuration access token, rotating only when it is within
   * the margin of expiry. Concurrent requests from different companies share one
   * flight, so one chain rotates once.
   */
  async function accessToken(id: string, audit: InstanceCredentialAudit): Promise<string> {
    const running = tokenRequests.get(id);
    if (running) return running;
    const operation = (async () => {
      const deadline = Date.now() + deps.timeoutMs;
      let claim: Extract<PhaseA, { kind: "claimed" }>;
      for (;;) {
        const phase = await phaseA(id);
        if (phase.kind === "cached") return phase.token;
        if (phase.kind === "claimed") { claim = phase; break; }
        if (Date.now() + deps.pollMs > deadline) throw providerFailure("slack_configuration_refresh_busy");
        // A live flight elsewhere owns the claim; wait for it to land.
        await sleep(deps.pollMs);
      }
      const workspaceId = claim.row.workspaceId;

      let rotated: Rotated;
      try {
        rotated = await rotate(claim.refreshToken);
      } catch (error) {
        const code = object(object(error).details).code;
        if (code === "slack_configuration_refresh_invalid" || code === "slack_configuration_token_invalid") {
          // Proven rejection: the stored token is dead and no replacement exists.
          if (await markReauthorize(id, claim)) {
            await audit("configuration_token_rotation_failed", workspaceId, { code: "slack_configuration_refresh_invalid" });
          }
          throw providerFailure("slack_configuration_refresh_invalid");
        }
        // Ambiguous (timeout / 5xx / transport / rate limit): the token may still
        // be valid, so leave `rotating` to go stale and be recovered.
        throw providerFailure("slack_configuration_refresh_uncertain");
      }

      if (rotated.teamId !== workspaceId || rotated.userId !== claim.row.slackUserId) {
        if (await markReauthorize(id, claim)) {
          await audit("configuration_token_rotation_failed", workspaceId, { code: "slack_configuration_credential_mismatch" });
        }
        throw providerFailure("slack_configuration_credential_mismatch");
      }

      let result: PhaseC;
      try {
        result = await withWriteRetry(() => phaseC(id, claim, rotated));
      } catch (error) {
        // The new pair is lost; the row stays `rotating` so the loss is visible
        // and recoverable rather than silently serving a dead token later.
        logger.error({ credentialId: id, workspaceId, err: error instanceof Error ? error.message : "unknown" }, "Slack instance configuration token rotation could not be saved");
        await audit("configuration_token_rotation_uncertain", workspaceId);
        throw providerFailure("slack_configuration_refresh_uncertain");
      }
      // A re-paste or forget happened mid-flight; the newer intent wins.
      if (result.kind === "discarded") await audit("configuration_token_rotation_discarded", workspaceId);
      if (result.kind === "revoked" || result.kind === "discarded" && result.revoked) {
        throw providerFailure("slack_configuration_refresh_required");
      }
      if (result.kind === "persisted") await audit("configuration_token_rotated", workspaceId, { recovery: claim.recovery });
      // Even a discarded pair can serve this one request unless the row is revoked.
      return result.token;
    })();
    tokenRequests.set(id, operation);
    try { return await operation; } finally { if (tokenRequests.get(id) === operation) tokenRequests.delete(id); }
  }

  return { has, list, save, forget, accessToken };
}

export type InstanceSlackConfigurationCredentials = ReturnType<typeof createInstanceSlackConfigurationCredentials>;

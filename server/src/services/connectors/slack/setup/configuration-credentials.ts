import { and, eq, inArray, sql } from "drizzle-orm";
import { chatSlackConfigurationCredentials, companySecrets } from "@paperclipai/db";
import type { SlackConfigurationCredential } from "@paperclipai/shared";
import { forbidden } from "../../../../errors.js";
import { logger } from "../../../../middleware/logger.js";
import { accessService } from "../../../access.js";
import { logActivity } from "../../../activity-log.js";
import { instanceSettingsService } from "../../../instance-settings.js";
import { secretService } from "../../../secrets.js";
import * as connectionCredentials from "../../../connection-credentials.js";
import { object, providerFailure, type SlackSetupActor, type SlackRegistrationStore } from "./registration.js";

/**
 * TECH-7981 (RH-only): saved Slack app-configuration refresh tokens.
 *
 * Slack's `tooling.tokens.rotate` refresh token is SINGLE-USE, so every
 * rotation both consumes the stored token and returns the only valid
 * replacement. Losing that response loses the chain, and two concurrent
 * rotations of the same token cannot both succeed -- one of them burns the
 * token the other is about to store.
 *
 * The protocol below is therefore deliberately three-phase:
 *
 *   A. a SHORT transaction takes a per-credential advisory lock, decides, and
 *      commits a durable `rotating` claim (with `revision`/`chain_generation`
 *      recorded) plus the token it is about to spend.
 *   B. the HTTP call runs with NO transaction and NO lock held.
 *   C. a second SHORT transaction persists the replacement, fenced by
 *      `chain_generation`: a newer paste or a `forget` during the flight wins,
 *      and the pair we just received is discarded.
 *
 * A `rotating` claim older than 60s (well past the 20s provider timeout) is a
 * crash, not a live flight, so it is reclaimed via `recovery = true`: the
 * stored refresh token was never overwritten, so retrying is the only way the
 * chain survives.
 *
 * This intentionally diverges from upstream, whose docs say not to supply a
 * refresh token. Keeping the logic in this file keeps upstream catch-ups small.
 */
const ACCESS_MARGIN_MS = 15 * 60_000;
const ROTATING_STALE_MS = 60_000;
const BUSY_POLL_MS = 500;
const BUSY_TIMEOUT_MS = 30_000;
const WRITE_RETRY_DELAYS_MS = [250, 1_000, 3_000];

export type SlackConfigurationCredentialTiming = {
  /** Poll cadence while another flight holds the claim. */
  pollMs?: number;
  /** How long a caller waits for another flight before reporting busy. */
  timeoutMs?: number;
  /** Backoff between durable-write attempts after the provider call. */
  retryDelaysMs?: readonly number[];
};

type Rotated = { token: string; refreshToken: string; expiresAt: Date; teamId: string; userId: string };
type CredentialRow = typeof chatSlackConfigurationCredentials.$inferSelect;
type Database = Parameters<typeof secretService>[0];
type Tx = Parameters<Parameters<SlackRegistrationStore["db"]["transaction"]>[0]>[0];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createSlackConfigurationCredentials(store: SlackRegistrationStore, timing: SlackConfigurationCredentialTiming = {}) {
  const { db, options, api } = store;
  const pollMs = timing.pollMs ?? BUSY_POLL_MS;
  const timeoutMs = timing.timeoutMs ?? BUSY_TIMEOUT_MS;
  const retryDelays = timing.retryDelaysMs ?? WRITE_RETRY_DELAYS_MS;
  const secretConsumer = (id: string) => `slack-configuration-credential:${id}`;

  async function access(companyId: string, actor: SlackSetupActor, database: Database = db) {
    if (!(await instanceSettingsService(database as typeof db).getExperimental()).enableChatConnectors) throw forbidden("Chat connectors are disabled");
    if (!actor.bypassPermissionCheck && !await accessService(database as typeof db).hasPermission(companyId, "user", actor.userId, "tools:manage_connections")) throw forbidden("Missing permission: tools:manage_connections");
  }

  /**
   * Ownership is checked on EVERY use, including for instance administrators:
   * `bypassPermissionCheck` bypasses the company permission, never the fact
   * that this credential holds someone else's Slack token.
   */
  async function readOwned(database: Database, id: string, companyId: string, actor: SlackSetupActor) {
    const [row] = await database.select().from(chatSlackConfigurationCredentials)
      .where(and(eq(chatSlackConfigurationCredentials.id, id), eq(chatSlackConfigurationCredentials.companyId, companyId)));
    if (!row || row.userId !== actor.userId) {
      throw forbidden("This saved Slack token belongs to another Paperclip account. Use your own token.", { code: "slack_configuration_credential_forbidden" });
    }
    return row;
  }

  async function secret(row: CredentialRow, secretId: string | null, database: Database = db) {
    if (!secretId) throw providerFailure("slack_configuration_refresh_required");
    const [ref] = await database.select().from(companySecrets).where(and(
      eq(companySecrets.id, secretId),
      eq(companySecrets.companyId, row.companyId),
      eq(companySecrets.scope, "user"),
      eq(companySecrets.ownerUserId, row.userId),
    ));
    if (!ref?.userSecretDefinitionId) throw providerFailure("slack_configuration_refresh_required");
    // Owner-scoped system consumer; the durable credential row is its authority.
    const resolved = await secretService(database).resolveUserSecretValue(row.companyId, {
      definitionId: ref.userSecretDefinitionId, responsibleUserId: row.userId,
    }, { consumerType: "system", consumerId: secretConsumer(row.id), actorType: "user", actorId: row.userId, responsibleUserId: row.userId });
    if (!resolved?.value) throw providerFailure("slack_configuration_refresh_required");
    return resolved.value;
  }

  async function write(tx: Tx, row: CredentialRow, key: "access_token" | "refresh_token", value: string, existingId: string | null) {
    const configPath = `slack_configuration.${key}`;
    return connectionCredentials.writeConnectionCredential(tx, {
      companyId: row.companyId, ownerUserId: row.userId, actor: { userId: row.userId },
      connectionName: "Slack configuration token", configPath,
      definitionKey: `slack_configuration.${row.id}.${key}`, label: key, value,
      ...(existingId ? { existingRef: { secretId: existingId, configPath } } : {}),
    });
  }

  function summary(row: CredentialRow): SlackConfigurationCredential {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      slackUserId: row.slackUserId,
      // A live rotation is still usable; only a proven rejection needs a re-paste.
      status: row.status === "active" || row.status === "rotating" ? "active" : "reauthorize",
      lastRotatedAt: row.lastRotatedAt ? row.lastRotatedAt.toISOString() : null,
    };
  }

  /**
   * The provider call. No bearer: `tooling.tokens.rotate` is authorized by the
   * refresh token itself and requires no scopes. The response must never be
   * logged or audited -- it contains the whole new chain.
   */
  async function rotate(refreshToken: string): Promise<Rotated> {
    const result = await api("tooling.tokens.rotate", { refresh_token: refreshToken });
    const token = result.token;
    const nextRefreshToken = result.refresh_token;
    const exp = result.exp;
    const teamId = result.team_id;
    const userId = result.user_id;
    const expiresAt = typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000) : null;
    if (typeof token !== "string" || !token.startsWith("xoxe.xoxp-")
      || typeof nextRefreshToken !== "string" || !nextRefreshToken.startsWith("xoxe-")
      || !expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()
      || typeof teamId !== "string" || !/^T/.test(teamId)
      || typeof userId !== "string" || !/^[UW]/.test(userId)) {
      throw providerFailure("slack_provider_failure");
    }
    return { token, refreshToken: nextRefreshToken, expiresAt, teamId, userId };
  }

  /** Re-throw a provider-call failure in the three categories `save` reports. */
  function rethrowSaveFailure(error: unknown): never {
    const code = object(object(error).details).code;
    if (code === "slack_configuration_refresh_invalid" || code === "slack_setup_rate_limited" || code === "slack_provider_failure") throw error;
    throw providerFailure("slack_provider_failure");
  }

  /** Retry a short write transaction; the pair being written is memory-only. */
  async function withWriteRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= retryDelays.length) throw error;
        await sleep(retryDelays[attempt]!);
      }
    }
  }

  async function save(companyId: string, actor: SlackSetupActor, refreshToken: string): Promise<SlackConfigurationCredential> {
    await access(companyId, actor);
    // Rotate on save: the pasted value is spent, so the stored token is the
    // only valid one and re-pasting the same value fails by design.
    let rotated: Rotated;
    try {
      rotated = await rotate(refreshToken);
    } catch (error) {
      rethrowSaveFailure(error);
    }
    let saved: CredentialRow;
    try {
      saved = await withWriteRetry(() => db.transaction(async tx => {
        // Lock order is always owner -> credential. Every other path (phase A,
        // phase C, markReauthorize, forget) takes only the credential lock, so
        // this ordering can never invert.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-config-credential-owner:${companyId}:${actor.userId}:${rotated.teamId}`}, 0))`);
        const [existing] = await tx.select({ id: chatSlackConfigurationCredentials.id }).from(chatSlackConfigurationCredentials).where(and(
          eq(chatSlackConfigurationCredentials.companyId, companyId),
          eq(chatSlackConfigurationCredentials.userId, actor.userId),
          eq(chatSlackConfigurationCredentials.workspaceId, rotated.teamId),
        ));
        // Replacing an existing chain must serialize with an in-flight phase C
        // and with forget BEFORE the row or its secrets change: phase C then
        // reads the bumped generation and discards its pair, and forget acts
        // on the state this save commits. A brand-new row has no id anyone
        // else can hold yet; the owner lock already serializes its creation.
        if (existing) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-config-credential:${existing.id}`}, 0))`);
        // A paste is fresh consent: a different Slack user in the same workspace is overwritten.
        // The upsert reads the row after both locks are held.
        const [row] = await tx.insert(chatSlackConfigurationCredentials).values({
          companyId, userId: actor.userId, slackUserId: rotated.userId, workspaceId: rotated.teamId,
          status: "active", accessExpiresAt: rotated.expiresAt, lastRotatedAt: new Date(), rotationStartedAt: null,
          // Column defaults (revision 0, chain_generation 0) are the creation
          // state; a re-paste is what bumps the generation fence.
        }).onConflictDoUpdate({
          target: [chatSlackConfigurationCredentials.companyId, chatSlackConfigurationCredentials.userId, chatSlackConfigurationCredentials.workspaceId],
          set: {
            slackUserId: sql`excluded.slack_user_id`,
            status: "active",
            accessExpiresAt: sql`excluded.access_expires_at`,
            lastRotatedAt: sql`excluded.last_rotated_at`,
            rotationStartedAt: null,
            revision: sql`${chatSlackConfigurationCredentials.revision} + 1`,
            chainGeneration: sql`${chatSlackConfigurationCredentials.chainGeneration} + 1`,
            updatedAt: new Date(),
          },
        }).returning();
        if (!row) throw new Error("Slack configuration credential was not saved");
        const accessToken = await write(tx, row, "access_token", rotated.token, row.accessSecretId);
        const refresh = await write(tx, row, "refresh_token", rotated.refreshToken, row.refreshSecretId);
        const [updated] = await tx.update(chatSlackConfigurationCredentials)
          .set({ accessSecretId: accessToken.secret.id, refreshSecretId: refresh.secret.id, updatedAt: new Date() })
          .where(eq(chatSlackConfigurationCredentials.id, row.id)).returning();
        return updated ?? row;
      }));
    } catch (error) {
      // Never include the pair or the provider response in the log.
      logger.error({ companyId, credentialWorkspaceId: rotated.teamId, err: error instanceof Error ? error.message : "unknown" }, "Slack configuration credential could not be saved");
      throw providerFailure("slack_configuration_refresh_uncertain");
    }
    try {
      await logActivity(db, { companyId, actorType: "user", actorId: actor.userId,
        action: "chat_slack.configuration_credential_saved", entityType: "slack_configuration_credential", entityId: saved.id,
        details: { workspaceId: saved.workspaceId } });
    } catch (error) {
      logger.warn({ companyId, credentialId: saved.id, err: error instanceof Error ? error.message : "unknown" }, "Slack configuration credential save activity could not be recorded");
    }
    return summary(saved);
  }

  async function forget(id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor);
    const row = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-config-credential:${id}`}, 0))`);
      const current = await readOwned(tx, id, companyId, actor);
      await tx.update(chatSlackConfigurationCredentials).set({
        status: "revoked", accessSecretId: null, refreshSecretId: null,
        chainGeneration: current.chainGeneration + 1, revision: current.revision + 1, updatedAt: new Date(),
      }).where(eq(chatSlackConfigurationCredentials.id, id));
      // This only makes Paperclip forget the chain; revoking it is a Slack action.
      for (const secretId of [current.accessSecretId, current.refreshSecretId]) {
        if (secretId) await secretService(tx).remove(secretId);
      }
      return current;
    });
    try {
      await logActivity(db, { companyId, actorType: "user", actorId: actor.userId,
        action: "chat_slack.configuration_credential_forgotten", entityType: "slack_configuration_credential", entityId: id,
        details: { workspaceId: row.workspaceId } });
    } catch (error) {
      logger.warn({ companyId, credentialId: id, err: error instanceof Error ? error.message : "unknown" }, "Slack configuration credential forget activity could not be recorded");
    }
  }

  async function list(companyId: string, actor: SlackSetupActor): Promise<SlackConfigurationCredential[]> {
    await access(companyId, actor);
    const rows = await db.select().from(chatSlackConfigurationCredentials).where(and(
      eq(chatSlackConfigurationCredentials.companyId, companyId),
      eq(chatSlackConfigurationCredentials.userId, actor.userId),
      inArray(chatSlackConfigurationCredentials.status, ["active", "rotating", "reauthorize"]),
    )).orderBy(chatSlackConfigurationCredentials.workspaceId);
    return rows.map(summary);
  }

  type PhaseA =
    | { kind: "cached"; row: CredentialRow; token: string }
    | { kind: "busy" }
    | { kind: "claimed"; row: CredentialRow; refreshToken: string; revision: number; chainGeneration: number; recovery: boolean };

  /**
   * SHORT tx1. Decides whether this request needs a rotation and, if so,
   * durably claims it before the provider is contacted. Nothing here waits on
   * the provider or on the endpoint lease.
   */
  async function phaseA(id: string, companyId: string, actor: SlackSetupActor): Promise<PhaseA> {
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-config-credential:${id}`}, 0))`);
      const row = await readOwned(tx, id, companyId, actor);
      if (row.status === "revoked") throw providerFailure("slack_configuration_refresh_required");
      if (row.status === "reauthorize") throw providerFailure("slack_configuration_refresh_invalid");
      if (row.status === "active" && row.accessExpiresAt && row.accessExpiresAt.getTime() > Date.now() + ACCESS_MARGIN_MS) {
        return { kind: "cached", row, token: await secret(row, row.accessSecretId, tx) };
      }
      if (row.status === "rotating" && !row.rotationStartedAt) throw providerFailure("slack_configuration_refresh_uncertain");
      if (row.status === "rotating" && row.rotationStartedAt!.getTime() > Date.now() - ROTATING_STALE_MS) return { kind: "busy" };
      // Stale `rotating` (crash or lost response): the stored refresh token was
      // never overwritten, so reclaiming is the only way the chain survives.
      const recovery = row.status === "rotating";
      const [claimed] = await tx.update(chatSlackConfigurationCredentials).set({
        status: "rotating", rotationStartedAt: new Date(), revision: row.revision + 1, updatedAt: new Date(),
      }).where(eq(chatSlackConfigurationCredentials.id, id)).returning();
      if (!claimed) throw providerFailure("slack_configuration_refresh_required");
      return { kind: "claimed", row: claimed, refreshToken: await secret(row, row.refreshSecretId, tx),
        revision: claimed.revision, chainGeneration: claimed.chainGeneration, recovery };
    });
  }

  /**
   * SHORT tx closing a failed flight. Only a matching fence may write, so a
   * concurrent winner or a newer paste is never overwritten.
   */
  async function markReauthorize(id: string, companyId: string, actor: SlackSetupActor, fence: { revision: number; chainGeneration: number }) {
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-config-credential:${id}`}, 0))`);
      const [row] = await tx.select().from(chatSlackConfigurationCredentials).where(and(
        eq(chatSlackConfigurationCredentials.id, id), eq(chatSlackConfigurationCredentials.companyId, companyId),
      ));
      if (!row || row.userId !== actor.userId || row.status === "revoked") return false;
      if (row.revision !== fence.revision || row.chainGeneration !== fence.chainGeneration) return false;
      await tx.update(chatSlackConfigurationCredentials).set({ status: "reauthorize", revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(chatSlackConfigurationCredentials.id, id));
      return true;
    });
  }

  async function activity(companyId: string, actorId: string, id: string, workspaceId: string, action: string, details: Record<string, unknown> = {}) {
    try {
      await logActivity(db, { companyId, actorType: "user", actorId,
        action: `chat_slack.${action}`, entityType: "slack_configuration_credential", entityId: id,
        details: { workspaceId, ...details } });
    } catch (error) {
      logger.warn({ companyId, credentialId: id, err: error instanceof Error ? error.message : "unknown" }, `Slack configuration ${action} activity could not be recorded`);
    }
  }

  type PhaseC =
    | { kind: "persisted"; token: string; row: CredentialRow }
    /** Chain moved on mid-flight; `revoked` distinguishes forget from a re-paste. */
    | { kind: "discarded"; token: string; revoked: boolean }
    | { kind: "revoked" };

  /**
   * SHORT tx2. Runs immediately after the provider call, with no awaits in
   * between. `revision` is deliberately not required to match: a successful
   * rotation always holds the current chain head, so "latest success wins"
   * heals a concurrent recovery attempt. `chain_generation` IS required --
   * that is the fence against a newer user intent.
   */
  async function phaseC(id: string, companyId: string, actor: SlackSetupActor, claim: { chainGeneration: number }, rotated: Rotated): Promise<PhaseC> {
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-config-credential:${id}`}, 0))`);
      const [row] = await tx.select().from(chatSlackConfigurationCredentials).where(and(
        eq(chatSlackConfigurationCredentials.id, id), eq(chatSlackConfigurationCredentials.companyId, companyId),
      ));
      if (!row || row.userId !== actor.userId) return { kind: "discarded" as const, token: rotated.token, revoked: false };
      // A newer paste or forget wins. Checked first, so a forget is reported as
      // a discard (its cause) even though it also revoked the row.
      if (row.chainGeneration !== claim.chainGeneration) {
        return { kind: "discarded" as const, token: rotated.token, revoked: row.status === "revoked" };
      }
      // `forget` without a generation change cannot happen through this module,
      // but a revoked row must never be resurrected either way.
      if (row.status === "revoked") return { kind: "revoked" as const };
      const accessToken = await write(tx, row, "access_token", rotated.token, row.accessSecretId);
      const refresh = await write(tx, row, "refresh_token", rotated.refreshToken, row.refreshSecretId);
      const [updated] = await tx.update(chatSlackConfigurationCredentials).set({
        status: "active",
        accessSecretId: accessToken.secret.id,
        refreshSecretId: refresh.secret.id,
        accessExpiresAt: rotated.expiresAt,
        lastRotatedAt: new Date(),
        rotationStartedAt: null,
        revision: row.revision + 1,
        updatedAt: new Date(),
      }).where(eq(chatSlackConfigurationCredentials.id, id)).returning();
      return { kind: "persisted" as const, token: rotated.token, row: updated ?? row };
    });
  }

  const tokenRequests = new Map<string, Promise<string>>();
  const tokenKey = (companyId: string, actor: SlackSetupActor, id: string) => `${companyId}:${actor.userId}:${id}`;

  /**
   * Returns a usable configuration access token, rotating only when it is
   * within 15 minutes of expiry. The margin covers validate + create + update
   * + avatar render + icon upload, each with a 20s timeout.
   */
  async function accessToken(credentialId: string, companyId: string, actor: SlackSetupActor): Promise<string> {
    await access(companyId, actor);
    const key = tokenKey(companyId, actor, credentialId);
    const running = tokenRequests.get(key);
    if (running) return running;
    const operation = (async () => {
      const deadline = Date.now() + timeoutMs;
      let claim: Extract<PhaseA, { kind: "claimed" }>;
      for (;;) {
        const phase = await phaseA(credentialId, companyId, actor);
        if (phase.kind === "cached") return phase.token;
        if (phase.kind === "claimed") { claim = phase; break; }
        if (Date.now() + pollMs > deadline) throw providerFailure("slack_configuration_refresh_busy");
        // A live flight elsewhere owns the claim; wait for it to land.
        await sleep(pollMs);
      }

      let rotated: Rotated;
      try {
        rotated = await rotate(claim.refreshToken);
      } catch (error) {
        const code = object(object(error).details).code;
        if (code === "slack_configuration_refresh_invalid") {
          // Proven rejection: the stored token is dead and no replacement exists.
          if (await markReauthorize(credentialId, companyId, actor, claim)) {
            await activity(companyId, actor.userId, credentialId, claim.row.workspaceId, "configuration_token_rotation_failed", { code });
          }
          throw providerFailure("slack_configuration_refresh_invalid");
        }
        // Ambiguous (timeout / 5xx / transport / rate limit): the token may
        // still be valid, so leave `rotating` to go stale and be recovered.
        throw providerFailure("slack_configuration_refresh_uncertain");
      }

      if (rotated.teamId !== claim.row.workspaceId || rotated.userId !== claim.row.slackUserId) {
        if (await markReauthorize(credentialId, companyId, actor, claim)) {
          await activity(companyId, actor.userId, credentialId, claim.row.workspaceId, "configuration_token_rotation_failed", { code: "slack_configuration_credential_mismatch" });
        }
        throw providerFailure("slack_configuration_credential_mismatch");
      }

      let result: PhaseC;
      try {
        result = await withWriteRetry(() => phaseC(credentialId, companyId, actor, claim, rotated));
      } catch (error) {
        // The new pair is lost; the row stays `rotating` so the loss is visible
        // and recoverable rather than silently serving a dead token later.
        logger.error({ companyId, credentialId, workspaceId: claim.row.workspaceId, err: error instanceof Error ? error.message : "unknown" }, "Slack configuration token rotation could not be saved");
        await activity(companyId, actor.userId, credentialId, claim.row.workspaceId, "configuration_token_rotation_uncertain");
        throw providerFailure("slack_configuration_refresh_uncertain");
      }
      // A re-paste or forget happened mid-flight; the user's newer intent wins.
      if (result.kind === "discarded") {
        await activity(companyId, actor.userId, credentialId, claim.row.workspaceId, "configuration_token_rotation_discarded");
      }
      if (result.kind === "revoked" || result.kind === "discarded" && result.revoked) {
        throw providerFailure("slack_configuration_refresh_required");
      }
      if (result.kind === "persisted") {
        await activity(companyId, actor.userId, credentialId, claim.row.workspaceId, "configuration_token_rotated", { recovery: claim.recovery });
      }
      // Even a discarded pair can serve this one request unless the row is revoked.
      return result.token;
    })();
    tokenRequests.set(key, operation);
    try { return await operation; } finally { if (tokenRequests.get(key) === operation) tokenRequests.delete(key); }
  }

  return { list, save, forget, accessToken };
}

export type SlackConfigurationCredentials = ReturnType<typeof createSlackConfigurationCredentials>;

import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import {
  COMMS_WAKE_BATCH_LIMIT,
  COMMS_WAKE_STATUS_LIMIT,
  CommsWakeConfirmationError,
  enrolCommsWakeAgents,
  listCommsWakeStatus,
  rotateCommsWakeSecret,
  unsubscribeCommsWakeAgent,
  type CommsWakeAdminContext,
} from "../services/comms-wake-admin.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Operator routes for comms-board wake registrations of existing agents (TECH-9914). Instance admin only (the same bar as the
 * org setting `commsBoardWakeEnabled`) and company-scoped: the company in the path must be one the caller can reach, and every
 * agent is looked up inside it. Responses carry ids, states and reasons, never a secret.
 */
export function commsWakeAdminRoutes(db: Db, ctx: CommsWakeAdminContext = {}) {
  const router = Router();

  function authorize(req: Request, companyId: string) {
    assertInstanceAdmin(req);
    assertCompanyAccess(req, companyId);
  }
  function uuidParam(value: unknown, name: string): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw badRequest(`${name} must be a UUID`);
    return value;
  }
  function pageParams(source: Record<string, unknown>, max: number) {
    let limit: number | undefined;
    if (source.limit !== undefined) {
      limit = typeof source.limit === "number" ? source.limit : Number(source.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > max) throw badRequest(`limit must be an integer between 1 and ${max}`);
    }
    return { limit, afterId: source.afterId === undefined ? undefined : uuidParam(source.afterId, "afterId") };
  }

  router.get("/companies/:companyId/comms-wake/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    authorize(req, companyId);
    res.json(await listCommsWakeStatus(db, { companyId, ...pageParams(req.query, COMMS_WAKE_STATUS_LIMIT) }));
  });

  // Enrols one existing agent (`agentId`) or a batch of the company's agents. Dry run by default; a real run needs
  // `dryRun: false` and the confirmation string. Follow `nextCursor` (as `afterId`) to cover a larger org.
  router.post("/companies/:companyId/comms-wake/enrol", async (req, res) => {
    const companyId = req.params.companyId as string;
    authorize(req, companyId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw badRequest("dryRun must be a boolean");
    if (body.confirm !== undefined && typeof body.confirm !== "string") throw badRequest("confirm must be a string");
    const agentId = body.agentId === undefined ? undefined : uuidParam(body.agentId, "agentId");
    try {
      res.json(
        await enrolCommsWakeAgents(
          db,
          { companyId, agentId, dryRun: body.dryRun !== false, confirm: body.confirm as string | undefined, ...pageParams(body, COMMS_WAKE_BATCH_LIMIT) },
          ctx,
        ),
      );
    } catch (err) {
      if (err instanceof CommsWakeConfirmationError) throw badRequest("A real run requires dryRun=false and the confirmation string");
      throw err;
    }
  });

  // Board address, registration and signing secret of one agent. 502 when the board could not remove the address: nothing
  // was changed in that case, so the call can be repeated.
  router.post("/companies/:companyId/comms-wake/agents/:agentId/unsubscribe", async (req, res) => {
    const companyId = req.params.companyId as string;
    authorize(req, companyId);
    const report = await unsubscribeCommsWakeAgent(
      db,
      { companyId, agentId: uuidParam(req.params.agentId, "agentId"), actorUserId: req.actor.userId ?? null },
      ctx,
    );
    const status = report.result === "board_remove_failed" ? 502 : report.result === "board_not_configured" ? 503 : 200;
    res.status(status).json(report);
  });

  // New signing secret version AND the board, in one step. Anything but `rotated` leaves the old secret in force.
  router.post("/companies/:companyId/comms-wake/agents/:agentId/rotate-secret", async (req, res) => {
    const companyId = req.params.companyId as string;
    authorize(req, companyId);
    const report = await rotateCommsWakeSecret(
      db,
      { companyId, agentId: uuidParam(req.params.agentId, "agentId"), actorUserId: req.actor.userId ?? null },
      ctx,
    );
    const status =
      report.result === "rotated" ? 200
      : report.result === "board_failed" || report.result === "vault_failed" ? 502
      : report.result === "board_not_configured" || report.result === "public_base_url_unavailable" ? 503
      : 409;
    res.status(status).json(report);
  });

  return router;
}

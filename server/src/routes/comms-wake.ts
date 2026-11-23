import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { unsupportedMediaType } from "../errors.js";
import { commsWakeService } from "../services/comms-wake.js";
import type { CommsWakeHeartbeat } from "../services/comms-wake-issue.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

/**
 * Public ingress for comms board wake events. There is no session or key: the
 * Standard Webhooks signature over the raw body is the only credential, and the
 * service verifies it before anything in the body is trusted or stored.
 */
export function commsWakeRoutes(db: Db, options: { pluginWorkerManager?: PluginWorkerManager; heartbeat?: CommsWakeHeartbeat } = {}) {
  const router = Router();
  const heartbeat =
    options.heartbeat ?? (heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager }) as unknown as CommsWakeHeartbeat);
  const svc = commsWakeService(db, { heartbeat });

  router.post("/comms-board/wake/:agentId", async (req, res) => {
    if (!req.is("application/json")) {
      throw unsupportedMediaType("Send the wake event with Content-Type: application/json");
    }
    const result = await svc.receive({
      agentId: req.params.agentId as string,
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      body: req.body,
      webhookId: req.header("webhook-id"),
      webhookTimestamp: req.header("webhook-timestamp"),
      webhookSignature: req.header("webhook-signature"),
    });
    res.status(result.status === "retry_later" ? 409 : 200).json(result);
  });

  return router;
}

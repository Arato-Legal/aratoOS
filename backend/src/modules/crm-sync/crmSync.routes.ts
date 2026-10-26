// HTTP layer for the crm-sync module. Two routers:
//
//   crmWebhookRouter  /webhooks/crm/:token   called by the outside system; the
//                                            bearer secret is the credential
//   crmSyncRouter     /crm-sync              signed-in admins managing endpoints

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { resolveWorkspaceFilter, sendWorkspaceFailure } from "../../lib/workspace";
import {
  createEndpoint,
  deleteEndpoint,
  listEndpointEvents,
  listEndpoints,
  receivePush,
  rotateEndpointSecret,
  updateEndpoint,
} from "./crmSync.service";

export const crmWebhookRouter = Router();

function bearerSecret(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match ? match[1] : null;
}

crmWebhookRouter.post(
  "/:token",
  asyncRoute(async (req, res) => {
    const result = await receivePush(createServerSupabase(), {
      token: req.params.token,
      secret: bearerSecret(req.header("authorization")),
      body: req.body,
    });
    if (!result.ok && result.kind === "forbidden") {
      res.setHeader("WWW-Authenticate", "Bearer");
      return void res.status(401).json({ detail: "Unauthorized" });
    }
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

crmWebhookRouter.use(routerErrorHandler("[crm-webhook]"));

export const crmSyncRouter = Router();

const userId = (res: { locals: Record<string, unknown> }) => res.locals.userId as string;

crmSyncRouter.get(
  "/endpoints",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const ws = await resolveWorkspaceFilter(db, userId(res), req.query.workspace);
    if (!ws.ok) return void sendWorkspaceFailure(res, ws);
    const result = await listEndpoints(db, { userId: userId(res), workspace: ws.workspace });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "no-store");
    res.json(result.data);
  }),
);

crmSyncRouter.post(
  "/endpoints",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const ws = await resolveWorkspaceFilter(db, userId(res), req.query.workspace);
    if (!ws.ok) return void sendWorkspaceFailure(res, ws);
    const result = await createEndpoint(db, {
      userId: userId(res),
      workspace: ws.workspace,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(result.data);
  }),
);

crmSyncRouter.patch(
  "/endpoints/:endpointId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await updateEndpoint(createServerSupabase(), {
      userId: userId(res),
      endpointId: req.params.endpointId,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

crmSyncRouter.post(
  "/endpoints/:endpointId/rotate-secret",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await rotateEndpointSecret(createServerSupabase(), {
      userId: userId(res),
      endpointId: req.params.endpointId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "no-store");
    res.json(result.data);
  }),
);

crmSyncRouter.get(
  "/endpoints/:endpointId/events",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await listEndpointEvents(createServerSupabase(), {
      userId: userId(res),
      endpointId: req.params.endpointId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

crmSyncRouter.delete(
  "/endpoints/:endpointId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await deleteEndpoint(createServerSupabase(), {
      userId: userId(res),
      endpointId: req.params.endpointId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(204).send();
  }),
);

crmSyncRouter.use(routerErrorHandler("[crm-sync]"));

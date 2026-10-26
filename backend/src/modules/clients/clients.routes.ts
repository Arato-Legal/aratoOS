// HTTP layer for the clients module: parses the request, calls
// clients.service, and maps ServiceResults onto status codes and JSON.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
  resolveWorkspaceFilter,
  sendWorkspaceFailure,
} from "../../lib/workspace";
import {
  addContact,
  browseDriveFolders,
  createClient,
  deleteClient,
  deleteContact,
  getClient,
  getMatterDashboard,
  getMatterWorkspace,
  linkMatterDriveFolder,
  listClients,
  setProjectClient,
  updateClient,
  updateContact,
} from "./clients.service";

export const clientsRouter = Router();

const caller = (res: { locals: Record<string, unknown> }) => ({
  userId: res.locals.userId as string,
  userEmail: res.locals.userEmail as string | undefined,
});

clientsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const { userId } = caller(res);
    const workspace = await resolveWorkspaceFilter(db, userId, req.query.workspace);
    if (!workspace.ok) return void sendWorkspaceFailure(res, workspace);
    const result = await listClients(db, {
      userId,
      workspace: workspace.workspace,
      status: req.query.status,
      search: req.query.q,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

clientsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const { userId } = caller(res);
    const workspace = await resolveWorkspaceFilter(db, userId, req.query.workspace);
    if (!workspace.ok) return void sendWorkspaceFailure(res, workspace);
    const result = await createClient(db, {
      userId,
      workspace: workspace.workspace,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(201).json(result.data);
  }),
);

clientsRouter.get(
  "/drive/folders",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const { userId } = caller(res);
    const workspace = await resolveWorkspaceFilter(db, userId, req.query.workspace);
    if (!workspace.ok) return void sendWorkspaceFailure(res, workspace);
    const result = await browseDriveFolders(db, {
      userId,
      workspace: workspace.workspace,
      parentId: req.query.parent,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

clientsRouter.get(
  "/matters/:projectId/workspace",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await getMatterWorkspace(createServerSupabase(), {
      ...caller(res),
      projectId: req.params.projectId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "no-store");
    res.json(result.data);
  }),
);

clientsRouter.put(
  "/matters/:projectId/drive-folder",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await linkMatterDriveFolder(createServerSupabase(), {
      ...caller(res),
      projectId: req.params.projectId,
      folderId: req.body?.folder_id ?? null,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

// Attach (or, with client_id null, detach) a matter. Mounted ahead of
// "/:clientId" so "matters" is never read as a client id.
clientsRouter.put(
  "/matters/:projectId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const clientId = req.body?.client_id;
    if (clientId !== null && typeof clientId !== "string")
      return void res
        .status(400)
        .json({ detail: "client_id must be a client id or null" });
    const result = await setProjectClient(createServerSupabase(), {
      ...caller(res),
      projectId: req.params.projectId,
      clientId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

clientsRouter.get(
  "/matters/:projectId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await getMatterDashboard(createServerSupabase(), {
      ...caller(res),
      projectId: req.params.projectId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

clientsRouter.get(
  "/:clientId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await getClient(createServerSupabase(), {
      ...caller(res),
      clientId: req.params.clientId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

clientsRouter.patch(
  "/:clientId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await updateClient(createServerSupabase(), {
      userId: caller(res).userId,
      clientId: req.params.clientId,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

clientsRouter.delete(
  "/:clientId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await deleteClient(createServerSupabase(), {
      userId: caller(res).userId,
      clientId: req.params.clientId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(204).send();
  }),
);

clientsRouter.post(
  "/:clientId/contacts",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await addContact(createServerSupabase(), {
      userId: caller(res).userId,
      clientId: req.params.clientId,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(201).json(result.data);
  }),
);

clientsRouter.patch(
  "/:clientId/contacts/:contactId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await updateContact(createServerSupabase(), {
      userId: caller(res).userId,
      clientId: req.params.clientId,
      contactId: req.params.contactId,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

clientsRouter.delete(
  "/:clientId/contacts/:contactId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await deleteContact(createServerSupabase(), {
      userId: caller(res).userId,
      clientId: req.params.clientId,
      contactId: req.params.contactId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(204).send();
  }),
);

clientsRouter.use(routerErrorHandler("[clients]"));

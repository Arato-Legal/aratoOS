// HTTP layer for the intake module. Two routers:
//
//   intakePublicRouter  /intake/:token       no sign-in; a prospect's form page
//   intakeFormsRouter   /intake-forms        signed-in workspace members
//
// Handlers parse the request, call intake.service and map its ServiceResults
// onto status codes and JSON.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { resolveWorkspaceFilter, sendWorkspaceFailure } from "../../lib/workspace";
import {
  approveSubmission,
  createForm,
  deleteForm,
  getPublicForm,
  listForms,
  listSubmissions,
  rejectSubmission,
  submitPublicForm,
  updateForm,
} from "./intake.service";

export const intakePublicRouter = Router();

intakePublicRouter.get(
  "/:token",
  asyncRoute(async (req, res) => {
    const result = await getPublicForm(createServerSupabase(), req.params.token);
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "no-store");
    res.json(result.data);
  }),
);

intakePublicRouter.post(
  "/:token",
  asyncRoute(async (req, res) => {
    const result = await submitPublicForm(createServerSupabase(), {
      token: req.params.token,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(201).json(result.data);
  }),
);

intakePublicRouter.use(routerErrorHandler("[intake-public]"));

export const intakeFormsRouter = Router();

const userId = (res: { locals: Record<string, unknown> }) => res.locals.userId as string;

intakeFormsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const ws = await resolveWorkspaceFilter(db, userId(res), req.query.workspace);
    if (!ws.ok) return void sendWorkspaceFailure(res, ws);
    const result = await listForms(db, { userId: userId(res), workspace: ws.workspace });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

intakeFormsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const ws = await resolveWorkspaceFilter(db, userId(res), req.query.workspace);
    if (!ws.ok) return void sendWorkspaceFailure(res, ws);
    const result = await createForm(db, {
      userId: userId(res),
      workspace: ws.workspace,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(201).json(result.data);
  }),
);

// Mounted ahead of "/:formId" so "submissions" is never read as a form id.
intakeFormsRouter.get(
  "/submissions",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const ws = await resolveWorkspaceFilter(db, userId(res), req.query.workspace);
    if (!ws.ok) return void sendWorkspaceFailure(res, ws);
    const result = await listSubmissions(db, {
      userId: userId(res),
      workspace: ws.workspace,
      status: req.query.status,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

intakeFormsRouter.post(
  "/submissions/:submissionId/approve",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await approveSubmission(createServerSupabase(), {
      userId: userId(res),
      submissionId: req.params.submissionId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

intakeFormsRouter.post(
  "/submissions/:submissionId/reject",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await rejectSubmission(createServerSupabase(), {
      userId: userId(res),
      submissionId: req.params.submissionId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

intakeFormsRouter.patch(
  "/:formId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await updateForm(createServerSupabase(), {
      userId: userId(res),
      formId: req.params.formId,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

intakeFormsRouter.delete(
  "/:formId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await deleteForm(createServerSupabase(), {
      userId: userId(res),
      formId: req.params.formId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(204).send();
  }),
);

intakeFormsRouter.use(routerErrorHandler("[intake-forms]"));

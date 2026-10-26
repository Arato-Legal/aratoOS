// Business logic + data access for the intake module.
//
// An intake form is a public, token-addressed page that collects a prospect's
// basic details. Submissions wait in a queue until somebody in the form's
// workspace approves one (which creates a lead client) or rejects it. The
// public functions (`getPublicForm`, `submitPublicForm`) take no caller and
// reveal only what the form page needs; every other function is scoped to a
// workspace member the same way clients are: a personal form belongs to its
// creator, an organization form to every current member.

import { getOrgRole } from "../../lib/access";
import { teamOrgIdOf } from "../../lib/personalOrgs";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { isUuid } from "../../lib/uuid";
import { PERSONAL_WORKSPACE, type WorkspaceFilter } from "../../lib/workspace";
import { createClient, type ClientRow } from "../clients/clients.service";

export type IntakeFormRow = {
  id: string;
  user_id: string | null;
  org_id: string | null;
  name: string;
  title: string;
  description: string | null;
  token: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type SubmissionStatus = "pending" | "approved" | "rejected";

export type SubmissionRow = {
  id: string;
  form_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  status: SubmissionStatus;
  client_id: string | null;
  reviewed_at: string | null;
  created_at: string;
};

const FORM_COLUMNS =
  "id, user_id, org_id, name, title, description, token, enabled, created_at, updated_at";
const SUBMISSION_COLUMNS =
  "id, form_id, name, email, phone, message, status, client_id, reviewed_at, created_at";

const TOKEN_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A form that is flooded stops accepting until the queue is worked.
export const MAX_PENDING_PER_FORM = 500;
const MAX_MESSAGE = 5000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(
  body: Record<string, unknown>,
  key: string,
  max: number,
): { ok: true; value: string | null | undefined } | { ok: false; detail: string } {
  const raw = body[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, detail: `${key} must be a string` };
  const trimmed = raw.trim();
  if (trimmed.length > max)
    return { ok: false, detail: `${key} must be at most ${max} characters` };
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

// ---------------------------------------------------------------------------
// Public side
// ---------------------------------------------------------------------------

export type PublicForm = { title: string; description: string | null };

async function loadEnabledFormByToken(
  db: Db,
  token: string,
): Promise<ServiceResult<IntakeFormRow>> {
  // A token that cannot exist is never queried; disabled and unknown forms
  // answer identically so a token reveals nothing it does not already grant.
  if (!TOKEN_RE.test(token)) return failure("not_found", "Form not found");
  const { data, error } = await db
    .from("intake_forms")
    .select(FORM_COLUMNS)
    .eq("token", token)
    .eq("enabled", true)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Form not found");
  return ok(data as IntakeFormRow);
}

export async function getPublicForm(
  db: Db,
  token: string,
): Promise<ServiceResult<PublicForm>> {
  const form = await loadEnabledFormByToken(db, token);
  if (!form.ok) return form;
  return ok({ title: form.data.title, description: form.data.description });
}

export async function submitPublicForm(
  db: Db,
  args: { token: string; body: unknown },
): Promise<ServiceResult<{ received: true }>> {
  const body = asRecord(args.body);
  const form = await loadEnabledFormByToken(db, args.token);
  if (!form.ok) return form;

  // The `website` field is hidden from people. A bot that fills it is told it
  // worked and nothing is stored.
  if (typeof body.website === "string" && body.website.trim() !== "")
    return ok({ received: true });

  if (typeof body.name !== "string" || !body.name.trim())
    return failure("validation", "Please enter your name.");
  if (body.name.trim().length > 300)
    return failure("validation", "Name is too long.");
  const email = text(body, "email", 320);
  const phone = text(body, "phone", 100);
  const message = text(body, "message", MAX_MESSAGE);
  for (const field of [email, phone, message])
    if (!field.ok) return failure("validation", field.detail);
  if (!email.ok || !phone.ok || !message.ok) return failure("validation", "Invalid input");
  if (!email.value && !phone.value)
    return failure("validation", "Please enter an email address or a phone number.");
  if (email.value && !EMAIL_RE.test(email.value))
    return failure("validation", "Please enter a valid email address.");

  const { count, error: countError } = await db
    .from("form_submissions")
    .select("id", { count: "exact", head: true })
    .eq("form_id", form.data.id)
    .eq("status", "pending");
  if (countError) return internalFailure(countError);
  if ((count ?? 0) >= MAX_PENDING_PER_FORM)
    return failure("unavailable", "This form is not accepting submissions right now.");

  const { error } = await db.from("form_submissions").insert({
    form_id: form.data.id,
    name: body.name.trim(),
    email: email.value ?? null,
    phone: phone.value ?? null,
    message: message.value ?? null,
  });
  if (error) return internalFailure(error);
  return ok({ received: true });
}

// ---------------------------------------------------------------------------
// Workspace side
// ---------------------------------------------------------------------------

// A form the caller may not reach is indistinguishable from a missing one.
async function canReach(db: Db, form: IntakeFormRow, userId: string): Promise<boolean> {
  if (!form.org_id) return form.user_id === userId;
  return (await getOrgRole(userId, form.org_id, db)) !== null;
}

async function loadForm(
  db: Db,
  formId: string,
  userId: string,
): Promise<ServiceResult<IntakeFormRow>> {
  if (!isUuid(formId)) return failure("not_found", "Form not found");
  const { data, error } = await db
    .from("intake_forms")
    .select(FORM_COLUMNS)
    .eq("id", formId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data || !(await canReach(db, data as IntakeFormRow, userId)))
    return failure("not_found", "Form not found");
  return ok(data as IntakeFormRow);
}

async function reachableOrgIds(db: Db, userId: string): Promise<ServiceResult<string[]>> {
  const { data, error } = await db
    .from("org_members")
    .select("org_id, organizations!inner(id)")
    .is("organizations.deleted_at", null)
    .eq("user_id", userId);
  if (error) return internalFailure(error);
  return ok((data ?? []).map((r: { org_id: string }) => r.org_id));
}

function scopeFilter(userId: string, workspace: WorkspaceFilter, orgIds: string[]): string | null {
  const scopes: string[] = [];
  if (!workspace || workspace === PERSONAL_WORKSPACE)
    scopes.push(`and(org_id.is.null,user_id.eq.${userId})`);
  if (workspace && workspace !== PERSONAL_WORKSPACE) scopes.push(`org_id.eq.${workspace}`);
  if (!workspace && orgIds.length) scopes.push(`org_id.in.(${orgIds.join(",")})`);
  return scopes.length ? scopes.join(",") : null;
}

export async function listForms(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter },
): Promise<ServiceResult<IntakeFormRow[]>> {
  let orgIds: string[] = [];
  if (!args.workspace) {
    const orgs = await reachableOrgIds(db, args.userId);
    if (!orgs.ok) return orgs;
    orgIds = orgs.data;
  }
  const filter = scopeFilter(args.userId, args.workspace, orgIds);
  if (!filter) return ok([]);
  const { data, error } = await db
    .from("intake_forms")
    .select(FORM_COLUMNS)
    .or(filter)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return internalFailure(error);
  return ok((data ?? []) as IntakeFormRow[]);
}

function parseFormFields(
  body: Record<string, unknown>,
  requireText: boolean,
): { ok: true; value: Record<string, unknown> } | { ok: false; detail: string } {
  const out: Record<string, unknown> = {};
  for (const [key, max] of [
    ["name", 200],
    ["title", 200],
  ] as const) {
    if (body[key] === undefined && !requireText) continue;
    if (typeof body[key] !== "string" || !(body[key] as string).trim())
      return { ok: false, detail: `${key} is required` };
    if ((body[key] as string).trim().length > max)
      return { ok: false, detail: `${key} must be at most ${max} characters` };
    out[key] = (body[key] as string).trim();
  }
  const description = text(body, "description", 2000);
  if (!description.ok) return description;
  if (description.value !== undefined) out.description = description.value;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean")
      return { ok: false, detail: "enabled must be true or false" };
    out.enabled = body.enabled;
  }
  return { ok: true, value: out };
}

export async function createForm(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter; body: unknown },
): Promise<ServiceResult<IntakeFormRow>> {
  const parsed = parseFormFields(asRecord(args.body), true);
  if (!parsed.ok) return failure("validation", parsed.detail);
  let orgId: string | null = null;
  if (args.workspace && args.workspace !== PERSONAL_WORKSPACE) {
    orgId = await teamOrgIdOf(db, args.workspace);
    if (!orgId || !(await getOrgRole(args.userId, orgId, db)))
      return failure("not_found", "Workspace not found", "workspace_not_found");
  }
  const { data, error } = await db
    .from("intake_forms")
    .insert({ ...parsed.value, user_id: args.userId, org_id: orgId })
    .select(FORM_COLUMNS)
    .single();
  if (error) return internalFailure(error);
  return ok(data as IntakeFormRow);
}

export async function updateForm(
  db: Db,
  args: { userId: string; formId: string; body: unknown },
): Promise<ServiceResult<IntakeFormRow>> {
  const parsed = parseFormFields(asRecord(args.body), false);
  if (!parsed.ok) return failure("validation", parsed.detail);
  if (Object.keys(parsed.value).length === 0)
    return failure("validation", "No fields to update");
  const form = await loadForm(db, args.formId, args.userId);
  if (!form.ok) return form;
  const { data, error } = await db
    .from("intake_forms")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", form.data.id)
    .select(FORM_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Form not found");
  return ok(data as IntakeFormRow);
}

export async function deleteForm(
  db: Db,
  args: { userId: string; formId: string },
): Promise<ServiceResult<null>> {
  const form = await loadForm(db, args.formId, args.userId);
  if (!form.ok) return form;
  const { error } = await db.from("intake_forms").delete().eq("id", form.data.id);
  if (error) return internalFailure(error);
  return ok(null);
}

export type SubmissionWithForm = SubmissionRow & { form_name: string };

export async function listSubmissions(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter; status?: unknown },
): Promise<ServiceResult<SubmissionWithForm[]>> {
  const status = args.status === undefined || args.status === "" ? "pending" : args.status;
  if (!["pending", "approved", "rejected", "all"].includes(status as string))
    return failure("validation", "status must be pending, approved, rejected or all");
  const forms = await listForms(db, { userId: args.userId, workspace: args.workspace });
  if (!forms.ok) return forms;
  if (forms.data.length === 0) return ok([]);
  const names = new Map(forms.data.map((f) => [f.id, f.name]));
  let query = db
    .from("form_submissions")
    .select(SUBMISSION_COLUMNS)
    .in("form_id", [...names.keys()]);
  if (status !== "all") query = query.eq("status", status as string);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return internalFailure(error);
  return ok(
    ((data ?? []) as SubmissionRow[]).map((s) => ({
      ...s,
      form_name: names.get(s.form_id) ?? "",
    })),
  );
}

async function loadSubmission(
  db: Db,
  submissionId: string,
  userId: string,
): Promise<ServiceResult<{ submission: SubmissionRow; form: IntakeFormRow }>> {
  if (!isUuid(submissionId)) return failure("not_found", "Submission not found");
  const { data, error } = await db
    .from("form_submissions")
    .select(SUBMISSION_COLUMNS)
    .eq("id", submissionId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Submission not found");
  const submission = data as SubmissionRow;
  const form = await loadForm(db, submission.form_id, userId);
  if (!form.ok) return failure("not_found", "Submission not found");
  return ok({ submission, form: form.data });
}

// Move a pending submission to `next`, once: the status guard makes a second
// concurrent approve or reject find nothing to claim.
async function claim(
  db: Db,
  submissionId: string,
  userId: string,
  next: "approved" | "rejected",
): Promise<ServiceResult<SubmissionRow>> {
  const { data, error } = await db
    .from("form_submissions")
    .update({ status: next, reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq("id", submissionId)
    .eq("status", "pending")
    .select(SUBMISSION_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("conflict", "This submission has already been reviewed.");
  return ok(data as SubmissionRow);
}

export async function rejectSubmission(
  db: Db,
  args: { userId: string; submissionId: string },
): Promise<ServiceResult<SubmissionRow>> {
  const loaded = await loadSubmission(db, args.submissionId, args.userId);
  if (!loaded.ok) return loaded;
  return claim(db, args.submissionId, args.userId, "rejected");
}

// Approve a submission: it becomes a lead client in the form's workspace.
export async function approveSubmission(
  db: Db,
  args: { userId: string; submissionId: string },
): Promise<ServiceResult<{ submission: SubmissionRow; client: ClientRow }>> {
  const loaded = await loadSubmission(db, args.submissionId, args.userId);
  if (!loaded.ok) return loaded;
  const { submission, form } = loaded.data;

  const claimed = await claim(db, submission.id, args.userId, "approved");
  if (!claimed.ok) return claimed;

  const created = await createClient(db, {
    userId: args.userId,
    workspace: form.org_id ?? PERSONAL_WORKSPACE,
    body: {
      name: submission.name,
      kind: "individual",
      status: "lead",
      email: submission.email,
      phone: submission.phone,
      source: `Intake: ${form.name}`.slice(0, 200),
      notes: submission.message,
    },
  });
  if (!created.ok) {
    // Put it back so the reviewer can try again.
    await db
      .from("form_submissions")
      .update({ status: "pending", reviewed_by: null, reviewed_at: null })
      .eq("id", submission.id);
    return created;
  }

  const { data, error } = await db
    .from("form_submissions")
    .update({ client_id: created.data.id })
    .eq("id", submission.id)
    .select(SUBMISSION_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  return ok({ submission: (data as SubmissionRow) ?? claimed.data, client: created.data });
}

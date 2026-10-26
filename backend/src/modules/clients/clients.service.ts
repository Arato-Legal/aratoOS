// Business logic + data access for the clients module.
//
// A client is the firm's system of record for basic client data; its matters
// are projects carrying `client_id`. Access rule: a personal client (no org)
// belongs to its creator; an organization client is open to every current
// member of that organization. Matters keep their own, stricter project
// access: a client page only lists the matters the caller may open.

import { checkProjectAccess, getOrgRole, isOrgAdmin } from "../../lib/access";
import { can } from "../../lib/permissions";
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

export const CLIENT_KINDS = ["individual", "organization"] as const;
export const CLIENT_STATUSES = ["lead", "active", "closed"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export type ClientRow = {
  id: string;
  user_id: string | null;
  org_id: string | null;
  name: string;
  kind: ClientKind;
  status: ClientStatus;
  email: string | null;
  phone: string | null;
  address: string | null;
  source: string | null;
  notes: string | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ClientContactRow = {
  id: string;
  client_id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ClientMatter = {
  id: string;
  name: string;
  cm_number: string | null;
  practice: string | null;
  updated_at: string;
};

export type ClientDetail = ClientRow & {
  contacts: ClientContactRow[];
  matters: ClientMatter[];
};

const CLIENT_COLUMNS =
  "id, user_id, org_id, name, kind, status, email, phone, address, source, notes, custom_fields, created_at, updated_at";
const CONTACT_COLUMNS =
  "id, client_id, name, role, email, phone, notes, created_at, updated_at";

const MAX_NAME = 300;
const MAX_FIELD = 2000;
const MAX_NOTES = 50_000;
const MAX_CUSTOM_FIELDS_BYTES = 20_000;
const MAX_MATTERS = 200;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

// `undefined` leaves a field alone; null or "" clears it.
function optionalText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): Parsed<string | null | undefined> {
  const raw = body[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string")
    return { ok: false, detail: `${key} must be a string` };
  const trimmed = raw.trim();
  if (trimmed.length > max)
    return { ok: false, detail: `${key} must be at most ${max} characters` };
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseFields(
  body: Record<string, unknown>,
  { requireName }: { requireName: boolean },
): Parsed<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  if (body.name !== undefined || requireName) {
    if (typeof body.name !== "string" || !body.name.trim())
      return { ok: false, detail: "name is required" };
    if (body.name.trim().length > MAX_NAME)
      return { ok: false, detail: `name must be at most ${MAX_NAME} characters` };
    out.name = body.name.trim();
  }

  if (body.kind !== undefined) {
    if (!(CLIENT_KINDS as readonly unknown[]).includes(body.kind))
      return { ok: false, detail: "kind must be 'individual' or 'organization'" };
    out.kind = body.kind;
  }
  if (body.status !== undefined) {
    if (!(CLIENT_STATUSES as readonly unknown[]).includes(body.status))
      return { ok: false, detail: "status must be 'lead', 'active' or 'closed'" };
    out.status = body.status;
  }

  for (const [key, max] of [
    ["email", 320],
    ["phone", 100],
    ["address", MAX_FIELD],
    ["source", 200],
    ["notes", MAX_NOTES],
  ] as const) {
    const parsed = optionalText(body, key, max);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) out[key] = parsed.value;
  }
  if (typeof out.email === "string" && !EMAIL_RE.test(out.email))
    return { ok: false, detail: "email is not a valid address" };

  if (body.custom_fields !== undefined) {
    if (
      !body.custom_fields ||
      typeof body.custom_fields !== "object" ||
      Array.isArray(body.custom_fields)
    )
      return { ok: false, detail: "custom_fields must be an object" };
    if (JSON.stringify(body.custom_fields).length > MAX_CUSTOM_FIELDS_BYTES)
      return { ok: false, detail: "custom_fields is too large" };
    out.custom_fields = body.custom_fields;
  }
  return { ok: true, value: out };
}

function parseContactFields(
  body: Record<string, unknown>,
  { requireName }: { requireName: boolean },
): Parsed<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined || requireName) {
    if (typeof body.name !== "string" || !body.name.trim())
      return { ok: false, detail: "name is required" };
    if (body.name.trim().length > MAX_NAME)
      return { ok: false, detail: `name must be at most ${MAX_NAME} characters` };
    out.name = body.name.trim();
  }
  for (const [key, max] of [
    ["role", 200],
    ["email", 320],
    ["phone", 100],
    ["notes", MAX_FIELD],
  ] as const) {
    const parsed = optionalText(body, key, max);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) out[key] = parsed.value;
  }
  if (typeof out.email === "string" && !EMAIL_RE.test(out.email))
    return { ok: false, detail: "email is not a valid address" };
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

type ClientAccess =
  | { ok: true; client: ClientRow; canDelete: boolean }
  | { ok: false };

// A client the caller may not reach is indistinguishable from a missing one.
async function loadClientAccess(
  db: Db,
  clientId: string,
  userId: string,
): Promise<ServiceResult<ClientAccess & { ok: true }> | { ok: false; notFound: true }> {
  if (!isUuid(clientId)) return { ok: false, notFound: true };
  const { data, error } = await db
    .from("clients")
    .select(CLIENT_COLUMNS)
    .eq("id", clientId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const client = data as ClientRow | null;
  if (!client) return { ok: false, notFound: true };
  if (!client.org_id) {
    if (client.user_id !== userId) return { ok: false, notFound: true };
    return ok({ ok: true, client, canDelete: true });
  }
  const role = await getOrgRole(userId, client.org_id, db);
  if (!role) return { ok: false, notFound: true };
  return ok({
    ok: true,
    client,
    canDelete: client.user_id === userId || isOrgAdmin(role),
  });
}

const NOT_FOUND = failure("not_found", "Client not found");

async function withClientAccess<T>(
  db: Db,
  clientId: string,
  userId: string,
  fn: (a: { client: ClientRow; canDelete: boolean }) => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
  const access = await loadClientAccess(db, clientId, userId);
  if ("notFound" in access) return NOT_FOUND;
  if (!access.ok) return access;
  return fn(access.data);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function listClients(
  db: Db,
  args: {
    userId: string;
    workspace: WorkspaceFilter;
    status?: unknown;
    search?: unknown;
  },
): Promise<ServiceResult<ClientRow[]>> {
  if (args.status !== undefined && args.status !== "") {
    if (!(CLIENT_STATUSES as readonly unknown[]).includes(args.status))
      return failure("validation", "status must be 'lead', 'active' or 'closed'");
  }

  let orgIds: string[] = [];
  if (args.workspace !== PERSONAL_WORKSPACE) {
    if (args.workspace) {
      orgIds = [args.workspace];
    } else {
      const { data, error } = await db
        .from("org_members")
        .select("org_id, organizations!inner(id)")
        .is("organizations.deleted_at", null)
        .eq("user_id", args.userId);
      if (error) return internalFailure(error);
      orgIds = (data ?? []).map((r: { org_id: string }) => r.org_id);
    }
  }
  const includePersonal = !args.workspace || args.workspace === PERSONAL_WORKSPACE;

  const scopes: string[] = [];
  if (includePersonal) scopes.push(`and(org_id.is.null,user_id.eq.${args.userId})`);
  if (orgIds.length) scopes.push(`org_id.in.(${orgIds.join(",")})`);
  if (scopes.length === 0) return ok([]);

  let query = db.from("clients").select(CLIENT_COLUMNS).or(scopes.join(","));
  if (typeof args.status === "string" && args.status)
    query = query.eq("status", args.status);
  if (typeof args.search === "string" && args.search.trim()) {
    const term = args.search.trim().replace(/[%,()*\\]/g, " ").slice(0, 100);
    if (term.trim())
      query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%`);
  }
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) return internalFailure(error);
  return ok((data ?? []) as ClientRow[]);
}

export async function createClient(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter; body: unknown },
): Promise<ServiceResult<ClientRow>> {
  const parsed = parseFields(asRecord(args.body), { requireName: true });
  if (!parsed.ok) return failure("validation", parsed.detail);

  // A personal workspace (or none named) files the client under the creator.
  let orgId: string | null = null;
  if (args.workspace && args.workspace !== PERSONAL_WORKSPACE) {
    orgId = await teamOrgIdOf(db, args.workspace);
    if (!orgId || !(await getOrgRole(args.userId, orgId, db)))
      return failure("not_found", "Workspace not found", "workspace_not_found");
  }

  const { data, error } = await db
    .from("clients")
    .insert({ ...parsed.value, user_id: args.userId, org_id: orgId })
    .select(CLIENT_COLUMNS)
    .single();
  if (error) return internalFailure(error);
  return ok(data as ClientRow);
}

async function loadMatters(
  db: Db,
  clientId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<ServiceResult<ClientMatter[]>> {
  const { data, error } = await db
    .from("projects")
    .select("id, name, cm_number, practice, updated_at")
    .eq("client_id", clientId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(MAX_MATTERS);
  if (error) return internalFailure(error);
  const rows = (data ?? []) as ClientMatter[];
  const visible = await Promise.all(
    rows.map(async (row) =>
      (await checkProjectAccess(row.id, userId, userEmail, db)).ok ? row : null,
    ),
  );
  return ok(visible.filter((r): r is ClientMatter => r !== null));
}

export async function getClient(
  db: Db,
  args: { userId: string; userEmail?: string | null; clientId: string },
): Promise<ServiceResult<ClientDetail & { can_delete: boolean }>> {
  return withClientAccess(db, args.clientId, args.userId, async ({ client, canDelete }) => {
    const [contacts, matters] = await Promise.all([
      db
        .from("client_contacts")
        .select(CONTACT_COLUMNS)
        .eq("client_id", client.id)
        .order("created_at", { ascending: true }),
      loadMatters(db, client.id, args.userId, args.userEmail),
    ]);
    if (contacts.error) return internalFailure(contacts.error);
    if (!matters.ok) return matters;
    return ok({
      ...client,
      contacts: (contacts.data ?? []) as ClientContactRow[],
      matters: matters.data,
      can_delete: canDelete,
    });
  });
}

export async function updateClient(
  db: Db,
  args: { userId: string; clientId: string; body: unknown },
): Promise<ServiceResult<ClientRow>> {
  const parsed = parseFields(asRecord(args.body), { requireName: false });
  if (!parsed.ok) return failure("validation", parsed.detail);
  if (Object.keys(parsed.value).length === 0)
    return failure("validation", "No fields to update");
  return withClientAccess(db, args.clientId, args.userId, async ({ client }) => {
    const { data, error } = await db
      .from("clients")
      .update({ ...parsed.value, updated_at: new Date().toISOString() })
      .eq("id", client.id)
      .select(CLIENT_COLUMNS)
      .maybeSingle();
    if (error) return internalFailure(error);
    if (!data) return NOT_FOUND;
    return ok(data as ClientRow);
  });
}

export async function deleteClient(
  db: Db,
  args: { userId: string; clientId: string },
): Promise<ServiceResult<null>> {
  return withClientAccess(db, args.clientId, args.userId, async ({ client, canDelete }) => {
    if (!canDelete)
      return failure("forbidden", "Only the client's creator or an organization admin can delete it.");
    // Matters stay; projects.client_id is ON DELETE SET NULL.
    const { error } = await db.from("clients").delete().eq("id", client.id);
    if (error) return internalFailure(error);
    return ok(null);
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function addContact(
  db: Db,
  args: { userId: string; clientId: string; body: unknown },
): Promise<ServiceResult<ClientContactRow>> {
  const parsed = parseContactFields(asRecord(args.body), { requireName: true });
  if (!parsed.ok) return failure("validation", parsed.detail);
  return withClientAccess(db, args.clientId, args.userId, async ({ client }) => {
    const { data, error } = await db
      .from("client_contacts")
      .insert({ ...parsed.value, client_id: client.id })
      .select(CONTACT_COLUMNS)
      .single();
    if (error) return internalFailure(error);
    return ok(data as ClientContactRow);
  });
}

export async function updateContact(
  db: Db,
  args: { userId: string; clientId: string; contactId: string; body: unknown },
): Promise<ServiceResult<ClientContactRow>> {
  if (!isUuid(args.contactId)) return failure("not_found", "Contact not found");
  const parsed = parseContactFields(asRecord(args.body), { requireName: false });
  if (!parsed.ok) return failure("validation", parsed.detail);
  if (Object.keys(parsed.value).length === 0)
    return failure("validation", "No fields to update");
  return withClientAccess(db, args.clientId, args.userId, async ({ client }) => {
    const { data, error } = await db
      .from("client_contacts")
      .update({ ...parsed.value, updated_at: new Date().toISOString() })
      .eq("id", args.contactId)
      .eq("client_id", client.id)
      .select(CONTACT_COLUMNS)
      .maybeSingle();
    if (error) return internalFailure(error);
    if (!data) return failure("not_found", "Contact not found");
    return ok(data as ClientContactRow);
  });
}

export async function deleteContact(
  db: Db,
  args: { userId: string; clientId: string; contactId: string },
): Promise<ServiceResult<null>> {
  if (!isUuid(args.contactId)) return failure("not_found", "Contact not found");
  return withClientAccess(db, args.clientId, args.userId, async ({ client }) => {
    const { data, error } = await db
      .from("client_contacts")
      .delete()
      .eq("id", args.contactId)
      .eq("client_id", client.id)
      .select("id");
    if (error) return internalFailure(error);
    if (!data || data.length === 0) return failure("not_found", "Contact not found");
    return ok(null);
  });
}

// ---------------------------------------------------------------------------
// Matter ↔ client link
// ---------------------------------------------------------------------------

// Attach a matter to a client, or detach it with a null clientId. The matter
// and the client must live in the same workspace, and the caller needs the
// project's settings right (owner) plus access to the client.
export async function setProjectClient(
  db: Db,
  args: {
    userId: string;
    userEmail?: string | null;
    projectId: string;
    clientId: string | null;
  },
): Promise<ServiceResult<{ project_id: string; client_id: string | null }>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Project not found");
  const access = await checkProjectAccess(
    args.projectId,
    args.userId,
    args.userEmail,
    db,
  );
  if (!access.ok) return failure("not_found", "Project not found");
  if (!can(access.projectRole, "access.manage"))
    return failure("forbidden", "Only a project owner can change its client.");

  const apply = async (): Promise<ServiceResult<{ project_id: string; client_id: string | null }>> => {
    const { error } = await db
      .from("projects")
      .update({ client_id: args.clientId, updated_at: new Date().toISOString() })
      .eq("id", args.projectId);
    if (error) return internalFailure(error);
    return ok({ project_id: args.projectId, client_id: args.clientId });
  };

  if (args.clientId === null) return apply();
  return withClientAccess(db, args.clientId, args.userId, async ({ client }) => {
    if ((client.org_id ?? null) !== (access.project.org_id ?? null))
      return failure(
        "validation",
        "The matter and the client must be in the same workspace.",
      );
    return apply();
  });
}

// ---------------------------------------------------------------------------
// Matter dashboard
// ---------------------------------------------------------------------------

export type MatterDashboard = {
  project: ClientMatter & { client_id: string | null; access_role: string };
  client: (ClientRow & { contacts: ClientContactRow[] }) | null;
};

// The data behind a matter's dashboard page. The matter is read with its own
// project access; its client is included only when the caller may open that
// client too, so linking a matter never widens who sees client details.
export async function getMatterDashboard(
  db: Db,
  args: { userId: string; userEmail?: string | null; projectId: string },
): Promise<ServiceResult<MatterDashboard>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Project not found");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Project not found");

  const { data, error } = await db
    .from("projects")
    .select("id, name, cm_number, practice, updated_at, client_id")
    .eq("id", args.projectId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Project not found");
  const project = {
    ...(data as ClientMatter & { client_id: string | null }),
    access_role: access.projectRole,
  };

  let client: MatterDashboard["client"] = null;
  if (project.client_id) {
    const clientAccess = await loadClientAccess(db, project.client_id, args.userId);
    if (!("notFound" in clientAccess)) {
      if (!clientAccess.ok) return clientAccess;
      const contacts = await db
        .from("client_contacts")
        .select(CONTACT_COLUMNS)
        .eq("client_id", project.client_id)
        .order("created_at", { ascending: true });
      if (contacts.error) return internalFailure(contacts.error);
      client = {
        ...clientAccess.data.client,
        contacts: (contacts.data ?? []) as ClientContactRow[],
      };
    }
  }
  return ok({ project, client });
}

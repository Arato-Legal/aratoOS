// Business logic + data access for the clients module.
//
// A client is the firm's system of record for basic client data; its matters
// are projects carrying `client_id`. Access rule: a personal client (no org)
// belongs to its creator; an organization client is open to every current
// member of that organization. Matters keep their own, stricter project
// access: a client page only lists the matters the caller may open.

import { deleteClientNotes } from "../../lib/memory/clientMemory";
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

import { hubfloLinks, type HubfloLinks } from "./clients.integrations";
import {
  CLIENT_COLUMNS,
  CLIENT_KINDS,
  CLIENT_STATUSES,
  CONTACT_COLUMNS,
  MAX_MATTERS,
  asRecord,
  parseContactFields,
  parseFields,
  type ClientContactRow,
  type ClientDetail,
  type ClientKind,
  type ClientMatter,
  type ClientRow,
  type ClientStatus,
} from "./clients.shared";

export {
  CLIENT_KINDS,
  CLIENT_STATUSES,
  type ClientContactRow,
  type ClientDetail,
  type ClientKind,
  type ClientMatter,
  type ClientRow,
  type ClientStatus,
};

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
  links: HubfloLinks,
): Promise<ServiceResult<ClientMatter[]>> {
  const { data, error } = await db
    .from("projects")
    .select("id, name, cm_number, practice, share_with_client, updated_at, external_source, external_id")
    .eq("client_id", clientId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(MAX_MATTERS);
  if (error) return internalFailure(error);
  const rows = (data ?? []) as (ClientMatter & {
    external_source?: string | null;
    external_id?: string | null;
  })[];
  const visible = await Promise.all(
    rows.map(async (row) =>
      (await checkProjectAccess(row.id, userId, userEmail, db)).ok ? row : null,
    ),
  );
  return ok(
    visible
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map(({ external_source, external_id, ...matter }) => ({
        ...matter,
        hubflo_url: links.link("matter", external_source, external_id),
      })),
  );
}

export async function getClient(
  db: Db,
  args: { userId: string; userEmail?: string | null; clientId: string },
): Promise<ServiceResult<ClientDetail & { can_delete: boolean }>> {
  return withClientAccess(db, args.clientId, args.userId, async ({ client, canDelete }) => {
    const links = await hubfloLinks(db, client.org_id);
    const [contacts, matters, ext] = await Promise.all([
      db
        .from("client_contacts")
        .select(`${CONTACT_COLUMNS}, external_id`)
        .eq("client_id", client.id)
        .order("created_at", { ascending: true }),
      loadMatters(db, client.id, args.userId, args.userEmail, links),
      db
        .from("clients")
        .select("external_source, external_id")
        .eq("id", client.id)
        .maybeSingle(),
    ]);
    if (contacts.error) return internalFailure(contacts.error);
    if (!matters.ok) return matters;
    const source = (ext.data as { external_source: string | null } | null)?.external_source;
    const extId = (ext.data as { external_id: string | null } | null)?.external_id;
    return ok({
      ...client,
      hubflo_url: links.link("client", source, extId),
      contacts: ((contacts.data ?? []) as (ClientContactRow & { external_id?: string | null })[]).map(
        ({ external_id, ...contact }) => ({
          ...contact,
          hubflo_url: links.link("contact", source, external_id),
        }),
      ),
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
  if (!isUuid(args.projectId)) return failure("not_found", "Matter not found");
  const access = await checkProjectAccess(
    args.projectId,
    args.userId,
    args.userEmail,
    db,
  );
  if (!access.ok) return failure("not_found", "Matter not found");
  if (!can(access.projectRole, "access.manage"))
    return failure("forbidden", "Only a matter owner can change its client.");

  const apply = async (): Promise<ServiceResult<{ project_id: string; client_id: string | null }>> => {
    // Moving a matter to another client (or off its client) takes what it
    // taught the old client's memory with it.
    const { data: before } = await db
      .from("projects")
      .select("client_id")
      .eq("id", args.projectId)
      .maybeSingle();
    const previous = (before as { client_id: string | null } | null)?.client_id ?? null;
    if (previous && previous !== args.clientId) {
      try {
        await deleteClientNotes(db, { projectId: args.projectId });
      } catch (error) {
        return internalFailure(error);
      }
    }
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
  project: ClientMatter & {
    client_id: string | null;
    org_id: string | null;
    access_role: string;
  };
  client: (ClientRow & { hubflo_url?: string | null; contacts: ClientContactRow[] }) | null;
};

// The data behind a matter's dashboard page. The matter is read with its own
// project access; its client is included only when the caller may open that
// client too, so linking a matter never widens who sees client details.
export async function getMatterDashboard(
  db: Db,
  args: { userId: string; userEmail?: string | null; projectId: string },
): Promise<ServiceResult<MatterDashboard>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Matter not found");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Matter not found");

  const { data, error } = await db
    .from("projects")
    .select(
      "id, name, cm_number, practice, share_with_client, updated_at, client_id, org_id, external_source, external_id",
    )
    .eq("id", args.projectId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Matter not found");
  const { external_source, external_id, ...row } = data as ClientMatter & {
    client_id: string | null;
    org_id: string | null;
    external_source: string | null;
    external_id: string | null;
  };
  const links = await hubfloLinks(db, row.org_id);
  const project = {
    ...row,
    hubflo_url: links.link("matter", external_source, external_id),
    access_role: access.projectRole,
  };

  let client: MatterDashboard["client"] = null;
  if (project.client_id) {
    const clientAccess = await loadClientAccess(db, project.client_id, args.userId);
    if (!("notFound" in clientAccess)) {
      if (!clientAccess.ok) return clientAccess;
      const [contacts, ext] = await Promise.all([
        db
          .from("client_contacts")
          .select(`${CONTACT_COLUMNS}, external_id`)
          .eq("client_id", project.client_id)
          .order("created_at", { ascending: true }),
        db
          .from("clients")
          .select("external_source, external_id")
          .eq("id", project.client_id)
          .maybeSingle(),
      ]);
      if (contacts.error) return internalFailure(contacts.error);
      const source = (ext.data as { external_source: string | null } | null)?.external_source;
      const extId = (ext.data as { external_id: string | null } | null)?.external_id;
      client = {
        ...clientAccess.data.client,
        hubflo_url: links.link("client", source, extId),
        contacts: ((contacts.data ?? []) as (ClientContactRow & { external_id?: string | null })[]).map(
          ({ external_id: contactExt, ...contact }) => ({
            ...contact,
            hubflo_url: links.link("contact", source, contactExt),
          }),
        ),
      };
    }
  }
  return ok({ project, client });
}

export {
  browseDriveFolders,
  getMatterWorkspace,
  linkMatterDriveFolder,
  type MatterWorkspace,
  type WorkspaceFile,
} from "./clients.drive";

export {
  getIntegrationSettings,
  updateIntegrationSettings,
  type IntegrationSettings,
} from "./clients.integrations";

export {
  createMatterDriveFolder,
  getClientFiles,
  listClientChats,
  setClientDriveFolder,
  setMatterSharing,
  type ClientChatSummary,
  type ClientFiles,
} from "./clients.sharing";

export {
  getDriveSyncStatus,
  openDriveFileForEditing,
  pullDocumentFromDrive,
  saveDocumentToDrive,
  type DriveSyncStatus,
} from "./clients.driveEdit";

export {
  upsertExternalClient,
  upsertExternalMatter,
  type SyncApplied,
  type SyncOutcome,
  type SyncScope,
} from "./clients.sync";

export {
  findDriveFilesForAssistant,
  getLibraryDriveSettings,
  listLibraryDriveFolder,
  parseLibraryDriveKind,
  setLibraryDriveFolder,
} from "./clients.libraryDrive";

// Client-level sharing and Drive folders.
//
// Each matter has a `share_with_client` switch. When on, the client's OTHER
// matters can read its data (documents, chats, tasks, tabular reviews),
// read-only, through a matter the reader can already open. A client also has a
// Drive folder; each matter's folder is a subfolder created inside it with the
// caller's own Google connection.

import { checkProjectAccess, getOrgRole } from "../../lib/access";
import { listSharedSiblingMatters } from "../../lib/clientSharing";
import { attachActiveVersionPaths } from "../../lib/documentVersions";
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
import type { ConnectorOwner } from "../../lib/connectorOwner";
import { GoogleDriveUserError } from "../../lib/integrations/googleDriveHttp";
import {
  WORK_IN_PROGRESS_FOLDER,
  createDriveFolder,
  getDriveFolder,
  isDriveId,
} from "../../lib/integrations/googleDrive";
import { getMatterWorkspace, type MatterWorkspace } from "./clients.drive";

const PER_KIND_LIMIT = 100;

export type SharedMatterFiles = {
  id: string;
  name: string;
  documents: { id: string; filename: string; updated_at: string }[];
  chats: { id: string; title: string | null; updated_at: string }[];
  tasks: { id: string; title: string; status: string; due_on: string | null }[];
  reviews: { id: string; title: string | null; updated_at: string }[];
};

export type ClientFiles = {
  shared_by_this_matter: boolean;
  matters: SharedMatterFiles[];
};

// Turn the sharing switch on or off. Turning it off removes the matter's data
// from its siblings immediately; nothing is copied, so nothing lingers.
export async function setMatterSharing(
  db: Db,
  args: {
    userId: string;
    userEmail?: string | null;
    projectId: string;
    share: unknown;
  },
): Promise<ServiceResult<{ project_id: string; share_with_client: boolean }>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Matter not found");
  if (typeof args.share !== "boolean")
    return failure("validation", "share_with_client must be true or false");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Matter not found");
  if (!can(access.projectRole, "access.manage"))
    return failure("forbidden", "Only a matter owner can change client sharing.");
  const { error } = await db
    .from("projects")
    .update({ share_with_client: args.share, updated_at: new Date().toISOString() })
    .eq("id", args.projectId);
  if (error) return internalFailure(error);
  return ok({ project_id: args.projectId, share_with_client: args.share });
}

// What the client's other matters share with this one. Needs only access to
// THIS matter; the shared matters' own pages stay closed to anyone who cannot
// open them.
export async function getClientFiles(
  db: Db,
  args: { userId: string; userEmail?: string | null; projectId: string },
): Promise<ServiceResult<ClientFiles>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Matter not found");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Matter not found");

  const { data: self, error: selfError } = await db
    .from("projects")
    .select("share_with_client")
    .eq("id", args.projectId)
    .maybeSingle();
  if (selfError) return internalFailure(selfError);

  const siblings = await listSharedSiblingMatters(db, args.projectId);
  const matters: SharedMatterFiles[] = [];
  for (const sibling of siblings) {
    const [docs, chats, tasks, reviews] = await Promise.all([
      db
        .from("documents")
        .select("id, current_version_id, updated_at")
        .eq("project_id", sibling.id)
        .eq("status", "ready")
        .eq("library_kind", "file")
        .order("updated_at", { ascending: false })
        .limit(PER_KIND_LIMIT),
      db
        .from("chats")
        .select("id, title, updated_at")
        .eq("project_id", sibling.id)
        .is("archived_at", null)
        .order("updated_at", { ascending: false })
        .limit(PER_KIND_LIMIT),
      db
        .from("project_tasks")
        .select("id, title, status, due_on")
        .eq("project_id", sibling.id)
        .order("created_at", { ascending: false })
        .limit(PER_KIND_LIMIT),
      db
        .from("tabular_reviews")
        .select("id, title, updated_at")
        .eq("project_id", sibling.id)
        .is("archived_at", null)
        .order("updated_at", { ascending: false })
        .limit(PER_KIND_LIMIT),
    ]);
    const failed = [docs, chats, tasks, reviews].find((r) => r.error);
    if (failed?.error) return internalFailure(failed.error);
    const docRows = (docs.data ?? []) as unknown as {
      id: string;
      current_version_id: string | null;
      filename?: string | null;
      updated_at: string;
    }[];
    await attachActiveVersionPaths(db, docRows);
    matters.push({
      id: sibling.id,
      name: sibling.name,
      documents: docRows.map((d) => ({
        id: d.id,
        filename: d.filename?.trim() || "Untitled document",
        updated_at: d.updated_at,
      })),
      chats: (chats.data ?? []) as SharedMatterFiles["chats"],
      tasks: (tasks.data ?? []) as SharedMatterFiles["tasks"],
      reviews: (reviews.data ?? []) as SharedMatterFiles["reviews"],
    });
  }
  return ok({
    shared_by_this_matter:
      (self as { share_with_client?: boolean } | null)?.share_with_client ?? true,
    matters,
  });
}

// ---------------------------------------------------------------------------
// Drive folders
// ---------------------------------------------------------------------------

async function ownerFor(db: Db, userId: string, orgId: string | null): Promise<ConnectorOwner> {
  return { userId, orgId: await teamOrgIdOf(db, orgId) };
}

type ClientDriveRow = {
  id: string;
  user_id: string | null;
  org_id: string | null;
  name: string;
  drive_folder_id: string | null;
  drive_folder_name: string | null;
};

// A personal client is its creator's; an organization client is open to its
// members (the same rule as the rest of the clients module).
async function loadOpenClient(
  db: Db,
  clientId: string,
  userId: string,
): Promise<ServiceResult<ClientDriveRow>> {
  if (!isUuid(clientId)) return failure("not_found", "Client not found");
  const { data, error } = await db
    .from("clients")
    .select("id, user_id, org_id, name, drive_folder_id, drive_folder_name")
    .eq("id", clientId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const row = data as ClientDriveRow | null;
  if (!row) return failure("not_found", "Client not found");
  const open = row.org_id
    ? !!(await getOrgRole(userId, row.org_id, db))
    : row.user_id === userId;
  return open ? ok(row) : failure("not_found", "Client not found");
}

function driveFailure(error: unknown): ServiceResult<never> {
  if (error instanceof GoogleDriveUserError)
    return failure("conflict", error.message, error.code ?? "google_drive_error");
  throw error;
}

// Link (or, with null, unlink) the client's Drive folder.
export async function setClientDriveFolder(
  db: Db,
  args: { userId: string; clientId: string; folderId: unknown },
): Promise<ServiceResult<{ client_id: string; drive_folder_id: string | null; drive_folder_name: string | null }>> {
  if (args.folderId !== null && !isDriveId(args.folderId))
    return failure("validation", "folder_id must be a Drive folder id or null");
  const client = await loadOpenClient(db, args.clientId, args.userId);
  if (!client.ok) return client;
  let name: string | null = null;
  if (args.folderId !== null) {
    try {
      const folder = await getDriveFolder(
        await ownerFor(db, args.userId, client.data.org_id),
        db,
        args.folderId,
      );
      if (!folder)
        return failure("validation", "That Google Drive folder was not found or cannot be opened.");
      name = folder.name;
    } catch (error) {
      return driveFailure(error);
    }
  }
  const { error } = await db
    .from("clients")
    .update({
      drive_folder_id: args.folderId,
      drive_folder_name: name,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.clientId);
  if (error) return internalFailure(error);
  return ok({ client_id: args.clientId, drive_folder_id: args.folderId, drive_folder_name: name });
}

// Create the matter's Drive folder (with its "Work in progress" subfolder)
// inside the client's folder, and link it. If the client has no folder yet,
// one is created first in the caller's My Drive. Refused when the matter is
// already linked, so a second click cannot leave a stray duplicate.
export async function createMatterDriveFolder(
  db: Db,
  args: { userId: string; userEmail?: string | null; projectId: string },
): Promise<ServiceResult<MatterWorkspace>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Matter not found");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Matter not found");
  if (!can(access.projectRole, "content.edit"))
    return failure("forbidden", "You need edit access to create a Drive folder.");

  const { data, error } = await db
    .from("projects")
    .select("id, name, cm_number, org_id, client_id, drive_folder_id")
    .eq("id", args.projectId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const project = data as {
    name: string;
    cm_number: string | null;
    org_id: string | null;
    client_id: string | null;
    drive_folder_id: string | null;
  } | null;
  if (!project) return failure("not_found", "Matter not found");
  if (project.drive_folder_id)
    return failure("conflict", "This matter already has a Drive folder.", "drive_folder_exists");
  if (!project.client_id)
    return failure("validation", "Attach the matter to a client first.", "client_required");

  const client = await loadOpenClient(db, project.client_id, args.userId);
  if (!client.ok) return failure("validation", "Attach the matter to a client you can open first.", "client_required");

  const owner = await ownerFor(db, args.userId, project.org_id);
  try {
    let clientFolderId = client.data.drive_folder_id;
    if (!clientFolderId) {
      const created = await createDriveFolder(owner, db, {
        name: client.data.name,
        parentId: "root",
      });
      clientFolderId = created.id;
      const { error: clientError } = await db
        .from("clients")
        .update({
          drive_folder_id: created.id,
          drive_folder_name: created.name,
          updated_at: new Date().toISOString(),
        })
        .eq("id", client.data.id);
      if (clientError) return internalFailure(clientError);
    }
    const label = project.cm_number ? `${project.cm_number} ${project.name}` : project.name;
    const matterFolder = await createDriveFolder(owner, db, {
      name: label,
      parentId: clientFolderId,
    });
    // Link first: if the subfolder fails, the matter folder is still recorded
    // and the Work in progress folder can be added by hand.
    const { error: linkError } = await db
      .from("projects")
      .update({
        drive_folder_id: matterFolder.id,
        drive_folder_name: matterFolder.name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.projectId);
    if (linkError) return internalFailure(linkError);
    await createDriveFolder(owner, db, {
      name: WORK_IN_PROGRESS_FOLDER,
      parentId: matterFolder.id,
    });
  } catch (error) {
    return driveFailure(error);
  }
  return getMatterWorkspace(db, args);
}

// The Drive folders shown as Library tabs: the folder that holds the firm's
// matter folders and the precedents/research folder. A team workspace's are
// set by an admin; a personal workspace's by its owner. Files are always read
// through the caller's Drive connection in that workspace (the shared
// connection when an admin made one), and only folders at or below the chosen
// root can be opened, so a crafted folder id reaches nothing else.

import { checkProjectAccess, getOrgRole, isOrgAdmin } from "../../lib/access";
import { checkClientAccess } from "../../lib/clientSharing";
import { teamOrgIdOf } from "../../lib/personalOrgs";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { PERSONAL_WORKSPACE, type WorkspaceFilter } from "../../lib/workspace";
import {
  driveFolderIsWithin,
  getDriveFolder,
  isDriveId,
  listDriveFolderChildren,
  searchDriveFiles,
} from "../../lib/integrations/googleDrive";
import { driveOwnerFor } from "./clients.integrations";
import {
  asDriveError,
  toWorkspaceFile,
  type DriveError,
  type WorkspaceFile,
} from "./clients.drive";

export type LibraryDriveKind = "matters" | "precedents";

export type LibraryDriveFolder = { id: string; name: string };

export type LibraryDriveSettings = {
  matters: LibraryDriveFolder | null;
  precedents: LibraryDriveFolder | null;
  /** Whether the caller may choose or clear the folders in this workspace. */
  can_configure: boolean;
};

export function parseLibraryDriveKind(value: unknown): LibraryDriveKind | null {
  return value === "matters" || value === "precedents" ? value : null;
}

type Scope = { orgId: string | null; userId: string };

async function resolveScope(
  db: Db,
  userId: string,
  workspace: WorkspaceFilter,
): Promise<ServiceResult<Scope & { canConfigure: boolean }>> {
  const orgId =
    workspace && workspace !== PERSONAL_WORKSPACE
      ? await teamOrgIdOf(db, workspace)
      : null;
  if (!orgId) return ok({ orgId: null, userId, canConfigure: true });
  const role = await getOrgRole(userId, orgId, db);
  if (!role) return failure("not_found", "Workspace not found", "workspace_not_found");
  return ok({ orgId, userId, canConfigure: isOrgAdmin(role) });
}

function owned(scope: Scope) {
  return scope.orgId
    ? { column: "org_id", value: scope.orgId }
    : { column: "user_id", value: scope.userId };
}

async function loadFolder(
  db: Db,
  scope: Scope,
  kind: LibraryDriveKind,
): Promise<LibraryDriveFolder | null> {
  const key = owned(scope);
  const { data } = await db
    .from("workspace_drive_folders")
    .select("drive_folder_id, drive_folder_name")
    .eq(key.column, key.value)
    .eq("kind", kind)
    .maybeSingle();
  const row = data as { drive_folder_id: string; drive_folder_name: string } | null;
  return row ? { id: row.drive_folder_id, name: row.drive_folder_name } : null;
}

export async function getLibraryDriveSettings(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter },
): Promise<ServiceResult<LibraryDriveSettings>> {
  const scope = await resolveScope(db, args.userId, args.workspace);
  if (!scope.ok) return scope;
  return ok({
    matters: await loadFolder(db, scope.data, "matters"),
    precedents: await loadFolder(db, scope.data, "precedents"),
    can_configure: scope.data.canConfigure,
  });
}

/** Choose (`folderId`) or clear (null) one Library Drive folder. */
export async function setLibraryDriveFolder(
  db: Db,
  args: {
    userId: string;
    workspace: WorkspaceFilter;
    kind: LibraryDriveKind;
    folderId: unknown;
  },
): Promise<ServiceResult<LibraryDriveSettings>> {
  const scope = await resolveScope(db, args.userId, args.workspace);
  if (!scope.ok) return scope;
  if (!scope.data.canConfigure)
    return failure("forbidden", "Only a workspace admin can change these folders.");
  const key = owned(scope.data);

  if (args.folderId === null) {
    const { error } = await db
      .from("workspace_drive_folders")
      .delete()
      .eq(key.column, key.value)
      .eq("kind", args.kind);
    if (error) return internalFailure(error);
  } else {
    if (!isDriveId(args.folderId))
      return failure("validation", "folder_id is not a valid Drive folder");
    const owner = await driveOwnerFor(db, args.userId, scope.data.orgId);
    let folder;
    try {
      folder = await getDriveFolder(owner, db, args.folderId);
    } catch (error) {
      const driveError = asDriveError(error);
      if (!driveError) throw error;
      return failure("validation", driveError.message, driveError.code);
    }
    if (!folder) return failure("validation", "That folder could not be found in Google Drive.");
    // Replace rather than upsert: the uniqueness is a partial index per owner
    // kind, which an ON CONFLICT target cannot name through the client.
    const cleared = await db
      .from("workspace_drive_folders")
      .delete()
      .eq(key.column, key.value)
      .eq("kind", args.kind);
    if (cleared.error) return internalFailure(cleared.error);
    const { error } = await db.from("workspace_drive_folders").insert({
      [key.column]: key.value,
      kind: args.kind,
      drive_folder_id: folder.id,
      drive_folder_name: folder.name.slice(0, 500),
    });
    if (error) return internalFailure(error);
  }
  return getLibraryDriveSettings(db, args);
}

export type LibraryDriveListing = {
  root: LibraryDriveFolder | null;
  folder: LibraryDriveFolder | null;
  files: WorkspaceFile[];
  drive_error: DriveError | null;
};

/** The files and folders inside one Library Drive folder (the root by default). */
export async function listLibraryDriveFolder(
  db: Db,
  args: {
    userId: string;
    workspace: WorkspaceFilter;
    kind: LibraryDriveKind;
    folderId?: unknown;
  },
): Promise<ServiceResult<LibraryDriveListing>> {
  const scope = await resolveScope(db, args.userId, args.workspace);
  if (!scope.ok) return scope;
  const root = await loadFolder(db, scope.data, args.kind);
  const empty = { root, folder: null, files: [], drive_error: null };
  if (!root) return ok(empty);
  const wanted =
    args.folderId === undefined || args.folderId === "" ? root.id : args.folderId;
  if (!isDriveId(wanted)) return failure("validation", "folder is not a valid Drive folder");

  const owner = await driveOwnerFor(db, args.userId, scope.data.orgId);
  try {
    if (wanted !== root.id && !(await driveFolderIsWithin(owner, db, wanted, root.id)))
      return failure("not_found", "Folder not found");
    const folder =
      wanted === root.id ? root : await getDriveFolder(owner, db, wanted);
    if (!folder) return failure("not_found", "Folder not found");
    const items = await listDriveFolderChildren(owner, db, { parentId: wanted });
    return ok({
      root,
      folder: { id: folder.id, name: folder.name },
      files: items.map(toWorkspaceFile),
      drive_error: null,
    });
  } catch (error) {
    const driveError = asDriveError(error);
    if (!driveError) throw error;
    return ok({ ...empty, drive_error: driveError });
  }
}

export type DriveFileHit = {
  file_id: string;
  name: string;
  kind: "google_doc" | "word";
  modified: string | null;
  link: string | null;
};

export type DriveFileSearchScope = "matter" | "precedents" | "drive";

/**
 * Find importable Drive files (Word, Google Docs) by description for the
 * assistant, in the matter's (or client's) folder, the workspace precedents
 * folder, or all of Drive. Folder scopes only ever search below a folder the
 * caller can already open, through the caller's workspace connection.
 */
export async function findDriveFilesForAssistant(
  db: Db,
  args: {
    userId: string;
    userEmail?: string | null;
    workspace: WorkspaceFilter;
    projectId?: string | null;
    clientId?: string | null;
    scope: DriveFileSearchScope;
    query: string;
    limit?: number;
  },
): Promise<ServiceResult<{ searched: string; files: DriveFileHit[]; drive_error: DriveError | null }>> {
  const scope = await resolveScope(db, args.userId, args.workspace);
  if (!scope.ok) return scope;

  let rootFolderId: string | undefined;
  let searched = "all of Google Drive";
  let orgId = scope.data.orgId;
  if (args.scope === "precedents") {
    const folder = await loadFolder(db, scope.data, "precedents");
    if (!folder)
      return failure("validation", "No precedents folder is set for this workspace.", "no_precedents_folder");
    rootFolderId = folder.id;
    searched = `the precedents folder "${folder.name}"`;
  } else if (args.scope === "matter") {
    let folderId: string | null = null;
    let name = "";
    if (args.projectId) {
      const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
      if (!access.ok) return failure("not_found", "Matter not found");
      const { data } = await db
        .from("projects")
        .select("org_id, drive_folder_id, drive_folder_name")
        .eq("id", args.projectId)
        .maybeSingle();
      const row = data as { org_id: string | null; drive_folder_id: string | null; drive_folder_name: string | null } | null;
      folderId = row?.drive_folder_id ?? null;
      name = row?.drive_folder_name ?? "matter folder";
      orgId = row?.org_id ?? orgId;
    } else if (args.clientId) {
      const access = await checkClientAccess(db, args.clientId, args.userId);
      if (!access.ok) return failure("not_found", "Client not found");
      const { data } = await db
        .from("clients")
        .select("org_id, drive_folder_id, drive_folder_name")
        .eq("id", args.clientId)
        .maybeSingle();
      const row = data as { org_id: string | null; drive_folder_id: string | null; drive_folder_name: string | null } | null;
      folderId = row?.drive_folder_id ?? null;
      name = row?.drive_folder_name ?? "client folder";
      orgId = row?.org_id ?? orgId;
    }
    if (!folderId)
      return failure("validation", "This matter or client has no Drive folder linked.", "no_drive_folder");
    rootFolderId = folderId;
    searched = `the Drive folder "${name}"`;
  }

  const owner = await driveOwnerFor(db, args.userId, orgId);
  try {
    const hits = await searchDriveFiles(owner, db, {
      query: args.query,
      rootFolderId,
      limit: args.limit,
    });
    return ok({
      searched,
      files: hits.map((h) => ({
        file_id: h.id,
        name: h.name,
        kind: h.mimeType === "application/vnd.google-apps.document" ? "google_doc" : "word",
        modified: h.modifiedTime,
        link: h.webViewLink,
      })),
      drive_error: null,
    });
  } catch (error) {
    const driveError = asDriveError(error);
    if (!driveError) throw error;
    return ok({ searched, files: [], drive_error: driveError });
  }
}

// A matter's Google Drive workspace: the linked matter folder and the files in
// its "Work in progress" subfolder.
//
// Drive is always read with the CALLER's own Google connection in the matter's
// workspace, never a shared one, so a lawyer sees only what their Google
// account may already open. Drive failures that the page can explain (not
// connected, folder access missing) come back as `drive_error` on a normal
// result so the dashboard still renders; they are fixed strings, never
// Google's response bodies.

import { checkProjectAccess } from "../../lib/access";
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
import type { ConnectorOwner } from "../../lib/connectorOwner";
import { GoogleDriveUserError } from "../../lib/integrations/googleDriveHttp";
import {
  findWorkInProgressFolder,
  getDriveFolder,
  isDriveId,
  listDriveFolderChildren,
  type DriveBrowseItem,
} from "../../lib/integrations/googleDrive";

export type DriveError = { code: string; message: string };

export type DriveFileKind = "docx" | "gdoc" | "folder" | "other";

export type WorkspaceFile = {
  id: string;
  name: string;
  kind: DriveFileKind;
  modified_time: string | null;
  web_view_link: string | null;
};

export type MatterWorkspace = {
  linked: boolean;
  folder: { id: string; name: string; web_view_link: string | null } | null;
  wip: { id: string; name: string; web_view_link: string | null } | null;
  files: WorkspaceFile[];
  drive_error: DriveError | null;
};

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const GDOC_MIME = "application/vnd.google-apps.document";

export function fileKind(item: Pick<DriveBrowseItem, "mimeType" | "isFolder" | "name">): DriveFileKind {
  if (item.isFolder) return "folder";
  if (item.mimeType === GDOC_MIME) return "gdoc";
  if (item.mimeType === DOCX_MIME || /\.docx$/i.test(item.name)) return "docx";
  return "other";
}

function toWorkspaceFile(item: DriveBrowseItem): WorkspaceFile {
  return {
    id: item.id,
    name: item.name,
    kind: fileKind(item),
    modified_time: item.modifiedTime,
    web_view_link: item.webViewLink,
  };
}

// Drive errors the user can act on. Anything else is unexpected and rethrown
// so it reaches the router's opaque 500 and the log.
function asDriveError(error: unknown): DriveError | null {
  if (!(error instanceof GoogleDriveUserError)) return null;
  return {
    code: error.code ?? "google_drive_error",
    message: error.message,
  };
}

// The caller's connections in the workspace the matter lives in.
async function ownerFor(
  db: Db,
  userId: string,
  orgId: string | null | undefined,
): Promise<ConnectorOwner> {
  return { userId, orgId: await teamOrgIdOf(db, orgId ?? null) };
}

/** Folder browser for the "choose matter folder" dialog. */
export async function browseDriveFolders(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter; parentId?: unknown },
): Promise<ServiceResult<{ items: WorkspaceFile[]; drive_error: DriveError | null }>> {
  const parentId = args.parentId === undefined || args.parentId === "" ? "root" : args.parentId;
  if (!isDriveId(parentId)) return failure("validation", "parent is not a valid Drive folder");
  const orgId =
    args.workspace && args.workspace !== PERSONAL_WORKSPACE ? args.workspace : null;
  const owner = await ownerFor(db, args.userId, orgId);
  try {
    const items = await listDriveFolderChildren(owner, db, {
      parentId,
      foldersOnly: true,
    });
    return ok({ items: items.map(toWorkspaceFile), drive_error: null });
  } catch (error) {
    const driveError = asDriveError(error);
    if (!driveError) throw error;
    return ok({ items: [], drive_error: driveError });
  }
}

type ProjectDriveRow = {
  id: string;
  org_id: string | null;
  drive_folder_id: string | null;
  drive_folder_name: string | null;
};

async function loadProjectDrive(
  db: Db,
  projectId: string,
): Promise<ServiceResult<ProjectDriveRow>> {
  const { data, error } = await db
    .from("projects")
    .select("id, org_id, drive_folder_id, drive_folder_name")
    .eq("id", projectId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Project not found");
  return ok(data as ProjectDriveRow);
}

export async function getMatterWorkspace(
  db: Db,
  args: { userId: string; userEmail?: string | null; projectId: string },
): Promise<ServiceResult<MatterWorkspace>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Project not found");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Project not found");
  const project = await loadProjectDrive(db, args.projectId);
  if (!project.ok) return project;

  const { drive_folder_id: folderId, drive_folder_name: folderName } = project.data;
  if (!folderId) {
    return ok({ linked: false, folder: null, wip: null, files: [], drive_error: null });
  }
  const owner = await ownerFor(db, args.userId, project.data.org_id);
  const folder = { id: folderId, name: folderName ?? "Matter folder", web_view_link: null as string | null };
  try {
    const wip = await findWorkInProgressFolder(owner, db, folderId);
    if (!wip) return ok({ linked: true, folder, wip: null, files: [], drive_error: null });
    const items = await listDriveFolderChildren(owner, db, { parentId: wip.id });
    return ok({
      linked: true,
      folder,
      wip: { id: wip.id, name: wip.name, web_view_link: wip.webViewLink },
      files: items.map(toWorkspaceFile),
      drive_error: null,
    });
  } catch (error) {
    const driveError = asDriveError(error);
    if (!driveError) throw error;
    return ok({ linked: true, folder, wip: null, files: [], drive_error: driveError });
  }
}

// Link (or, with a null folderId, unlink) the matter's Drive folder. The
// folder is checked through the caller's own Drive connection, so nobody can
// attach a folder they cannot open.
export async function linkMatterDriveFolder(
  db: Db,
  args: {
    userId: string;
    userEmail?: string | null;
    projectId: string;
    folderId: unknown;
  },
): Promise<ServiceResult<MatterWorkspace>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Project not found");
  if (args.folderId !== null && !isDriveId(args.folderId))
    return failure("validation", "folder_id must be a Drive folder id or null");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Project not found");
  if (!can(access.projectRole, "content.edit"))
    return failure("forbidden", "You need edit access to link a Drive folder.");

  let name: string | null = null;
  if (args.folderId !== null) {
    const owner = await ownerFor(db, args.userId, access.project.org_id);
    try {
      const folder = await getDriveFolder(owner, db, args.folderId);
      if (!folder)
        return failure("validation", "That Google Drive folder was not found or cannot be opened.");
      name = folder.name;
    } catch (error) {
      const driveError = asDriveError(error);
      if (!driveError) throw error;
      return failure("conflict", driveError.message, driveError.code);
    }
  }
  const { error } = await db
    .from("projects")
    .update({
      drive_folder_id: args.folderId,
      drive_folder_name: name,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.projectId);
  if (error) return internalFailure(error);
  return getMatterWorkspace(db, args);
}

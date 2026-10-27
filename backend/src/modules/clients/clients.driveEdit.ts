// Edit a matter's Word and Google Docs files in Mike's editor.
//
// "Edit in Mike" pulls the Drive file in as a .docx document of the matter's
// project (a Google Doc is exported to .docx) and remembers the link. The
// document is then edited like any other Mike document, and "Save to Drive"
// writes the current version back to the SAME Drive file. A pull from Drive
// adds a new Mike version, so nothing in Mike is overwritten; Drive keeps its
// own history for the write-back direction.
//
// Everything runs with the caller's own Google connection in the matter's
// workspace. Drive problems the user can act on come back as `conflict`
// failures carrying a stable `code` and a fixed message.

import { checkProjectAccess } from "../../lib/access";
import { contentSha256 } from "../../lib/documentVersions";
import {
  downloadDriveFileAsDocx,
  getDriveEditableFile,
  isDriveId,
  uploadDocxToDriveFile,
  type DriveEditableFile,
} from "../../lib/integrations/googleDrive";
import { GoogleDriveUserError } from "../../lib/integrations/googleDriveHttp";
import type { ConnectorOwner } from "../../lib/connectorOwner";
import { can } from "../../lib/permissions";
import { teamOrgIdOf } from "../../lib/personalOrgs";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceFailure,
  type ServiceResult,
} from "../../lib/serviceResult";
import { isUuid } from "../../lib/uuid";
import {
  addDocxVersionToDocument,
  createDocumentFromDocxBytes,
  loadCurrentVersionBytes,
} from "../documents/documents.service";

type LinkRow = {
  document_id: string;
  project_id: string;
  drive_file_id: string;
  drive_mime_type: string;
  drive_name: string | null;
  drive_modified_time: string | null;
  synced_sha256: string | null;
  synced_at: string;
};

const LINK_COLUMNS =
  "document_id, project_id, drive_file_id, drive_mime_type, drive_name, drive_modified_time, synced_sha256, synced_at";

export type DriveSyncState =
  | "in_sync"
  | "local_changes"
  | "drive_changes"
  | "both_changed"
  | "unknown";

export type DriveSyncStatus = {
  document_id: string;
  project_id: string;
  drive_file_id: string;
  drive_name: string | null;
  kind: "gdoc" | "docx";
  web_view_link: string | null;
  state: DriveSyncState;
  synced_at: string;
  drive_error: { code: string; message: string } | null;
};

const GDOC_MIME = "application/vnd.google-apps.document";

function driveFailure(error: unknown): ServiceFailure | null {
  if (!(error instanceof GoogleDriveUserError)) return null;
  return failure("conflict", error.message, error.code ?? "google_drive_error");
}

async function ownerFor(db: Db, userId: string, orgId: string | null | undefined): Promise<ConnectorOwner> {
  return { userId, orgId: await teamOrgIdOf(db, orgId ?? null) };
}

type EditContext = { owner: ConnectorOwner; projectId: string };

// The project, with edit rights, and the caller's Drive connection for it.
async function authorizeProjectEdit(
  db: Db,
  args: { userId: string; userEmail?: string | null; projectId: string },
): Promise<ServiceResult<EditContext>> {
  if (!isUuid(args.projectId)) return failure("not_found", "Matter not found");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Matter not found");
  if (!can(access.projectRole, "content.edit"))
    return failure("forbidden", "You need edit access to this matter.");
  return ok({
    owner: await ownerFor(db, args.userId, access.project.org_id),
    projectId: args.projectId,
  });
}

async function loadLinkByDocument(
  db: Db,
  documentId: string,
): Promise<ServiceResult<LinkRow>> {
  if (!isUuid(documentId)) return failure("not_found", "Document not found");
  const { data, error } = await db
    .from("document_drive_links")
    .select(LINK_COLUMNS)
    .eq("document_id", documentId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "This document is not linked to Google Drive.");
  return ok(data as LinkRow);
}

export type OpenedDriveFile = { document_id: string; project_id: string; created: boolean };

export async function openDriveFileForEditing(
  db: Db,
  args: { userId: string; userEmail?: string | null; projectId: string; fileId: unknown },
): Promise<ServiceResult<OpenedDriveFile>> {
  if (!isDriveId(args.fileId)) return failure("validation", "file_id is not a valid Drive file id");
  const fileId = args.fileId;
  const ctx = await authorizeProjectEdit(db, args);
  if (!ctx.ok) return ctx;

  const existing = await db
    .from("document_drive_links")
    .select(LINK_COLUMNS)
    .eq("project_id", args.projectId)
    .eq("drive_file_id", fileId)
    .maybeSingle();
  if (existing.error) return internalFailure(existing.error);
  if (existing.data)
    return ok({
      document_id: (existing.data as LinkRow).document_id,
      project_id: args.projectId,
      created: false,
    });

  let downloaded: { bytes: Buffer; file: DriveEditableFile };
  try {
    downloaded = await downloadDriveFileAsDocx(ctx.data.owner, db, fileId);
  } catch (error) {
    const mapped = driveFailure(error);
    if (!mapped) throw error;
    return mapped;
  }
  const { bytes, file } = downloaded;
  const created = await createDocumentFromDocxBytes(db, {
    userId: args.userId,
    projectId: args.projectId,
    name: file.name,
    bytes,
  });
  if (!created.ok) return created;

  const { error } = await db.from("document_drive_links").insert({
    document_id: created.data.documentId,
    project_id: args.projectId,
    drive_file_id: file.id,
    drive_mime_type: file.mimeType,
    drive_name: file.name,
    drive_modified_time: file.modifiedTime,
    synced_sha256: created.data.sha256,
    linked_by: args.userId,
  });
  if (error) {
    // Lost a race with another tab opening the same file: use theirs.
    if ((error as { code?: string }).code === "23505") {
      await db.from("documents").delete().eq("id", created.data.documentId);
      const winner = await db
        .from("document_drive_links")
        .select(LINK_COLUMNS)
        .eq("project_id", args.projectId)
        .eq("drive_file_id", fileId)
        .maybeSingle();
      if (winner.data)
        return ok({
          document_id: (winner.data as LinkRow).document_id,
          project_id: args.projectId,
          created: false,
        });
    }
    await db.from("documents").delete().eq("id", created.data.documentId);
    return internalFailure(error);
  }
  return ok({ document_id: created.data.documentId, project_id: args.projectId, created: true });
}

export async function getDriveSyncStatus(
  db: Db,
  args: { userId: string; userEmail?: string | null; documentId: string },
): Promise<ServiceResult<DriveSyncStatus>> {
  const link = await loadLinkByDocument(db, args.documentId);
  if (!link.ok) return link;
  const access = await checkProjectAccess(link.data.project_id, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Document not found");

  const base = {
    document_id: link.data.document_id,
    project_id: link.data.project_id,
    drive_file_id: link.data.drive_file_id,
    drive_name: link.data.drive_name,
    kind: (link.data.drive_mime_type === GDOC_MIME ? "gdoc" : "docx") as "gdoc" | "docx",
    synced_at: link.data.synced_at,
  };

  const current = await loadCurrentVersionBytes(link.data.document_id, db);
  const localChanged =
    !!current && !!link.data.synced_sha256 && contentSha256(current.bytes) !== link.data.synced_sha256;

  try {
    const owner = await ownerFor(db, args.userId, access.project.org_id);
    const file = await getDriveEditableFile(owner, db, link.data.drive_file_id);
    const driveChanged =
      !!file.modifiedTime &&
      !!link.data.drive_modified_time &&
      Date.parse(file.modifiedTime) !== Date.parse(link.data.drive_modified_time);
    const state: DriveSyncState =
      localChanged && driveChanged
        ? "both_changed"
        : localChanged
          ? "local_changes"
          : driveChanged
            ? "drive_changes"
            : "in_sync";
    return ok({ ...base, web_view_link: file.webViewLink, state, drive_error: null });
  } catch (error) {
    if (!(error instanceof GoogleDriveUserError)) throw error;
    return ok({
      ...base,
      web_view_link: null,
      state: "unknown",
      drive_error: { code: error.code ?? "google_drive_error", message: error.message },
    });
  }
}

async function authorizeLinkedDocument(
  db: Db,
  args: { userId: string; userEmail?: string | null; documentId: string },
): Promise<ServiceResult<{ link: LinkRow; owner: ConnectorOwner }>> {
  const link = await loadLinkByDocument(db, args.documentId);
  if (!link.ok) return link;
  const ctx = await authorizeProjectEdit(db, {
    userId: args.userId,
    userEmail: args.userEmail,
    projectId: link.data.project_id,
  });
  if (!ctx.ok) return ctx;
  return ok({ link: link.data, owner: ctx.data.owner });
}

export async function saveDocumentToDrive(
  db: Db,
  args: { userId: string; userEmail?: string | null; documentId: string; overwrite?: boolean },
): Promise<ServiceResult<{ synced_at: string }>> {
  const auth = await authorizeLinkedDocument(db, args);
  if (!auth.ok) return auth;
  const { link, owner } = auth.data;
  const current = await loadCurrentVersionBytes(link.document_id, db);
  if (!current) return failure("not_found", "The document's file could not be read.");

  let saved: Awaited<ReturnType<typeof uploadDocxToDriveFile>>;
  try {
    saved = await uploadDocxToDriveFile(owner, db, link.drive_file_id, current.bytes, {
      expectedModifiedTime: link.drive_modified_time,
      overwrite: args.overwrite === true,
    });
  } catch (error) {
    const mapped = driveFailure(error);
    if (!mapped) throw error;
    return mapped;
  }
  const syncedAt = new Date().toISOString();
  const { error } = await db
    .from("document_drive_links")
    .update({
      drive_modified_time: saved.modifiedTime,
      synced_sha256: contentSha256(current.bytes),
      synced_at: syncedAt,
    })
    .eq("document_id", link.document_id);
  if (error) return internalFailure(error);
  return ok({ synced_at: syncedAt });
}

// Bring Drive's current content into Mike as a NEW version, which becomes the
// active one. Earlier Mike versions stay available in the version menu.
export async function pullDocumentFromDrive(
  db: Db,
  args: { userId: string; userEmail?: string | null; documentId: string },
): Promise<ServiceResult<{ version_id: string; synced_at: string }>> {
  const auth = await authorizeLinkedDocument(db, args);
  if (!auth.ok) return auth;
  const { link, owner } = auth.data;

  let downloaded: { bytes: Buffer; file: DriveEditableFile };
  try {
    downloaded = await downloadDriveFileAsDocx(owner, db, link.drive_file_id);
  } catch (error) {
    const mapped = driveFailure(error);
    if (!mapped) throw error;
    return mapped;
  }
  const added = await addDocxVersionToDocument(db, {
    userId: args.userId,
    documentId: link.document_id,
    name: downloaded.file.name,
    bytes: downloaded.bytes,
  });
  if (!added.ok) return added;
  const syncedAt = new Date().toISOString();
  const { error } = await db
    .from("document_drive_links")
    .update({
      drive_modified_time: downloaded.file.modifiedTime,
      drive_name: downloaded.file.name,
      synced_sha256: added.data.sha256,
      synced_at: syncedAt,
    })
    .eq("document_id", link.document_id);
  if (error) return internalFailure(error);
  return ok({ version_id: added.data.versionId, synced_at: syncedAt });
}

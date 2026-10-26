import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({ checkProjectAccess: vi.fn() }));
vi.mock("../../../lib/personalOrgs", () => ({
  teamOrgIdOf: vi.fn(async (_db: unknown, id: string | null) => id),
}));
vi.mock("../../../lib/integrations/googleDrive", () => ({
  downloadDriveFileAsDocx: vi.fn(),
  getDriveEditableFile: vi.fn(),
  uploadDocxToDriveFile: vi.fn(),
  isDriveId: (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v),
}));
vi.mock("../../documents/documents.service", () => ({
  addDocxVersionToDocument: vi.fn(),
  createDocumentFromDocxBytes: vi.fn(),
  loadCurrentVersionBytes: vi.fn(),
}));

import { checkProjectAccess } from "../../../lib/access";
import { contentSha256 } from "../../../lib/documentVersions";
import {
  downloadDriveFileAsDocx,
  getDriveEditableFile,
  uploadDocxToDriveFile,
} from "../../../lib/integrations/googleDrive";
import { GoogleDriveUserError } from "../../../lib/integrations/googleDriveHttp";
import {
  addDocxVersionToDocument,
  createDocumentFromDocxBytes,
  loadCurrentVersionBytes,
} from "../../documents/documents.service";
import {
  getDriveSyncStatus,
  openDriveFileForEditing,
  pullDocumentFromDrive,
  saveDocumentToDrive,
} from "../clients.driveEdit";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.from("docx-bytes");
const sha = contentSha256(bytes);

type Scripted = { data: unknown; error?: unknown };

// `script[table]` is consumed one result per awaited query on that table.
function fakeDb(script: Record<string, Scripted[]>) {
  const calls: { table: string; op: string; payload?: unknown }[] = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const db = {
    from(table: string) {
      const next = () => {
        const r = queues[table]?.shift() ?? { data: null };
        return { error: null, ...r };
      };
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") return (res: (v: unknown) => unknown) => res(next());
            if (prop === "single" || prop === "maybeSingle") return async () => next();
            return (...args: unknown[]) => {
              if (["insert", "update", "delete"].includes(prop))
                calls.push({ table, op: prop, payload: args[0] });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { db: db as any, calls };
}

const access = (role: string) =>
  vi.mocked(checkProjectAccess).mockResolvedValue({
    ok: true,
    isCreator: true,
    orgRole: null,
    projectRole: role,
    project: { id: PROJECT_ID, user_id: "me", org_id: null },
  } as never);

const link = {
  document_id: DOC_ID,
  project_id: PROJECT_ID,
  drive_file_id: "drv1",
  drive_mime_type: "application/vnd.google-apps.document",
  drive_name: "Draft SPA",
  drive_modified_time: "2026-10-20T10:00:00Z",
  synced_sha256: sha,
  synced_at: "2026-10-20T10:00:00Z",
};

const driveFile = {
  id: "drv1",
  name: "Draft SPA",
  mimeType: "application/vnd.google-apps.document",
  modifiedTime: "2026-10-20T10:00:00Z",
  etag: "e1",
  webViewLink: "https://docs.google.com/document/d/drv1",
};

beforeEach(() => vi.clearAllMocks());

describe("openDriveFileForEditing", () => {
  it("rejects a malformed Drive id before any call", async () => {
    const { db } = fakeDb({});
    expect(
      await openDriveFileForEditing(db, { userId: "me", projectId: PROJECT_ID, fileId: "a b" }),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(checkProjectAccess).not.toHaveBeenCalled();
  });

  it("needs edit access to the matter", async () => {
    access("viewer");
    const { db } = fakeDb({});
    expect(
      await openDriveFileForEditing(db, { userId: "me", projectId: PROJECT_ID, fileId: "drv1" }),
    ).toMatchObject({ ok: false, kind: "forbidden" });
    expect(downloadDriveFileAsDocx).not.toHaveBeenCalled();
  });

  it("reuses the document when the file is already linked", async () => {
    access("editor");
    const { db } = fakeDb({ document_drive_links: [{ data: link }] });
    expect(
      await openDriveFileForEditing(db, { userId: "me", projectId: PROJECT_ID, fileId: "drv1" }),
    ).toEqual({ ok: true, data: { document_id: DOC_ID, project_id: PROJECT_ID, created: false } });
    expect(downloadDriveFileAsDocx).not.toHaveBeenCalled();
  });

  it("imports a new file and records the link", async () => {
    access("editor");
    vi.mocked(downloadDriveFileAsDocx).mockResolvedValue({ bytes, file: driveFile } as never);
    vi.mocked(createDocumentFromDocxBytes).mockResolvedValue({
      ok: true,
      data: { documentId: DOC_ID, versionId: "v1", filename: "Draft SPA.docx", sha256: sha },
    });
    const { db, calls } = fakeDb({ document_drive_links: [{ data: null }, { data: null }] });
    const result = await openDriveFileForEditing(db, { userId: "me", projectId: PROJECT_ID, fileId: "drv1" });
    expect(result).toMatchObject({ ok: true, data: { document_id: DOC_ID, created: true } });
    expect(calls.find((c) => c.op === "insert")).toMatchObject({
      table: "document_drive_links",
      payload: { document_id: DOC_ID, drive_file_id: "drv1", synced_sha256: sha, linked_by: "me" },
    });
  });

  it("turns a Drive problem into a conflict with its code", async () => {
    access("editor");
    const err = new GoogleDriveUserError("Reconnect Google Drive.");
    err.code = "google_drive_scope_insufficient";
    vi.mocked(downloadDriveFileAsDocx).mockRejectedValue(err);
    const { db } = fakeDb({ document_drive_links: [{ data: null }] });
    expect(
      await openDriveFileForEditing(db, { userId: "me", projectId: PROJECT_ID, fileId: "drv1" }),
    ).toMatchObject({ ok: false, kind: "conflict", code: "google_drive_scope_insufficient" });
    expect(createDocumentFromDocxBytes).not.toHaveBeenCalled();
  });
});

describe("getDriveSyncStatus", () => {
  const status = async () => {
    const { db } = fakeDb({ document_drive_links: [{ data: link }] });
    return getDriveSyncStatus(db, { userId: "me", documentId: DOC_ID });
  };

  it("is in sync when neither side changed", async () => {
    access("viewer");
    vi.mocked(loadCurrentVersionBytes).mockResolvedValue({ bytes, storage_path: "p" });
    vi.mocked(getDriveEditableFile).mockResolvedValue(driveFile as never);
    expect(await status()).toMatchObject({ ok: true, data: { state: "in_sync", kind: "gdoc" } });
  });

  it("reports local changes, Drive changes, and both", async () => {
    access("viewer");
    vi.mocked(loadCurrentVersionBytes).mockResolvedValue({ bytes: Buffer.from("edited"), storage_path: "p" });
    vi.mocked(getDriveEditableFile).mockResolvedValue(driveFile as never);
    expect(await status()).toMatchObject({ data: { state: "local_changes" } });

    vi.mocked(loadCurrentVersionBytes).mockResolvedValue({ bytes, storage_path: "p" });
    vi.mocked(getDriveEditableFile).mockResolvedValue({ ...driveFile, modifiedTime: "2026-10-21T10:00:00Z" } as never);
    expect(await status()).toMatchObject({ data: { state: "drive_changes" } });

    vi.mocked(loadCurrentVersionBytes).mockResolvedValue({ bytes: Buffer.from("edited"), storage_path: "p" });
    expect(await status()).toMatchObject({ data: { state: "both_changed" } });
  });

  it("stays usable, with state unknown, when Drive cannot be read", async () => {
    access("viewer");
    vi.mocked(loadCurrentVersionBytes).mockResolvedValue({ bytes, storage_path: "p" });
    vi.mocked(getDriveEditableFile).mockRejectedValue(new GoogleDriveUserError("Reconnect Google Drive."));
    expect(await status()).toMatchObject({
      ok: true,
      data: { state: "unknown", drive_error: { message: "Reconnect Google Drive." } },
    });
  });

  it("hides a link from someone without access to its matter", async () => {
    vi.mocked(checkProjectAccess).mockResolvedValue({ ok: false });
    expect(await status()).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("saveDocumentToDrive", () => {
  it("needs edit access", async () => {
    access("viewer");
    const { db } = fakeDb({ document_drive_links: [{ data: link }] });
    expect(await saveDocumentToDrive(db, { userId: "me", documentId: DOC_ID })).toMatchObject({
      ok: false,
      kind: "forbidden",
    });
    expect(uploadDocxToDriveFile).not.toHaveBeenCalled();
  });

  it("writes the current bytes and records the new sync point", async () => {
    access("editor");
    vi.mocked(loadCurrentVersionBytes).mockResolvedValue({ bytes, storage_path: "p" });
    vi.mocked(uploadDocxToDriveFile).mockResolvedValue({ modifiedTime: "2026-10-22T09:00:00Z", file: driveFile } as never);
    const { db, calls } = fakeDb({ document_drive_links: [{ data: link }, { data: null }] });
    const result = await saveDocumentToDrive(db, { userId: "me", documentId: DOC_ID });
    expect(result.ok).toBe(true);
    expect(uploadDocxToDriveFile).toHaveBeenCalledWith(
      expect.anything(),
      db,
      "drv1",
      bytes,
      { expectedModifiedTime: "2026-10-20T10:00:00Z", overwrite: false },
    );
    expect(calls.at(-1)).toMatchObject({
      op: "update",
      payload: { drive_modified_time: "2026-10-22T09:00:00Z", synced_sha256: sha },
    });
  });

  it("passes overwrite only when asked, and maps a Drive conflict", async () => {
    access("editor");
    vi.mocked(loadCurrentVersionBytes).mockResolvedValue({ bytes, storage_path: "p" });
    const err = new GoogleDriveUserError("changed in Drive");
    err.code = "google_drive_changed";
    vi.mocked(uploadDocxToDriveFile).mockRejectedValue(err);
    const { db } = fakeDb({ document_drive_links: [{ data: link }] });
    expect(await saveDocumentToDrive(db, { userId: "me", documentId: DOC_ID, overwrite: true })).toMatchObject({
      ok: false,
      kind: "conflict",
      code: "google_drive_changed",
    });
    expect(vi.mocked(uploadDocxToDriveFile).mock.calls[0][4]).toMatchObject({ overwrite: true });
  });
});

describe("pullDocumentFromDrive", () => {
  it("adds a new version and moves the sync point", async () => {
    access("editor");
    vi.mocked(downloadDriveFileAsDocx).mockResolvedValue({ bytes, file: driveFile } as never);
    vi.mocked(addDocxVersionToDocument).mockResolvedValue({
      ok: true,
      data: { documentId: DOC_ID, versionId: "v2", filename: "Draft SPA.docx", sha256: sha },
    });
    const { db, calls } = fakeDb({ document_drive_links: [{ data: link }, { data: null }] });
    const result = await pullDocumentFromDrive(db, { userId: "me", documentId: DOC_ID });
    expect(result).toMatchObject({ ok: true, data: { version_id: "v2" } });
    expect(addDocxVersionToDocument).toHaveBeenCalledWith(db, expect.objectContaining({ documentId: DOC_ID, bytes }));
    expect(calls.at(-1)).toMatchObject({ op: "update", payload: { synced_sha256: sha } });
  });
});

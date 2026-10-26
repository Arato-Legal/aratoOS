import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({ checkProjectAccess: vi.fn() }));
vi.mock("../../../lib/personalOrgs", () => ({
  teamOrgIdOf: vi.fn(async (_db: unknown, id: string | null) => id),
}));
vi.mock("../../../lib/integrations/googleDrive", () => ({
  findWorkInProgressFolder: vi.fn(),
  getDriveFolder: vi.fn(),
  listDriveFolderChildren: vi.fn(),
  isDriveId: (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v),
}));

import { checkProjectAccess } from "../../../lib/access";
import {
  findWorkInProgressFolder,
  getDriveFolder,
  listDriveFolderChildren,
} from "../../../lib/integrations/googleDrive";
import { GoogleDriveUserError } from "../../../lib/integrations/googleDriveHttp";
import {
  browseDriveFolders,
  fileKind,
  getMatterWorkspace,
  linkMatterDriveFolder,
} from "../clients.drive";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function fakeDb(project: Record<string, unknown> | null) {
  const updates: unknown[] = [];
  const db = {
    from() {
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") return (r: (v: unknown) => unknown) => r({ data: null, error: null });
            if (prop === "maybeSingle" || prop === "single")
              return async () => ({ data: project, error: null });
            return (...args: unknown[]) => {
              if (prop === "update") updates.push(args[0]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { db: db as any, updates };
}

const access = (role: string) =>
  vi.mocked(checkProjectAccess).mockResolvedValue({
    ok: true,
    isCreator: true,
    orgRole: null,
    projectRole: role,
    project: { id: PROJECT_ID, user_id: "me", org_id: null },
  } as never);

const item = (over: Record<string, unknown>) => ({
  id: "x",
  name: "n",
  mimeType: "application/pdf",
  modifiedTime: null,
  webViewLink: null,
  isFolder: false,
  ...over,
});

describe("fileKind", () => {
  it("recognises docx, Google Docs and folders", () => {
    expect(fileKind(item({ name: "a.docx", mimeType: "application/octet-stream" }))).toBe("docx");
    expect(fileKind(item({ mimeType: "application/vnd.google-apps.document" }))).toBe("gdoc");
    expect(fileKind(item({ isFolder: true }))).toBe("folder");
    expect(fileKind(item({}))).toBe("other");
  });
});

describe("getMatterWorkspace", () => {
  it("reports an unlinked matter without calling Drive", async () => {
    access("viewer");
    const { db } = fakeDb({ id: PROJECT_ID, org_id: null, drive_folder_id: null, drive_folder_name: null });
    const result = await getMatterWorkspace(db, { userId: "me", projectId: PROJECT_ID });
    expect(result).toMatchObject({ ok: true, data: { linked: false, files: [] } });
    expect(listDriveFolderChildren).not.toHaveBeenCalled();
  });

  it("lists the Work in progress folder's files", async () => {
    access("viewer");
    vi.mocked(findWorkInProgressFolder).mockResolvedValueOnce(
      item({ id: "wip", name: "Work in progress", isFolder: true }) as never,
    );
    vi.mocked(listDriveFolderChildren).mockResolvedValueOnce([
      item({ id: "f1", name: "Draft.docx", mimeType: "application/vnd.google-apps.document" }),
    ] as never);
    const { db } = fakeDb({ id: PROJECT_ID, org_id: null, drive_folder_id: "m1", drive_folder_name: "Matter" });
    const result = await getMatterWorkspace(db, { userId: "me", projectId: PROJECT_ID });
    expect(result).toMatchObject({
      ok: true,
      data: { linked: true, wip: { id: "wip" }, files: [{ id: "f1", kind: "gdoc" }] },
    });
  });

  it("turns a Drive problem into a drive_error the page can show", async () => {
    access("viewer");
    const err = new GoogleDriveUserError("Reconnect Google Drive.");
    err.code = "google_drive_scope_insufficient";
    vi.mocked(findWorkInProgressFolder).mockRejectedValueOnce(err);
    const { db } = fakeDb({ id: PROJECT_ID, org_id: null, drive_folder_id: "m1", drive_folder_name: "M" });
    const result = await getMatterWorkspace(db, { userId: "me", projectId: PROJECT_ID });
    expect(result).toMatchObject({
      ok: true,
      data: { linked: true, drive_error: { code: "google_drive_scope_insufficient" } },
    });
  });

  it("does not swallow unexpected errors", async () => {
    access("viewer");
    vi.mocked(findWorkInProgressFolder).mockRejectedValueOnce(new Error("boom"));
    const { db } = fakeDb({ id: PROJECT_ID, org_id: null, drive_folder_id: "m1", drive_folder_name: "M" });
    await expect(getMatterWorkspace(db, { userId: "me", projectId: PROJECT_ID })).rejects.toThrow("boom");
  });
});

describe("linkMatterDriveFolder", () => {
  it("needs edit access", async () => {
    access("viewer");
    const { db, updates } = fakeDb({});
    expect(
      await linkMatterDriveFolder(db, { userId: "me", projectId: PROJECT_ID, folderId: "abc" }),
    ).toMatchObject({ ok: false, kind: "forbidden" });
    expect(updates).toHaveLength(0);
  });

  it("rejects a malformed folder id before any Drive call", async () => {
    access("editor");
    const { db } = fakeDb({});
    expect(
      await linkMatterDriveFolder(db, { userId: "me", projectId: PROJECT_ID, folderId: "a' or '1'='1" }),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(getDriveFolder).not.toHaveBeenCalled();
  });

  it("refuses a folder the caller's Drive cannot open", async () => {
    access("editor");
    vi.mocked(getDriveFolder).mockResolvedValueOnce(null);
    const { db, updates } = fakeDb({});
    expect(
      await linkMatterDriveFolder(db, { userId: "me", projectId: PROJECT_ID, folderId: "abc" }),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(updates).toHaveLength(0);
  });

  it("stores the folder's id and name", async () => {
    access("editor");
    vi.mocked(getDriveFolder).mockResolvedValueOnce(item({ id: "abc", name: "Acme / Financing", isFolder: true }) as never);
    vi.mocked(findWorkInProgressFolder).mockResolvedValue(null);
    const { db, updates } = fakeDb({ id: PROJECT_ID, org_id: null, drive_folder_id: "abc", drive_folder_name: "Acme / Financing" });
    const result = await linkMatterDriveFolder(db, { userId: "me", projectId: PROJECT_ID, folderId: "abc" });
    expect(result.ok).toBe(true);
    expect(updates[0]).toMatchObject({ drive_folder_id: "abc", drive_folder_name: "Acme / Financing" });
  });
});

describe("browseDriveFolders", () => {
  it("starts at My Drive and lists folders only", async () => {
    vi.mocked(listDriveFolderChildren).mockResolvedValueOnce([item({ id: "c1", isFolder: true })] as never);
    const { db } = fakeDb(null);
    const result = await browseDriveFolders(db, { userId: "me", workspace: null });
    expect(listDriveFolderChildren).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "me" }),
      db,
      { parentId: "root", foldersOnly: true },
    );
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "c1", kind: "folder" }] } });
  });

  it("rejects an invalid parent", async () => {
    const { db } = fakeDb(null);
    expect(await browseDriveFolders(db, { userId: "me", workspace: null, parentId: "x y" })).toMatchObject({
      ok: false,
      kind: "validation",
    });
  });
});

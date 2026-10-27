import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({
  getOrgRole: vi.fn(),
  isOrgAdmin: (r: string | null) => r === "owner" || r === "admin",
}));
vi.mock("../../../lib/personalOrgs", () => ({
  teamOrgIdOf: vi.fn(async (_db: unknown, id: string | null) => id),
}));
vi.mock("../clients.integrations", () => ({
  driveOwnerFor: vi.fn(async (_db: unknown, userId: string, orgId: string | null) => ({
    userId,
    orgId,
  })),
}));
vi.mock("../../../lib/integrations/googleDrive", () => ({
  driveFolderIsWithin: vi.fn(),
  getDriveFolder: vi.fn(),
  isDriveId: (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v),
  listDriveFolderChildren: vi.fn(),
}));

import { getOrgRole } from "../../../lib/access";
import {
  driveFolderIsWithin,
  getDriveFolder,
  listDriveFolderChildren,
} from "../../../lib/integrations/googleDrive";
import { listLibraryDriveFolder, setLibraryDriveFolder } from "../clients.libraryDrive";

function fakeDb(row: unknown) {
  const writes: { op: string; value?: unknown }[] = [];
  const db = {
    from() {
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "maybeSingle") return async () => ({ data: row, error: null });
            if (prop === "then") return (r: (v: unknown) => unknown) => r({ data: null, error: null });
            return (...args: unknown[]) => {
              if (prop === "insert" || prop === "delete") writes.push({ op: prop, value: args[0] });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { db: db as any, writes };
}

const ROOT = { drive_folder_id: "root1", drive_folder_name: "Precedents" };

beforeEach(() => vi.clearAllMocks());

describe("listLibraryDriveFolder", () => {
  it("is empty until a folder is chosen", async () => {
    const { db } = fakeDb(null);
    const result = await listLibraryDriveFolder(db, { userId: "u", workspace: "personal", kind: "precedents" });
    expect(result).toMatchObject({ ok: true, data: { root: null, files: [] } });
    expect(listDriveFolderChildren).not.toHaveBeenCalled();
  });

  it("refuses a folder outside the chosen root", async () => {
    vi.mocked(driveFolderIsWithin).mockResolvedValue(false);
    const { db } = fakeDb(ROOT);
    const result = await listLibraryDriveFolder(db, {
      userId: "u",
      workspace: "personal",
      kind: "precedents",
      folderId: "elsewhere",
    });
    expect(result.ok).toBe(false);
    expect(listDriveFolderChildren).not.toHaveBeenCalled();
  });

  it("lists the root's children", async () => {
    vi.mocked(listDriveFolderChildren).mockResolvedValue([
      { id: "f1", name: "Bylaws.docx", mimeType: "", modifiedTime: null, webViewLink: null, isFolder: false },
    ]);
    const { db } = fakeDb(ROOT);
    const result = await listLibraryDriveFolder(db, { userId: "u", workspace: "personal", kind: "precedents" });
    expect(result).toMatchObject({ ok: true, data: { folder: { id: "root1" } } });
    expect(driveFolderIsWithin).not.toHaveBeenCalled();
    expect(result.ok && result.data.files.map((f) => f.name)).toEqual(["Bylaws.docx"]);
  });
});

describe("setLibraryDriveFolder", () => {
  it("lets only a workspace admin choose a team workspace folder", async () => {
    vi.mocked(getOrgRole).mockResolvedValue("member" as never);
    const { db, writes } = fakeDb(null);
    const result = await setLibraryDriveFolder(db, {
      userId: "u",
      workspace: "org-1",
      kind: "matters",
      folderId: "abc",
    });
    expect(result).toMatchObject({ ok: false, kind: "forbidden" });
    expect(writes).toEqual([]);
  });

  it("stores the folder Drive reports, not the caller's name for it", async () => {
    vi.mocked(getOrgRole).mockResolvedValue("admin" as never);
    vi.mocked(getDriveFolder).mockResolvedValue({
      id: "abc",
      name: "Matters",
      mimeType: "",
      modifiedTime: null,
      webViewLink: null,
      isFolder: true,
    });
    const { db, writes } = fakeDb(null);
    await setLibraryDriveFolder(db, { userId: "u", workspace: "org-1", kind: "matters", folderId: "abc" });
    expect(writes.find((w) => w.op === "insert")?.value).toMatchObject({
      org_id: "org-1",
      kind: "matters",
      drive_folder_id: "abc",
      drive_folder_name: "Matters",
    });
  });
});

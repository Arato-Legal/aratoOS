import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({
  checkProjectAccess: vi.fn(),
  getOrgRole: vi.fn(),
}));
vi.mock("../../../lib/personalOrgs", () => ({
  teamOrgIdOf: vi.fn(async (_db: unknown, id: string | null) => id),
}));
vi.mock("../../../lib/integrations/googleDrive", () => ({
  WORK_IN_PROGRESS_FOLDER: "Work in progress",
  createDriveFolder: vi.fn(),
  getDriveFolder: vi.fn(),
  findWorkInProgressFolder: vi.fn(),
  listDriveFolderChildren: vi.fn(),
  isDriveId: (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v),
}));

import { checkProjectAccess } from "../../../lib/access";
import { createDriveFolder } from "../../../lib/integrations/googleDrive";
import { listSharedSiblingMatters } from "../../../lib/clientSharing";
import { createMatterDriveFolder, setMatterSharing } from "../clients.sharing";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";

// Each table answers with the rows queued for it, in call order.
function fakeDb(tables: Record<string, unknown[]>) {
  const updates: { table: string; patch: unknown }[] = [];
  const db = {
    from(table: string) {
      let isUpdate = false;
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then")
              return (r: (v: unknown) => unknown) =>
                r({ data: isUpdate ? null : (tables[table]?.[0] ?? []), error: null });
            if (prop === "maybeSingle" || prop === "single")
              return async () => ({ data: tables[table]?.shift() ?? null, error: null });
            return (...args: unknown[]) => {
              if (prop === "update") {
                isUpdate = true;
                updates.push({ table, patch: args[0] });
              }
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

describe("setMatterSharing", () => {
  it("requires a boolean", async () => {
    const { db } = fakeDb({});
    const r = await setMatterSharing(db, { userId: "me", projectId: PROJECT_ID, share: "yes" });
    expect(r.ok).toBe(false);
  });

  it("is refused below owner", async () => {
    access("editor");
    const { db, updates } = fakeDb({});
    const r = await setMatterSharing(db, { userId: "me", projectId: PROJECT_ID, share: false });
    expect(r.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("lets an owner switch it off", async () => {
    access("owner");
    const { db, updates } = fakeDb({});
    const r = await setMatterSharing(db, { userId: "me", projectId: PROJECT_ID, share: false });
    expect(r.ok).toBe(true);
    expect(updates[0].patch).toMatchObject({ share_with_client: false });
  });
});

describe("listSharedSiblingMatters", () => {
  it("is empty for a matter with no client", async () => {
    const { db } = fakeDb({ projects: [{ client_id: null, org_id: null }] });
    expect(await listSharedSiblingMatters(db, PROJECT_ID)).toEqual([]);
  });

  it("drops siblings from another workspace", async () => {
    const { db } = fakeDb({
      projects: [
        { client_id: CLIENT_ID, org_id: "org-a" },
        [
          { id: "a", name: "A", org_id: "org-a" },
          { id: "b", name: "B", org_id: "org-b" },
        ],
      ],
    });
    expect(await listSharedSiblingMatters(db, PROJECT_ID)).toEqual([{ id: "a", name: "A" }]);
  });
});

describe("createMatterDriveFolder", () => {
  it("needs a client", async () => {
    access("owner");
    const { db } = fakeDb({
      projects: [{ name: "M", cm_number: null, org_id: null, client_id: null, drive_folder_id: null }],
    });
    const r = await createMatterDriveFolder(db, { userId: "me", projectId: PROJECT_ID });
    expect(r.ok).toBe(false);
    expect(createDriveFolder).not.toHaveBeenCalled();
  });

  it("refuses when the matter already has a folder", async () => {
    access("owner");
    const { db } = fakeDb({
      projects: [{ name: "M", cm_number: null, org_id: null, client_id: CLIENT_ID, drive_folder_id: "abc" }],
    });
    const r = await createMatterDriveFolder(db, { userId: "me", projectId: PROJECT_ID });
    expect(r.ok).toBe(false);
    expect(createDriveFolder).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({
  getOrgRole: vi.fn(),
  isOrgAdmin: (r: string | null) => r === "owner" || r === "admin",
  checkProjectAccess: vi.fn(),
}));

vi.mock("../../../lib/memory/clientMemory", () => ({
  getClientMemory: vi.fn(),
  listSharedMatterNotes: vi.fn(),
  setClientMemoryEnabled: vi.fn(),
  writeClientMemory: vi.fn(),
}));

import { checkProjectAccess, getOrgRole } from "../../../lib/access";
import { getClientMemory, listSharedMatterNotes } from "../../../lib/memory/clientMemory";
import { readClientMemory, resolveClientMemoryAccess } from "../memory.client";

const UUID = "11111111-1111-4111-8111-111111111111";
const dbWith = (client: unknown) =>
  ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: client, error: null }) }) }),
    }),
  }) as never;

describe("resolveClientMemoryAccess", () => {
  it("hides a missing client and a malformed id", async () => {
    expect(await resolveClientMemoryAccess(dbWith(null), { clientId: UUID, userId: "u", requireEdit: false })).toEqual({ ok: false, status: 404 });
    expect(await resolveClientMemoryAccess(dbWith(null), { clientId: "nope", userId: "u", requireEdit: false })).toEqual({ ok: false, status: 404 });
  });

  it("lets a personal client's creator read and edit, and no one else", async () => {
    const db = dbWith({ user_id: "me", org_id: null });
    expect(await resolveClientMemoryAccess(db, { clientId: UUID, userId: "me", requireEdit: true })).toMatchObject({ ok: true, canEdit: true });
    expect(await resolveClientMemoryAccess(db, { clientId: UUID, userId: "other", requireEdit: false })).toEqual({ ok: false, status: 404 });
  });

  it("lets an org member read but not edit; an admin or the creator edits", async () => {
    const db = dbWith({ user_id: "creator", org_id: "org" });
    vi.mocked(getOrgRole).mockResolvedValue("member" as never);
    expect(await resolveClientMemoryAccess(db, { clientId: UUID, userId: "m", requireEdit: false })).toMatchObject({ ok: true, canEdit: false });
    expect(await resolveClientMemoryAccess(db, { clientId: UUID, userId: "m", requireEdit: true })).toEqual({ ok: false, status: 403 });
    vi.mocked(getOrgRole).mockResolvedValue("admin" as never);
    expect(await resolveClientMemoryAccess(db, { clientId: UUID, userId: "a", requireEdit: true })).toMatchObject({ ok: true, canEdit: true });
    vi.mocked(getOrgRole).mockResolvedValue("member" as never);
    expect(await resolveClientMemoryAccess(db, { clientId: UUID, userId: "creator", requireEdit: true })).toMatchObject({ ok: true, canEdit: true });
  });

  it("hides the client from a non-member", async () => {
    vi.mocked(getOrgRole).mockResolvedValue(null as never);
    expect(await resolveClientMemoryAccess(dbWith({ user_id: "c", org_id: "org" }), { clientId: UUID, userId: "x", requireEdit: false })).toEqual({ ok: false, status: 404 });
  });
});

describe("readClientMemory", () => {
  const base = { clientId: UUID, enabled: true, revision: 1, content: "BASE", sizeBytes: 4, updatedAt: null };
  const access = { clientId: UUID, canEdit: false, userId: "u" };
  const projectsDb = {
    from: () => ({
      select: () => ({
        in: async () => ({ data: [{ id: "open", name: "Open deal" }, { id: "closed", name: "Hidden deal" }], error: null }),
      }),
    }),
  } as never;

  it("shows the notes of sharing matters the reader can open, and names no other", async () => {
    vi.mocked(getClientMemory).mockResolvedValue(base);
    vi.mocked(listSharedMatterNotes).mockResolvedValue([
      { clientId: UUID, projectId: "open", revision: 1, content: "OPEN NOTE" },
      { clientId: UUID, projectId: "closed", revision: 1, content: "HIDDEN NOTE" },
    ]);
    vi.mocked(checkProjectAccess).mockImplementation((async (id: string) =>
      id === "open" ? { ok: true } : { ok: false }) as never);
    const view = await readClientMemory(projectsDb, access);
    expect(view.matter_notes).toEqual([{ project_id: "open", name: "Open deal", content: "OPEN NOTE" }]);
    expect(JSON.stringify(view)).not.toContain("HIDDEN");
    expect(JSON.stringify(view)).not.toContain("Hidden deal");
  });

  it("shows no notes while client memory is off", async () => {
    vi.mocked(getClientMemory).mockResolvedValue({ ...base, enabled: false });
    vi.mocked(listSharedMatterNotes).mockResolvedValue([{ clientId: UUID, projectId: "open", revision: 1, content: "N" }]);
    vi.mocked(checkProjectAccess).mockResolvedValue({ ok: true } as never);
    expect((await readClientMemory(projectsDb, access)).matter_notes).toEqual([]);
  });
});

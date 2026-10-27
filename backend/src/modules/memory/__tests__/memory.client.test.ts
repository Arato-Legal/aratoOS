import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({
  getOrgRole: vi.fn(),
  isOrgAdmin: (r: string | null) => r === "owner" || r === "admin",
  checkProjectAccess: vi.fn(),
}));

import { getOrgRole } from "../../../lib/access";
import { resolveClientMemoryAccess } from "../memory.client";

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

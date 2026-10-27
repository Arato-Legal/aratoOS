import { describe, expect, it, vi } from "vitest";

vi.mock("./access", () => ({
  checkProjectAccess: vi.fn(),
  getOrgRole: vi.fn(),
}));

import { checkProjectAccess, getOrgRole } from "./access";
import { checkClientAccess, listReadableClientMatters } from "./clientSharing";

// Each table answers with queued rows, in call order.
function fakeDb(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "maybeSingle") return async () => ({ data: tables[table]?.shift() ?? null, error: null });
            if (prop === "then") return (r: (v: unknown) => unknown) => r({ data: tables[table]?.[0] ?? [], error: null });
            return () => builder;
          },
        },
      );
      return builder;
    },
  } as any;
}

describe("checkClientAccess", () => {
  it("opens a personal client only to its creator", async () => {
    const db = () => fakeDb({ clients: [{ user_id: "me", org_id: null, name: "A" }] });
    expect((await checkClientAccess(db(), "c", "me")).ok).toBe(true);
    expect((await checkClientAccess(db(), "c", "other")).ok).toBe(false);
  });

  it("opens an organization client to its members", async () => {
    vi.mocked(getOrgRole).mockResolvedValueOnce("member" as never).mockResolvedValueOnce(null as never);
    const db = () => fakeDb({ clients: [{ user_id: "x", org_id: "org", name: "A" }] });
    expect((await checkClientAccess(db(), "c", "me")).ok).toBe(true);
    expect((await checkClientAccess(db(), "c", "me")).ok).toBe(false);
  });
});

describe("listReadableClientMatters", () => {
  it("keeps only sharing-on matters the caller can open, in the client's workspace", async () => {
    vi.mocked(getOrgRole).mockResolvedValue("member" as never);
    vi.mocked(checkProjectAccess).mockImplementation((async (id: string) =>
      id === "closed" ? { ok: false } : { ok: true }) as never);
    const db = fakeDb({
      clients: [{ user_id: "x", org_id: "org", name: "A" }],
      projects: [
        [
          { id: "open", name: "Open", org_id: "org" },
          { id: "closed", name: "Closed", org_id: "org" },
          { id: "elsewhere", name: "Elsewhere", org_id: "other-org" },
        ],
      ],
    });
    expect(await listReadableClientMatters(db, "c", "me", "me@example.com")).toEqual([
      { id: "open", name: "Open" },
    ]);
  });

  it("returns nothing when the caller cannot open the client", async () => {
    vi.mocked(getOrgRole).mockResolvedValue(null as never);
    const db = fakeDb({ clients: [{ user_id: "x", org_id: "org", name: "A" }] });
    expect(await listReadableClientMatters(db, "c", "me", null)).toEqual([]);
  });
});

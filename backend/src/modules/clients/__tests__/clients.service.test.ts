import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({
  checkProjectAccess: vi.fn(),
  getOrgRole: vi.fn(),
  isOrgAdmin: (role: string | null) => role === "owner" || role === "admin",
}));
vi.mock("../../../lib/personalOrgs", () => ({
  teamOrgIdOf: vi.fn(async (_db: unknown, id: string) => id),
}));

import { checkProjectAccess, getOrgRole } from "../../../lib/access";
import {
  addContact,
  createClient,
  deleteClient,
  getClient,
  setProjectClient,
  updateClient,
} from "../clients.service";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

// A chainable stand-in for the Supabase query builder: every method returns
// the builder, and awaiting (or .single/.maybeSingle) yields the table's
// scripted result.
function fakeDb(tables: Record<string, unknown>) {
  const calls: { table: string; op: string; payload?: unknown }[] = [];
  const db = {
    from(table: string) {
      const result = () => ({ data: tables[table] ?? null, error: null });
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then")
              return (res: (v: unknown) => unknown) => res(result());
            if (prop === "single" || prop === "maybeSingle")
              return async () => result();
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

const personalClient = {
  id: CLIENT_ID,
  user_id: "me",
  org_id: null,
  name: "Acme",
};

describe("clients.service", () => {
  it("rejects a client without a name", async () => {
    const { db } = fakeDb({});
    const result = await createClient(db, {
      userId: "me",
      workspace: null,
      body: { name: "  " },
    });
    expect(result).toMatchObject({ ok: false, kind: "validation" });
  });

  it("rejects an invalid status, kind and email", async () => {
    const { db } = fakeDb({ clients: personalClient });
    for (const body of [
      { name: "A", status: "won" },
      { name: "A", kind: "robot" },
      { name: "A", email: "not-an-email" },
      { name: "A", custom_fields: [] },
    ]) {
      const result = await createClient(db, { userId: "me", workspace: null, body });
      expect(result).toMatchObject({ ok: false, kind: "validation" });
    }
  });

  it("files a personal client under its creator with no org", async () => {
    const { db, calls } = fakeDb({ clients: personalClient });
    const result = await createClient(db, {
      userId: "me",
      workspace: "personal",
      body: { name: " Acme ", email: "a@b.co" },
    });
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      table: "clients",
      op: "insert",
      payload: { name: "Acme", email: "a@b.co", user_id: "me", org_id: null },
    });
  });

  it("hides another user's personal client as not found", async () => {
    const { db } = fakeDb({ clients: { ...personalClient, user_id: "someone-else" } });
    expect(await getClient(db, { userId: "me", clientId: CLIENT_ID })).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });

  it("treats a malformed id as not found without querying", async () => {
    const { db, calls } = fakeDb({});
    const result = await updateClient(db, {
      userId: "me",
      clientId: "nope",
      body: { name: "x" },
    });
    expect(result).toMatchObject({ ok: false, kind: "not_found" });
    expect(calls).toHaveLength(0);
  });

  it("hides an organization client from a non-member", async () => {
    vi.mocked(getOrgRole).mockResolvedValueOnce(null);
    const { db } = fakeDb({ clients: { ...personalClient, org_id: ORG_ID } });
    expect(await getClient(db, { userId: "me", clientId: CLIENT_ID })).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });

  it("lets only the creator or an org admin delete an org client", async () => {
    const orgClient = { ...personalClient, user_id: "creator", org_id: ORG_ID };
    vi.mocked(getOrgRole).mockResolvedValueOnce("member");
    const { db } = fakeDb({ clients: orgClient });
    expect(await deleteClient(db, { userId: "me", clientId: CLIENT_ID })).toMatchObject({
      ok: false,
      kind: "forbidden",
    });
    vi.mocked(getOrgRole).mockResolvedValueOnce("admin");
    expect(await deleteClient(db, { userId: "me", clientId: CLIENT_ID })).toMatchObject({
      ok: true,
    });
  });

  it("requires a contact name", async () => {
    const { db } = fakeDb({ clients: personalClient });
    expect(
      await addContact(db, { userId: "me", clientId: CLIENT_ID, body: {} }),
    ).toMatchObject({ ok: false, kind: "validation" });
  });

  describe("setProjectClient", () => {
    const project = (org_id: string | null, role = "owner") =>
      vi.mocked(checkProjectAccess).mockResolvedValueOnce({
        ok: true,
        isCreator: true,
        orgRole: null,
        projectRole: role,
        project: { id: PROJECT_ID, user_id: "me", org_id },
      } as never);

    it("needs the project owner right", async () => {
      project(null, "editor");
      const { db } = fakeDb({ clients: personalClient });
      expect(
        await setProjectClient(db, { userId: "me", projectId: PROJECT_ID, clientId: CLIENT_ID }),
      ).toMatchObject({ ok: false, kind: "forbidden" });
    });

    it("refuses a client from another workspace", async () => {
      project(ORG_ID);
      const { db, calls } = fakeDb({ clients: personalClient });
      expect(
        await setProjectClient(db, { userId: "me", projectId: PROJECT_ID, clientId: CLIENT_ID }),
      ).toMatchObject({ ok: false, kind: "validation" });
      expect(calls.some((c) => c.table === "projects")).toBe(false);
    });

    it("attaches and detaches within one workspace", async () => {
      project(null);
      const { db, calls } = fakeDb({ clients: personalClient });
      expect(
        await setProjectClient(db, { userId: "me", projectId: PROJECT_ID, clientId: CLIENT_ID }),
      ).toMatchObject({ ok: true, data: { client_id: CLIENT_ID } });
      expect(calls.at(-1)).toMatchObject({ table: "projects", op: "update" });

      project(null);
      expect(
        await setProjectClient(db, { userId: "me", projectId: PROJECT_ID, clientId: null }),
      ).toMatchObject({ ok: true, data: { client_id: null } });
    });
  });
});

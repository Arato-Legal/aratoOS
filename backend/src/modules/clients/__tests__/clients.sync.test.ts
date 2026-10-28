import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../projects/projects.service", () => ({ createProject: vi.fn() }));
vi.mock("../../../lib/memory/clientMemory", () => ({ deleteClientNotes: vi.fn() }));

import { createProject } from "../../projects/projects.service";
import { deleteClientNotes } from "../../../lib/memory/clientMemory";
import { upsertExternalClient, upsertExternalMatter, type SyncScope } from "../clients.sync";

type Scripted = { data: unknown; error?: unknown };
function fakeDb(script: Record<string, Scripted[]>) {
  const calls: { table: string; op: string; payload?: unknown }[] = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const db = {
    from(table: string) {
      const next = () => ({ error: null, ...(queues[table]?.shift() ?? { data: null }) });
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

const scope: SyncScope = { userId: "owner", orgId: "org1", source: "hubflo", matterVisibility: "private" };
const existingClient = {
  id: "c1",
  name: "Acme",
  kind: "organization",
  status: "active",
  email: "a@acme.test",
  external_synced_at: "2026-10-20T10:00:00Z",
};

beforeEach(() => vi.clearAllMocks());

describe("upsertExternalClient", () => {
  it("requires an external id and a name for a new client", async () => {
    const { db } = fakeDb({ clients: [{ data: null }] });
    expect(await upsertExternalClient(db, scope, { name: "A" })).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(await upsertExternalClient(db, scope, { external_id: "1" })).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(await upsertExternalClient(fakeDb({ clients: [{ data: null }] }).db, scope, { external_id: "1" })).toMatchObject({
      ok: false,
      detail: "name is required",
    });
  });

  it("creates a client with its external identity in the endpoint's workspace", async () => {
    const { db, calls } = fakeDb({ clients: [{ data: null }, { data: { id: "new" } }] });
    const result = await upsertExternalClient(db, scope, { external_id: " H-1 ", name: "Acme", status: "lead", email: "a@acme.test" });
    expect(result).toEqual({ ok: true, data: { outcome: "created", id: "new" } });
    expect(calls[0]).toMatchObject({
      table: "clients",
      op: "insert",
      payload: { name: "Acme", status: "lead", user_id: "owner", org_id: "org1", external_source: "hubflo", external_id: "H-1" },
    });
  });

  it("updates an existing client and reports unchanged when nothing differs", async () => {
    const changed = fakeDb({ clients: [{ data: existingClient }, { data: null }] });
    expect(await upsertExternalClient(changed.db, scope, { external_id: "1", status: "closed" })).toEqual({
      ok: true,
      data: { outcome: "updated", id: "c1" },
    });
    expect(changed.calls[0].payload).toMatchObject({ status: "closed" });

    const same = fakeDb({ clients: [{ data: existingClient }, { data: null }] });
    expect(await upsertExternalClient(same.db, scope, { external_id: "1", name: "Acme", email: "a@acme.test" })).toEqual({
      ok: true,
      data: { outcome: "unchanged", id: "c1" },
    });
    expect(same.calls[0].payload).not.toHaveProperty("updated_at");
  });

  it("ignores a push older than the last applied one", async () => {
    const { db, calls } = fakeDb({ clients: [{ data: existingClient }] });
    expect(await upsertExternalClient(db, scope, { external_id: "1", name: "Old", updated_at: "2026-10-19T00:00:00Z" })).toEqual({
      ok: true,
      data: { outcome: "stale", id: "c1" },
    });
    expect(calls).toHaveLength(0);
  });

  it("leaves unsent fields alone and clears a field sent as null", async () => {
    const { db, calls } = fakeDb({ clients: [{ data: existingClient }, { data: null }] });
    await upsertExternalClient(db, scope, { external_id: "1", email: null });
    expect(calls[0].payload).toMatchObject({ email: null });
    expect(calls[0].payload).not.toHaveProperty("name");
    expect(calls[0].payload).not.toHaveProperty("status");
  });

  it("retries once as an update when two pushes race to create the same client", async () => {
    const { db } = fakeDb({
      clients: [{ data: null }, { data: null, error: { code: "23505" } }, { data: existingClient }, { data: null }],
    });
    expect(await upsertExternalClient(db, scope, { external_id: "1", name: "Acme", status: "closed" })).toMatchObject({
      ok: true,
      data: { outcome: "updated" },
    });
  });

  it("upserts contacts by their external id and keeps ones not sent", async () => {
    const { db, calls } = fakeDb({
      clients: [{ data: existingClient }, { data: null }],
      client_contacts: [{ data: null }, { data: null }, { data: { id: "k1", name: "Jo", role: null, email: null, phone: null, notes: null } }, { data: null }],
    });
    const result = await upsertExternalClient(db, scope, {
      external_id: "1",
      contacts: [
        { external_id: "p1", name: "Pat", email: "pat@acme.test" },
        { external_id: "p2", role: "CFO" },
      ],
    });
    expect(result).toMatchObject({ ok: true, data: { outcome: "updated" } });
    expect(calls.filter((c) => c.table === "client_contacts").map((c) => c.op)).toEqual(["insert", "update"]);
    expect(calls.find((c) => c.table === "client_contacts" && c.op === "insert")?.payload).toMatchObject({
      client_id: "c1",
      external_id: "p1",
      name: "Pat",
    });
  });

  it("rejects a contact without an external id", async () => {
    const { db } = fakeDb({ clients: [{ data: existingClient }, { data: null }] });
    expect(await upsertExternalClient(db, scope, { external_id: "1", contacts: [{ name: "Pat" }] })).toMatchObject({
      ok: false,
      detail: "contacts[0]: external_id is required",
    });
  });
});

describe("upsertExternalMatter", () => {
  it("rejects a matter whose client was not synced", async () => {
    const { db } = fakeDb({ clients: [{ data: null }] });
    expect(
      await upsertExternalMatter(db, scope, { external_id: "M1", name: "Deal", client_external_id: "nope" }),
    ).toMatchObject({ ok: false, code: "client_not_found" });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("creates the matter as the endpoint's owner with the endpoint's visibility, then links identity and client", async () => {
    vi.mocked(createProject).mockResolvedValue({ ok: true, project: { id: "p1" } });
    const { db, calls } = fakeDb({ clients: [{ data: { id: "c1" } }], projects: [{ data: null }, { data: null }] });
    const result = await upsertExternalMatter(db, { ...scope, matterVisibility: "organization" }, {
      external_id: "M1",
      name: "Acme financing",
      cm_number: "2026-014",
      client_external_id: "C1",
    });
    expect(result).toEqual({ ok: true, data: { outcome: "created", id: "p1" } });
    expect(createProject).toHaveBeenCalledWith(db, {
      userId: "owner",
      name: "Acme financing",
      cm_number: "2026-014",
      practice: undefined,
      org_id: "org1",
      visibility: "organization",
    });
    expect(calls.find((c) => c.table === "projects" && c.op === "update")?.payload).toMatchObject({
      client_id: "c1",
      external_source: "hubflo",
      external_id: "M1",
    });
  });

  it("removes a half-made matter when its external identity cannot be saved", async () => {
    vi.mocked(createProject).mockResolvedValue({ ok: true, project: { id: "p1" } });
    const { db, calls } = fakeDb({ projects: [{ data: null }, { data: null, error: { code: "XX000" } }, { data: null }] });
    expect(await upsertExternalMatter(db, scope, { external_id: "M1", name: "Deal" })).toMatchObject({ ok: false, kind: "error" });
    expect(calls.at(-1)).toMatchObject({ table: "projects", op: "delete" });
  });

  it("maps an unusable owner to a conflict", async () => {
    vi.mocked(createProject).mockResolvedValue({ ok: false, kind: "validation", detail: "You are not a member of that organization." });
    const { db } = fakeDb({ projects: [{ data: null }] });
    expect(await upsertExternalMatter(db, scope, { external_id: "M1", name: "Deal" })).toMatchObject({
      ok: false,
      kind: "conflict",
      code: "endpoint_owner_unavailable",
    });
  });

  it("updates an existing matter, archives it, and skips stale pushes", async () => {
    const existing = { id: "p1", name: "Deal", cm_number: null, practice: null, client_id: null, archived_at: null, external_synced_at: "2026-10-20T10:00:00Z" };
    const archive = fakeDb({ projects: [{ data: existing }, { data: null }] });
    expect(await upsertExternalMatter(archive.db, scope, { external_id: "M1", archived: true })).toEqual({
      ok: true,
      data: { outcome: "updated", id: "p1" },
    });
    expect(archive.calls[0].payload).toHaveProperty("archived_at");
    expect(createProject).not.toHaveBeenCalled();

    const stale = fakeDb({ projects: [{ data: existing }] });
    expect(await upsertExternalMatter(stale.db, scope, { external_id: "M1", name: "Old", updated_at: "2026-10-01T00:00:00Z" })).toEqual({
      ok: true,
      data: { outcome: "stale", id: "p1" },
    });
  });

  it("unlinks the client when client_external_id is null", async () => {
    const existing = { id: "p1", name: "Deal", cm_number: null, practice: null, client_id: "c1", archived_at: null, external_synced_at: null };
    const { db, calls } = fakeDb({ projects: [{ data: existing }, { data: null }] });
    await upsertExternalMatter(db, scope, { external_id: "M1", client_external_id: null });
    expect(calls[0].payload).toMatchObject({ client_id: null });
    // What the matter taught its old client's memory goes with it.
    expect(deleteClientNotes).toHaveBeenCalledWith(expect.anything(), { projectId: "p1" });
  });

  it("keeps the matter's client-memory notes when its client does not change", async () => {
    const existing = { id: "p1", name: "Deal", cm_number: null, practice: null, client_id: "c1", archived_at: null, external_synced_at: null };
    const { db } = fakeDb({ projects: [{ data: existing }, { data: null }] });
    await upsertExternalMatter(db, scope, { external_id: "M1", practice: "Corporate" });
    expect(deleteClientNotes).not.toHaveBeenCalled();
  });
});

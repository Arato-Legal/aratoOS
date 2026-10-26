import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({
  getOrgRole: vi.fn(),
  isOrgAdmin: (r: string | null) => r === "owner" || r === "admin",
}));
vi.mock("../../../lib/personalOrgs", () => ({
  teamOrgIdOf: vi.fn(async (_db: unknown, id: string) => id),
}));
vi.mock("../../clients/clients.service", () => ({
  upsertExternalClient: vi.fn(),
  upsertExternalMatter: vi.fn(),
}));

import { getOrgRole } from "../../../lib/access";
import { upsertExternalClient, upsertExternalMatter } from "../../clients/clients.service";
import {
  MAX_EVENTS_PER_PUSH,
  createEndpoint,
  deleteEndpoint,
  hashSecret,
  listEndpoints,
  receivePush,
  rotateEndpointSecret,
} from "../crmSync.service";

const TOKEN = "ab".repeat(32);
const SECRET = "mike_whsec_test-secret";
const EP_ID = "11111111-1111-4111-8111-111111111111";
const ORG = "33333333-3333-4333-8333-333333333333";

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

const endpoint = {
  id: EP_ID,
  user_id: "owner",
  org_id: null,
  name: "Hubflo",
  provider: "hubflo",
  token: TOKEN,
  enabled: true,
  matter_visibility: "private",
  last_received_at: null,
  created_at: "2026-10-26T00:00:00Z",
  secret_hash: hashSecret(SECRET),
};

beforeEach(() => vi.clearAllMocks());

describe("receivePush authentication", () => {
  const denied = { ok: false, kind: "forbidden" };

  it("does not query for a malformed token or a missing secret", async () => {
    const { db, calls } = fakeDb({});
    expect(await receivePush(db, { token: "nope", secret: SECRET, body: {} })).toMatchObject(denied);
    expect(await receivePush(db, { token: TOKEN, secret: null, body: {} })).toMatchObject(denied);
    expect(calls).toHaveLength(0);
  });

  it("answers the same for an unknown token, a disabled endpoint and a wrong secret", async () => {
    const unknown = fakeDb({ crm_sync_endpoints: [{ data: null }] });
    expect(await receivePush(unknown.db, { token: TOKEN, secret: SECRET, body: { type: "client.upsert", data: {} } })).toEqual(
      await receivePush(fakeDb({ crm_sync_endpoints: [{ data: endpoint }] }).db, { token: TOKEN, secret: "wrong", body: { type: "client.upsert", data: {} } }),
    );
  });

  it("applies nothing before the secret is verified", async () => {
    const { db } = fakeDb({ crm_sync_endpoints: [{ data: endpoint }] });
    await receivePush(db, { token: TOKEN, secret: "wrong", body: { type: "client.upsert", data: { external_id: "1", name: "A" } } });
    expect(upsertExternalClient).not.toHaveBeenCalled();
  });
});

describe("receivePush processing", () => {
  const authed = () => fakeDb({ crm_sync_endpoints: [{ data: endpoint }, { data: null }], crm_sync_events: [{ data: null }, { data: null }] });

  it("rejects an empty or oversized push", async () => {
    expect(await receivePush(authed().db, { token: TOKEN, secret: SECRET, body: {} })).toMatchObject({ ok: false, kind: "validation" });
    const many = { events: Array.from({ length: MAX_EVENTS_PER_PUSH + 1 }, () => ({ type: "client.upsert", data: {} })) };
    expect(await receivePush(authed().db, { token: TOKEN, secret: SECRET, body: many })).toMatchObject({ ok: false, code: "too_many_events" });
  });

  it("applies clients before matters, reports each event, and logs outcomes only", async () => {
    const order: string[] = [];
    vi.mocked(upsertExternalClient).mockImplementation(async () => (order.push("client"), { ok: true, data: { outcome: "created", id: "c" } }));
    vi.mocked(upsertExternalMatter).mockImplementation(async () => (order.push("matter"), { ok: true, data: { outcome: "updated", id: "m" } }));
    const { db, calls } = authed();
    const result = await receivePush(db, {
      token: TOKEN,
      secret: SECRET,
      body: {
        events: [
          { type: "matter.upsert", data: { external_id: "M1", name: "Matter" } },
          { type: "client.upsert", data: { external_id: "C1", name: "Acme", email: "secret@acme.test" } },
        ],
      },
    });
    expect(order).toEqual(["client", "matter"]);
    expect(result).toMatchObject({
      ok: true,
      data: {
        results: [
          { index: 0, type: "matter.upsert", external_id: "M1", outcome: "updated" },
          { index: 1, type: "client.upsert", external_id: "C1", outcome: "created" },
        ],
        summary: { created: 1, updated: 1, rejected: 0 },
      },
    });
    const logged = calls.find((c) => c.table === "crm_sync_events" && c.op === "insert");
    expect(JSON.stringify(logged?.payload)).not.toContain("secret@acme.test");
    expect(JSON.stringify(logged?.payload)).not.toContain("Acme");
  });

  it("accepts a single bare event and rejects unknown types without failing the push", async () => {
    vi.mocked(upsertExternalClient).mockResolvedValue({ ok: true, data: { outcome: "unchanged", id: "c" } });
    const single = await receivePush(authed().db, { token: TOKEN, secret: SECRET, body: { type: "client.upsert", data: { external_id: "C1", name: "A" } } });
    expect(single).toMatchObject({ ok: true, data: { summary: { unchanged: 1 } } });

    const mixed = await receivePush(authed().db, {
      token: TOKEN,
      secret: SECRET,
      body: { events: [{ type: "invoice.upsert", data: {} }, { type: "client.upsert", data: { external_id: "C2", name: "B" } }] },
    });
    expect(mixed).toMatchObject({
      ok: true,
      data: { results: [{ outcome: "rejected", error_code: "unknown_event_type" }, { outcome: "unchanged" }], summary: { rejected: 1 } },
    });
  });

  it("reports a validation failure per event with its code, and hides internal errors", async () => {
    vi.mocked(upsertExternalClient)
      .mockResolvedValueOnce({ ok: false, kind: "validation", detail: "name is required", code: "invalid_payload" })
      .mockResolvedValueOnce({ ok: false, kind: "error", error: new Error("db password leaked") });
    const result = await receivePush(authed().db, {
      token: TOKEN,
      secret: SECRET,
      body: { events: [{ type: "client.upsert", data: { external_id: "1" } }, { type: "client.upsert", data: { external_id: "2", name: "B" } }] },
    });
    expect(result).toMatchObject({
      ok: true,
      data: { results: [{ error_code: "invalid_payload", detail: "name is required" }, { error_code: "internal_error", detail: "This event could not be processed." }] },
    });
    expect(JSON.stringify(result)).not.toContain("leaked");
  });

  it("refuses a push when the endpoint's owner left the organization", async () => {
    vi.mocked(getOrgRole).mockResolvedValueOnce(null);
    const { db } = fakeDb({ crm_sync_endpoints: [{ data: { ...endpoint, org_id: ORG } }] });
    expect(
      await receivePush(db, { token: TOKEN, secret: SECRET, body: { type: "client.upsert", data: {} } }),
    ).toMatchObject({ ok: false, kind: "conflict", code: "endpoint_owner_unavailable" });
    expect(upsertExternalClient).not.toHaveBeenCalled();
  });

  it("scopes the upsert to the endpoint's workspace and provider", async () => {
    vi.mocked(getOrgRole).mockResolvedValue("admin");
    vi.mocked(upsertExternalMatter).mockResolvedValue({ ok: true, data: { outcome: "created", id: "m" } });
    const { db } = fakeDb({
      crm_sync_endpoints: [{ data: { ...endpoint, org_id: ORG, matter_visibility: "organization" } }, { data: null }],
      crm_sync_events: [{ data: null }, { data: null }],
    });
    await receivePush(db, { token: TOKEN, secret: SECRET, body: { type: "matter.upsert", data: { external_id: "M", name: "X" } } });
    expect(upsertExternalMatter).toHaveBeenCalledWith(
      db,
      { userId: "owner", orgId: ORG, source: "hubflo", matterVisibility: "organization" },
      { external_id: "M", name: "X" },
    );
  });
});

describe("managing endpoints", () => {
  it("shows the secret only on creation and never returns the stored hash or user id", async () => {
    const { db, calls } = fakeDb({ crm_sync_endpoints: [{ data: endpoint }] });
    const result = await createEndpoint(db, { userId: "owner", workspace: "personal", body: { name: "Hubflo" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.secret).toMatch(/^mike_whsec_/);
    expect(JSON.stringify(result.data.endpoint)).not.toContain("secret_hash");
    expect(result.data.endpoint).not.toHaveProperty("token");
    expect(result.data.endpoint.webhook_path).toBe(`/webhooks/crm/${TOKEN}`);
    const insert = calls.find((c) => c.op === "insert")?.payload as { secret_hash: string };
    expect(insert.secret_hash).toBe(hashSecret(result.data.secret));
    expect(insert.secret_hash).not.toContain("mike_whsec_");
  });

  it("limits organization endpoints to admins and validates input", async () => {
    vi.mocked(getOrgRole).mockResolvedValue("member");
    const { db } = fakeDb({});
    expect(await createEndpoint(db, { userId: "u", workspace: ORG, body: { name: "x" } })).toMatchObject({ ok: false, kind: "forbidden" });
    expect(await listEndpoints(db, { userId: "u", workspace: ORG })).toMatchObject({ ok: false, kind: "forbidden" });
    expect(await createEndpoint(db, { userId: "u", workspace: "personal", body: {} })).toMatchObject({ ok: false, kind: "validation" });
    expect(await createEndpoint(db, { userId: "u", workspace: "personal", body: { name: "x", provider: "other" } })).toMatchObject({ ok: false, kind: "validation" });
    expect(await createEndpoint(db, { userId: "u", workspace: "personal", body: { name: "x", matter_visibility: "organization" } })).toMatchObject({ ok: false, kind: "validation" });
  });

  it("hides another person's personal endpoint and honours admin rights on an org one", async () => {
    const { db } = fakeDb({ crm_sync_endpoints: [{ data: endpoint }] });
    expect(await deleteEndpoint(db, { userId: "intruder", endpointId: EP_ID })).toMatchObject({ ok: false, kind: "not_found" });

    vi.mocked(getOrgRole).mockResolvedValue("member");
    const org = fakeDb({ crm_sync_endpoints: [{ data: { ...endpoint, org_id: ORG } }] });
    expect(await deleteEndpoint(org.db, { userId: "m", endpointId: EP_ID })).toMatchObject({ ok: false, kind: "not_found" });

    vi.mocked(getOrgRole).mockResolvedValue("admin");
    const admin = fakeDb({ crm_sync_endpoints: [{ data: { ...endpoint, org_id: ORG } }, { data: null }] });
    expect(await deleteEndpoint(admin.db, { userId: "a", endpointId: EP_ID })).toMatchObject({ ok: true });
  });

  it("rotating stores a new hash and returns the new secret once", async () => {
    const { db, calls } = fakeDb({ crm_sync_endpoints: [{ data: endpoint }, { data: endpoint }] });
    const result = await rotateEndpointSecret(db, { userId: "owner", endpointId: EP_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const update = calls.find((c) => c.op === "update")?.payload as { secret_hash: string };
    expect(update.secret_hash).toBe(hashSecret(result.data.secret));
    expect(update.secret_hash).not.toBe(hashSecret(SECRET));
  });
});

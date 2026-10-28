import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({
  getOrgRole: vi.fn(),
  isOrgAdmin: (r: string | null) => r === "owner" || r === "admin",
}));
vi.mock("../../../lib/personalOrgs", () => ({
  teamOrgIdOf: vi.fn(async (_db: unknown, id: string | null) => id),
}));

import { getOrgRole } from "../../../lib/access";
import {
  driveOwnerFor,
  hubfloLinks,
  updateIntegrationSettings,
} from "../clients.integrations";

function fakeDb(rows: Record<string, unknown>) {
  const upserts: unknown[] = [];
  const db = {
    from(table: string) {
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "maybeSingle") return async () => ({ data: rows[table] ?? null, error: null });
            if (prop === "then") return (r: (v: unknown) => unknown) => r({ data: null, error: null });
            return (...args: unknown[]) => {
              if (prop === "upsert") upserts.push(args[0]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { db: db as any, upserts };
}

describe("hubfloLinks", () => {
  const settings = {
    org_integration_settings: {
      hubflo_client_url: "https://portal.example/clients/{id}",
      hubflo_matter_url: null,
      hubflo_contact_url: null,
      drive_owner_user_id: null,
    },
  };

  it("builds a link only for rows synced from hubflo", async () => {
    const { db } = fakeDb(settings);
    const links = await hubfloLinks(db, "org");
    expect(links.link("client", "hubflo", "a b")).toBe("https://portal.example/clients/a%20b");
    expect(links.link("client", "generic", "x")).toBeNull();
    expect(links.link("client", null, "x")).toBeNull();
    expect(links.link("matter", "hubflo", "x")).toBeNull();
  });

  it("is always null without a workspace", async () => {
    const { db } = fakeDb({});
    expect((await hubfloLinks(db, null)).link("client", "hubflo", "x")).toBeNull();
  });
});

describe("driveOwnerFor", () => {
  it("uses the shared connection owner in a team workspace", async () => {
    const { db } = fakeDb({ org_integration_settings: { drive_owner_user_id: "admin-1" } });
    expect(await driveOwnerFor(db, "member", "org")).toEqual({ userId: "admin-1", orgId: "org" });
  });
  it("falls back to the caller", async () => {
    const { db } = fakeDb({});
    expect(await driveOwnerFor(db, "member", "org")).toEqual({ userId: "member", orgId: "org" });
    expect(await driveOwnerFor(db, "member", null)).toEqual({ userId: "member", orgId: null });
  });
});

describe("updateIntegrationSettings", () => {
  it("is admin only", async () => {
    vi.mocked(getOrgRole).mockResolvedValue("member" as never);
    const { db, upserts } = fakeDb({});
    const r = await updateIntegrationSettings(db, { userId: "u", workspace: "org", body: { hubflo_client_url: "https://x/{id}" } });
    expect(r.ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it.each([
    ["http://x/{id}"],
    ["https://x/no-placeholder"],
    ["javascript:alert({id})"],
  ])("rejects template %s", async (url) => {
    vi.mocked(getOrgRole).mockResolvedValue("owner" as never);
    const { db, upserts } = fakeDb({});
    const r = await updateIntegrationSettings(db, { userId: "u", workspace: "org", body: { hubflo_client_url: url } });
    expect(r.ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("saves a valid template", async () => {
    vi.mocked(getOrgRole).mockResolvedValue("admin" as never);
    const { db, upserts } = fakeDb({});
    const r = await updateIntegrationSettings(db, { userId: "u", workspace: "org", body: { hubflo_client_url: "https://app.hubflo.com/c/{id}" } });
    expect(r.ok).toBe(true);
    expect(upserts[0]).toMatchObject({ org_id: "org", hubflo_client_url: "https://app.hubflo.com/c/{id}" });
  });

  it("will not share Drive without a connection", async () => {
    vi.mocked(getOrgRole).mockResolvedValue("owner" as never);
    const { db, upserts } = fakeDb({});
    const r = await updateIntegrationSettings(db, { userId: "u", workspace: "org", body: { drive_shared: true } });
    expect(r.ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.SUPABASE_URL = "http://supabase.test.local";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.SUPABASE_SECRET_KEY = "test-service-key";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: () => ({}), rpc: async () => ({}), auth: {} })),
}));

const receivePush = vi.hoisted(() => vi.fn());
vi.mock("../../modules/crm-sync/crmSync.service", async (orig) => ({
  ...(await orig<typeof import("../../modules/crm-sync/crmSync.service")>()),
  receivePush,
}));

import { app } from "../../app";

const TOKEN = "ab".repeat(32);

beforeEach(() => receivePush.mockReset());

describe("POST /webhooks/crm/:token", () => {
  it("passes the bearer secret, token and body to the receiver and returns its result", async () => {
    receivePush.mockResolvedValue({
      ok: true,
      data: { results: [], summary: { created: 1, updated: 0, unchanged: 0, stale: 0, rejected: 0 } },
    });
    const body = { type: "client.upsert", data: { external_id: "1", name: "A" } };
    const res = await request(app)
      .post(`/webhooks/crm/${TOKEN}`)
      .set("Authorization", "Bearer mike_whsec_abc")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(1);
    expect(receivePush).toHaveBeenCalledWith(expect.anything(), {
      token: TOKEN,
      secret: "mike_whsec_abc",
      body,
    });
  });

  it("answers one generic 401 for any authentication failure, without a session", async () => {
    receivePush.mockResolvedValue({ ok: false, kind: "forbidden", detail: "Unauthorized" });
    const res = await request(app).post(`/webhooks/crm/${TOKEN}`).send({ type: "client.upsert" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: "Unauthorized" });
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(receivePush.mock.calls[0][1].secret).toBeNull();
  });

  it("only reads an Authorization header of the Bearer form", async () => {
    receivePush.mockResolvedValue({ ok: false, kind: "forbidden", detail: "Unauthorized" });
    await request(app).post(`/webhooks/crm/${TOKEN}`).set("Authorization", "Basic abc").send({});
    expect(receivePush.mock.calls[0][1].secret).toBeNull();
  });

  it("reports a bad payload as 400", async () => {
    receivePush.mockResolvedValue({ ok: false, kind: "validation", detail: "Send an events list", code: "invalid_payload" });
    const res = await request(app)
      .post(`/webhooks/crm/${TOKEN}`)
      .set("Authorization", "Bearer s")
      .send({});
    expect(res.status).toBe(400);
  });

  it("refuses a body over the webhook's size cap before any processing", async () => {
    const big = { events: [{ type: "client.upsert", data: { notes: "x".repeat(600 * 1024) } }] };
    const res = await request(app)
      .post(`/webhooks/crm/${TOKEN}`)
      .set("Authorization", "Bearer s")
      .send(big);
    expect(res.status).toBe(413);
    expect(receivePush).not.toHaveBeenCalled();
  });

  it("requires sign-in for the management API", async () => {
    const res = await request(app).get("/crm-sync/endpoints");
    expect(res.status).toBe(401);
  });
});

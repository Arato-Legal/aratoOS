import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/access", () => ({ getOrgRole: vi.fn() }));
vi.mock("../../../lib/personalOrgs", () => ({
  teamOrgIdOf: vi.fn(async (_db: unknown, id: string) => id),
}));
vi.mock("../../clients/clients.service", () => ({ createClient: vi.fn() }));

import { getOrgRole } from "../../../lib/access";
import { createClient } from "../../clients/clients.service";
import {
  MAX_PENDING_PER_FORM,
  approveSubmission,
  getPublicForm,
  rejectSubmission,
  submitPublicForm,
} from "../intake.service";

const TOKEN = "a".repeat(64);
const FORM_ID = "11111111-1111-4111-8111-111111111111";
const SUB_ID = "22222222-2222-4222-8222-222222222222";

// Chainable stand-in for the query builder: `script[table]` is a list of
// results consumed one per awaited query on that table.
function fakeDb(script: Record<string, unknown[]>) {
  const calls: { table: string; op: string; payload?: unknown }[] = [];
  const queues = Object.fromEntries(
    Object.entries(script).map(([k, v]) => [k, [...v]]),
  );
  const db = {
    from(table: string) {
      let op = "select";
      const next = () => {
        const r = queues[table]?.shift() ?? { data: null, error: null };
        return r as { data: unknown; error: unknown; count?: number };
      };
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then")
              return (res: (v: unknown) => unknown) => res(next());
            if (prop === "single" || prop === "maybeSingle")
              return async () => next();
            return (...args: unknown[]) => {
              if (["insert", "update", "delete"].includes(prop)) {
                op = prop;
                calls.push({ table, op, payload: args[0] });
              }
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

const form = {
  id: FORM_ID,
  user_id: "me",
  org_id: null,
  name: "Website",
  title: "Contact us",
  description: null,
  token: TOKEN,
  enabled: true,
};
const sub = {
  id: SUB_ID,
  form_id: FORM_ID,
  name: "Pat",
  email: "pat@x.co",
  phone: null,
  message: "Help",
  status: "pending",
};

describe("public intake", () => {
  it("never queries for a malformed token", async () => {
    const { db, calls } = fakeDb({});
    expect(await getPublicForm(db, "nope")).toMatchObject({ ok: false, kind: "not_found" });
    expect(calls).toHaveLength(0);
  });

  it("exposes only the title and description", async () => {
    const { db } = fakeDb({ intake_forms: [{ data: form, error: null }] });
    expect(await getPublicForm(db, TOKEN)).toEqual({
      ok: true,
      data: { title: "Contact us", description: null },
    });
  });

  it("silently drops honeypot submissions", async () => {
    const { db, calls } = fakeDb({ intake_forms: [{ data: form, error: null }] });
    const result = await submitPublicForm(db, {
      token: TOKEN,
      body: { name: "Bot", email: "b@x.co", website: "http://spam" },
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("requires a name and a way to reach the person", async () => {
    for (const body of [
      { email: "a@b.co" },
      { name: "Pat" },
      { name: "Pat", email: "not-an-email" },
      { name: "Pat", email: "a@b.co", message: "x".repeat(5001) },
    ]) {
      const { db } = fakeDb({ intake_forms: [{ data: form, error: null }] });
      expect(await submitPublicForm(db, { token: TOKEN, body })).toMatchObject({
        ok: false,
        kind: "validation",
      });
    }
  });

  it("refuses new submissions once the pending queue is full", async () => {
    const { db } = fakeDb({
      intake_forms: [{ data: form, error: null }],
      form_submissions: [{ data: null, error: null, count: MAX_PENDING_PER_FORM }],
    });
    expect(
      await submitPublicForm(db, { token: TOKEN, body: { name: "Pat", email: "a@b.co" } }),
    ).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("stores a valid submission", async () => {
    const { db, calls } = fakeDb({
      intake_forms: [{ data: form, error: null }],
      form_submissions: [
        { data: null, error: null, count: 0 },
        { data: null, error: null },
      ],
    });
    const result = await submitPublicForm(db, {
      token: TOKEN,
      body: { name: " Pat ", email: "a@b.co", message: "Hello" },
    });
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.op === "insert")).toMatchObject({
      table: "form_submissions",
      payload: { form_id: FORM_ID, name: "Pat", email: "a@b.co", message: "Hello" },
    });
  });
});

describe("review", () => {
  it("hides a submission of a form the caller cannot reach", async () => {
    const { db } = fakeDb({
      form_submissions: [{ data: sub, error: null }],
      intake_forms: [{ data: { ...form, user_id: "someone-else" }, error: null }],
    });
    expect(await rejectSubmission(db, { userId: "me", submissionId: SUB_ID })).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });

  it("hides a submission from a non-member of the form's organization", async () => {
    vi.mocked(getOrgRole).mockResolvedValueOnce(null);
    const { db } = fakeDb({
      form_submissions: [{ data: sub, error: null }],
      intake_forms: [{ data: { ...form, org_id: "o1" }, error: null }],
    });
    expect(await approveSubmission(db, { userId: "me", submissionId: SUB_ID })).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });

  it("answers 409 when the submission was already reviewed", async () => {
    const { db } = fakeDb({
      form_submissions: [
        { data: sub, error: null },
        { data: null, error: null },
      ],
      intake_forms: [{ data: form, error: null }],
    });
    expect(await rejectSubmission(db, { userId: "me", submissionId: SUB_ID })).toMatchObject({
      ok: false,
      kind: "conflict",
    });
  });

  it("approving creates a lead client and links it", async () => {
    vi.mocked(createClient).mockResolvedValueOnce({
      ok: true,
      data: { id: "c1", name: "Pat" } as never,
    });
    const { db } = fakeDb({
      form_submissions: [
        { data: sub, error: null },
        { data: { ...sub, status: "approved" }, error: null },
        { data: { ...sub, status: "approved", client_id: "c1" }, error: null },
      ],
      intake_forms: [{ data: form, error: null }],
    });
    const result = await approveSubmission(db, { userId: "me", submissionId: SUB_ID });
    expect(result).toMatchObject({ ok: true, data: { client: { id: "c1" } } });
    expect(createClient).toHaveBeenLastCalledWith(
      db,
      expect.objectContaining({
        userId: "me",
        workspace: "personal",
        body: expect.objectContaining({ status: "lead", kind: "individual", name: "Pat" }),
      }),
    );
  });

  it("returns the submission to pending when the client cannot be created", async () => {
    vi.mocked(createClient).mockResolvedValueOnce({
      ok: false,
      kind: "validation",
      detail: "bad",
    });
    const { db, calls } = fakeDb({
      form_submissions: [
        { data: sub, error: null },
        { data: { ...sub, status: "approved" }, error: null },
        { data: null, error: null },
      ],
      intake_forms: [{ data: form, error: null }],
    });
    const result = await approveSubmission(db, { userId: "me", submissionId: SUB_ID });
    expect(result.ok).toBe(false);
    expect(calls.at(-1)).toMatchObject({
      table: "form_submissions",
      op: "update",
      payload: { status: "pending" },
    });
  });
});

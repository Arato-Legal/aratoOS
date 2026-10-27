import { beforeEach, expect, it, vi } from "vitest";
import type { DocIndex, DocStore } from "../../types";
import type { Db } from "../../../../../lib/supabase";

const mocks = vi.hoisted(() => ({
  createReview: vi.fn(),
  readable: vi.fn(),
  review: vi.fn(),
}));
vi.mock("../../../../../lib/clientSharing", () => ({
  listReadableClientMatters: mocks.readable,
}));
vi.mock("../../../../playbooks/playbooks.service", async (load) => ({
  ...(await load<typeof import("../../../../playbooks/playbooks.service")>()),
  reviewWithPlaybook: mocks.review,
}));

import { runToolCalls } from "../toolDispatcher";
import { registerTabularReviewCreator } from "../tabularCreate";

beforeEach(() => {
  vi.resetAllMocks();
  registerTabularReviewCreator(mocks.createReview as never);
});

const call = (name: string, args: unknown) => [
  { id: "c", function: { name, arguments: JSON.stringify(args) } },
];
const sharedStore = (): [DocStore, DocIndex] => [
  new Map([
    ["shared-0", { storage_path: "p", file_type: "docx", filename: "Other.docx", read_only: true }],
  ]),
  { "shared-0": { document_id: "d1", filename: "Other.docx" } },
];
const content = (r: { toolResults: unknown[] }) =>
  JSON.parse((r.toolResults[0] as { content: string }).content);

it("refuses to run a playbook in place on another matter's document", async () => {
  const [store, index] = sharedStore();
  const r = await runToolCalls(
    call("run_playbook", { playbook_id: "p", doc_id: "shared-0" }) as never,
    store, "u", {} as Db, () => {}, undefined, undefined, index,
    undefined, undefined, "proj", undefined, undefined, "n", { model: "m" },
  );
  expect(content(r).error).toContain("read-only");
  expect(mocks.review).not.toHaveBeenCalled();
});

it("refuses to edit another matter's document in place", async () => {
  const [store, index] = sharedStore();
  const r = await runToolCalls(
    call("edit_document", { doc_id: "shared-0", edits: [{ find: "a", replace: "b" }] }) as never,
    store, "u", {} as Db, () => {}, undefined, undefined, index,
    undefined, undefined, "proj", undefined, undefined, "n", {},
  );
  expect(content(r).error).toContain("read-only");
});

it("creates a review in the current matter", async () => {
  mocks.createReview.mockResolvedValue({ ok: true, data: { id: "rev", title: "T" } });
  const [store, index] = sharedStore();
  const r = await runToolCalls(
    call("create_tabular_review", {
      title: "T",
      doc_ids: ["shared-0"],
      columns: [{ name: "Term", prompt: "What is the term?" }],
    }) as never,
    store, "u", {} as Db, () => {}, undefined, undefined, index,
    undefined, undefined, "proj", undefined, undefined, "n", { model: "m", userEmail: "u@x" },
  );
  expect(mocks.createReview).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ project_id: "proj", document_ids: ["d1"], model: "m" }),
  );
  expect(content(r).link).toBe("/matters/proj/tabular-reviews/rev");
});

it("in a client session needs a readable matter's name and saves there", async () => {
  mocks.readable.mockResolvedValue([{ id: "m9", name: "Big Deal" }]);
  mocks.createReview.mockResolvedValue({ ok: true, data: { id: "rev" } });
  const [store, index] = sharedStore();
  const args = {
    doc_ids: ["shared-0"],
    columns: [{ name: "Term", prompt: "Term?" }],
  };
  const run = (extra: object) =>
    runToolCalls(
      call("create_tabular_review", { ...args, ...extra }) as never,
      store, "u", {} as Db, () => {}, undefined, undefined, index,
      undefined, undefined, null, undefined, undefined, "n",
      { model: "m", clientId: "c1" },
    );
  const missing = await run({});
  expect(content(missing).error).toContain("Big Deal");
  expect(mocks.createReview).not.toHaveBeenCalled();
  const saved = await run({ matter_name: "big deal" });
  expect(mocks.createReview).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ project_id: "m9" }),
  );
  expect(content(saved).link).toBe("/matters/m9/tabular-reviews/rev");
});

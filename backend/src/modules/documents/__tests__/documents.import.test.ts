import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
  uploadFile: vi.fn(async () => undefined),
  deleteFileBestEffort: vi.fn(async () => undefined),
  storageKey: (u: string, d: string, f: string) => `documents/${u}/${d}/${f}`,
  versionStorageKey: (u: string, d: string, s: string, f: string) => `documents/${u}/${d}/versions/${s}/${f}`,
}));
vi.mock("../documents.lifecycle", () => ({ createDocumentVersion: vi.fn() }));

import { deleteFileBestEffort, uploadFile } from "../../../lib/storage";
import { createDocumentVersion } from "../documents.lifecycle";
import { addDocxVersionToDocument, createDocumentFromDocxBytes } from "../documents.import";

function fakeDb(insertResult: { data: unknown; error: unknown }) {
  const deleted: string[] = [];
  const db = {
    from() {
      const builder: any = {
        insert: () => builder,
        select: () => builder,
        single: async () => insertResult,
        delete: () => ({ eq: async (_c: string, id: string) => void deleted.push(id) }),
      };
      return builder;
    },
  };
  return { db: db as any, deleted };
}

beforeEach(() => vi.clearAllMocks());

describe("createDocumentFromDocxBytes", () => {
  it("rejects an empty file without touching storage", async () => {
    const { db } = fakeDb({ data: { id: "d" }, error: null });
    expect(
      await createDocumentFromDocxBytes(db, { userId: "u", projectId: "p", name: "a", bytes: Buffer.alloc(0) }),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("stores the bytes, adds a .docx extension and records a version", async () => {
    vi.mocked(createDocumentVersion).mockResolvedValue({ data: { id: "v1" }, error: null } as never);
    const { db } = fakeDb({ data: { id: "doc1" }, error: null });
    const result = await createDocumentFromDocxBytes(db, {
      userId: "u",
      projectId: "p",
      name: "Draft/SPA",
      bytes: Buffer.from("x"),
    });
    expect(result).toMatchObject({ ok: true, data: { documentId: "doc1", versionId: "v1", filename: "Draft_SPA.docx" } });
    expect(createDocumentVersion).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ document_id: "doc1", file_type: "docx", source: "upload" }),
    );
  });

  it("removes the document and file when the version cannot be recorded", async () => {
    vi.mocked(createDocumentVersion).mockResolvedValue({ data: null, error: { message: "boom" } } as never);
    const { db, deleted } = fakeDb({ data: { id: "doc1" }, error: null });
    const result = await createDocumentFromDocxBytes(db, {
      userId: "u",
      projectId: "p",
      name: "a.docx",
      bytes: Buffer.from("x"),
    });
    expect(result.ok).toBe(false);
    expect(deleted).toEqual(["doc1"]);
    expect(deleteFileBestEffort).toHaveBeenCalled();
  });
});

describe("addDocxVersionToDocument", () => {
  it("uploads under the version key and activates a new version", async () => {
    vi.mocked(createDocumentVersion).mockResolvedValue({ data: { id: "v2" }, error: null } as never);
    const { db } = fakeDb({ data: null, error: null });
    const result = await addDocxVersionToDocument(db, {
      userId: "u",
      documentId: "doc1",
      name: "Draft",
      bytes: Buffer.from("x"),
    });
    expect(result).toMatchObject({ ok: true, data: { versionId: "v2", filename: "Draft.docx" } });
    expect(vi.mocked(uploadFile).mock.calls[0][0]).toMatch(/^documents\/u\/doc1\/versions\//);
  });
});

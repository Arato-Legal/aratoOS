import { describe, expect, it } from "vitest";
import {
  MemoryDisabledError,
  MemoryRevisionConflictError,
  MemoryValidationError,
} from "../files";
import {
  getClientMemory,
  loadClientMemoryForPrompt,
  setClientMemoryEnabled,
  writeClientMemory,
} from "../clientMemory";

// An in-memory stand-in for client_memory_files with the CAS the real update does.
function fakeDb(initial?: Partial<{ enabled: boolean; revision: number; content: string; last_source_job_id: string | null }>) {
  let row: Record<string, unknown> | null = initial
    ? { client_id: "c", enabled: true, revision: 0, content: "", size_bytes: 0, updated_at: null, last_source_job_id: null, ...initial }
    : null;
  const db = {
    from() {
      let mode: "select" | "update" | "upsert" = "select";
      let patch: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      const q: any = {
        select: () => q,
        update: (p: Record<string, unknown>) => { mode = "update"; patch = p; return q; },
        upsert: () => {
          row ??= { client_id: "c", enabled: true, revision: 0, content: "", size_bytes: 0, updated_at: null, last_source_job_id: null };
          return Promise.resolve({ error: null });
        },
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        maybeSingle: async () => ({ data: row, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (mode === "update" && row && Object.entries(filters).every(([k, v]) => row![k] === v)) {
            row = { ...row, ...patch };
            return resolve({ data: [row], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return q;
    },
  };
  return { db: db as any, get row() { return row; } };
}

describe("client memory store", () => {
  it("creates an empty, enabled file on first touch", async () => {
    const { db } = fakeDb();
    const memory = await getClientMemory(db, "c");
    expect(memory).toMatchObject({ enabled: true, revision: 0, content: "" });
  });

  it("writes with compare-and-swap and bumps the revision", async () => {
    const f = fakeDb({ revision: 3 });
    const { applied, memory } = await writeClientMemory(f.db, {
      clientId: "c", content: "# Acme\n- Uses Net 30", expectedRevision: 3, updatedBy: "u",
    });
    expect(applied).toBe(true);
    expect(memory.revision).toBe(4);
    expect(f.row?.content).toBe("# Acme\n- Uses Net 30");
  });

  it("refuses a stale revision", async () => {
    const { db } = fakeDb({ revision: 5 });
    await expect(
      writeClientMemory(db, { clientId: "c", content: "x", expectedRevision: 4, updatedBy: "u" }),
    ).rejects.toBeInstanceOf(MemoryRevisionConflictError);
  });

  it("refuses writes while it is off", async () => {
    const { db } = fakeDb({ enabled: false });
    await expect(
      writeClientMemory(db, { clientId: "c", content: "x", expectedRevision: 0, updatedBy: "u" }),
    ).rejects.toBeInstanceOf(MemoryDisabledError);
  });

  it("rejects executable HTML", async () => {
    const { db } = fakeDb();
    await expect(
      writeClientMemory(db, { clientId: "c", content: "<script>x</script>", expectedRevision: 0, updatedBy: "u" }),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it("is a no-op for a retried job and for unchanged content", async () => {
    const retried = fakeDb({ revision: 1, content: "a", last_source_job_id: "job-1" });
    expect(
      (await writeClientMemory(retried.db, { clientId: "c", content: "b", expectedRevision: 1, updatedBy: "u", jobId: "job-1" })).applied,
    ).toBe(false);
    expect(retried.row?.content).toBe("a");
    const same = fakeDb({ revision: 1, content: "a" });
    expect(
      (await writeClientMemory(same.db, { clientId: "c", content: "a", expectedRevision: 1, updatedBy: "u" })).applied,
    ).toBe(false);
  });

  it("wipes the content when switched off", async () => {
    const f = fakeDb({ revision: 2, content: "learned" });
    const memory = await setClientMemoryEnabled(f.db, { clientId: "c", enabled: false, updatedBy: "u" });
    expect(memory).toMatchObject({ enabled: false, content: "", revision: 3 });
  });

  it("gives the prompt builder empty-and-on for a client with no row", async () => {
    const { db } = fakeDb();
    expect(await loadClientMemoryForPrompt(db, "c")).toEqual({ enabled: true, content: "" });
  });
});

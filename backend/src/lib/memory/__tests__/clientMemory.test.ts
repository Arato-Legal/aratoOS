import { describe, expect, it } from "vitest";
import {
  MemoryDisabledError,
  MemoryRevisionConflictError,
  MemoryValidationError,
} from "../files";
import {
  deleteClientNotes,
  getClientMemory,
  getMatterNote,
  listSharedMatterNotes,
  loadClientMemoryForPrompt,
  setClientMemoryEnabled,
  writeClientMemory,
  writeMatterNote,
} from "../clientMemory";

type Row = Record<string, unknown>;

// A small in-memory stand-in for the tables client memory touches. It models
// the filters the store uses, and the compare-and-swap its updates rely on.
function memDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    client_memory_files: [],
    client_memory_notes: [],
    client_memory_cursors: [],
    projects: [],
    chats: [],
    ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
  };
  const db = {
    from(name: string) {
      const rows = tables[name];
      let mode: "select" | "update" | "delete" = "select";
      let patch: Row = {};
      const eqs: [string, unknown][] = [];
      const ins: [string, unknown[]][] = [];
      const match = () =>
        rows.filter(
          (r) => eqs.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k])),
        );
      const run = () => {
        if (mode === "update") {
          const hit = match();
          hit.forEach((r) => Object.assign(r, patch));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (mode === "delete") {
          const hit = new Set(match());
          tables[name] = rows.filter((r) => !hit.has(r));
          rows.splice(0, rows.length, ...tables[name]);
          return { data: null, error: null };
        }
        return { data: match().map((r) => ({ ...r })), error: null };
      };
      const q: any = {
        select: () => q,
        update: (p: Row) => ((mode = "update"), (patch = p), q),
        delete: () => ((mode = "delete"), q),
        eq: (k: string, v: unknown) => (eqs.push([k, v]), q),
        in: (k: string, vs: unknown[]) => (ins.push([k, vs]), q),
        upsert: (row: Row, opts?: { ignoreDuplicates?: boolean }) => {
          const keys = name === "client_memory_files" ? ["client_id"] : ["client_id", "project_id"];
          const dup = rows.find((r) => keys.every((k) => r[k] === row[k]));
          if (!dup) {
            rows.push({
              enabled: true, revision: 0, content: "", size_bytes: 0,
              updated_at: null, last_source_job_id: null, ...row,
            });
          } else if (!opts?.ignoreDuplicates) Object.assign(dup, row);
          return Promise.resolve({ error: null });
        },
        maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve(run()),
      };
      return q;
    },
  };
  return { db: db as any, tables };
}

const file = (over: Row = {}): Row => ({
  client_id: "c", enabled: true, revision: 0, content: "", size_bytes: 0, updated_at: null,
  last_source_job_id: null, ...over,
});
const note = (project: string, over: Row = {}): Row => ({
  client_id: "c", project_id: project, revision: 0, content: "", size_bytes: 0,
  last_source_job_id: null, ...over,
});

describe("client memory store", () => {
  it("creates an empty, enabled file on first touch", async () => {
    const { db } = memDb();
    expect(await getClientMemory(db, "c")).toMatchObject({ enabled: true, revision: 0, content: "" });
  });

  it("writes with compare-and-swap and bumps the revision", async () => {
    const { db, tables } = memDb({ client_memory_files: [file({ revision: 3 })] });
    const { applied, memory } = await writeClientMemory(db, {
      clientId: "c", content: "# Acme\n- Uses Net 30", expectedRevision: 3, updatedBy: "u",
    });
    expect(applied).toBe(true);
    expect(memory.revision).toBe(4);
    expect(tables.client_memory_files[0].content).toBe("# Acme\n- Uses Net 30");
  });

  it("refuses a stale revision", async () => {
    const { db } = memDb({ client_memory_files: [file({ revision: 5 })] });
    await expect(
      writeClientMemory(db, { clientId: "c", content: "x", expectedRevision: 4, updatedBy: "u" }),
    ).rejects.toBeInstanceOf(MemoryRevisionConflictError);
  });

  it("refuses writes while it is off", async () => {
    const { db } = memDb({ client_memory_files: [file({ enabled: false })] });
    await expect(
      writeClientMemory(db, { clientId: "c", content: "x", expectedRevision: 0, updatedBy: "u" }),
    ).rejects.toBeInstanceOf(MemoryDisabledError);
  });

  it("rejects executable HTML", async () => {
    const { db } = memDb();
    await expect(
      writeClientMemory(db, { clientId: "c", content: "<script>x</script>", expectedRevision: 0, updatedBy: "u" }),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it("is a no-op for a retried job and for unchanged content", async () => {
    const retried = memDb({ client_memory_files: [file({ revision: 1, content: "a", last_source_job_id: "job-1" })] });
    expect(
      (await writeClientMemory(retried.db, { clientId: "c", content: "b", expectedRevision: 1, updatedBy: "u", jobId: "job-1" })).applied,
    ).toBe(false);
    expect(retried.tables.client_memory_files[0].content).toBe("a");
    const same = memDb({ client_memory_files: [file({ revision: 1, content: "a" })] });
    expect(
      (await writeClientMemory(same.db, { clientId: "c", content: "a", expectedRevision: 1, updatedBy: "u" })).applied,
    ).toBe(false);
  });
});

describe("turning client memory off", () => {
  it("wipes the content and every matter's notes", async () => {
    const { db, tables } = memDb({
      client_memory_files: [file({ revision: 2, content: "learned" })],
      client_memory_notes: [note("p1", { content: "from p1" }), note("p2", { content: "from p2" })],
    });
    const memory = await setClientMemoryEnabled(db, { clientId: "c", enabled: false, updatedBy: "u" });
    expect(memory).toMatchObject({ enabled: false, content: "", revision: 3 });
    expect(tables.client_memory_notes).toEqual([]);
  });
});

describe("matter notes", () => {
  it("are written per matter with compare-and-swap", async () => {
    const { db, tables } = memDb({ client_memory_notes: [note("p1", { revision: 1, content: "old" })] });
    const written = await writeMatterNote(db, {
      clientId: "c", projectId: "p1", content: "- Pays Net 30", expectedRevision: 1, updatedBy: "u", jobId: "j",
    });
    expect(written.applied).toBe(true);
    expect(tables.client_memory_notes[0]).toMatchObject({ content: "- Pays Net 30", revision: 2 });
    await expect(
      writeMatterNote(db, { clientId: "c", projectId: "p1", content: "z", expectedRevision: 1, updatedBy: "u" }),
    ).rejects.toBeInstanceOf(MemoryRevisionConflictError);
    // A retried job is a no-op once it landed.
    expect(
      (await writeMatterNote(db, { clientId: "c", projectId: "p1", content: "y", expectedRevision: 2, updatedBy: "u", jobId: "j" })).applied,
    ).toBe(false);
  });

  it("start empty for a matter that has none", async () => {
    const { db } = memDb();
    expect(await getMatterNote(db, { clientId: "c", projectId: "p1" })).toMatchObject({ revision: 0, content: "" });
  });

  it("are deleted with the matter's chat cursors when the matter goes private", async () => {
    const { db, tables } = memDb({
      client_memory_notes: [note("p1", { content: "from p1" }), note("p2", { content: "from p2" })],
      chats: [{ id: "chat-p1", project_id: "p1" }, { id: "chat-p2", project_id: "p2" }],
      client_memory_cursors: [
        { client_id: "c", chat_id: "chat-p1", last_message_at: "t" },
        { client_id: "c", chat_id: "chat-p2", last_message_at: "t" },
      ],
    });
    await deleteClientNotes(db, { projectId: "p1" });
    expect(tables.client_memory_notes.map((n) => n.project_id)).toEqual(["p2"]);
    expect(tables.client_memory_cursors.map((c) => c.chat_id)).toEqual(["chat-p2"]);
  });

  it("are listed only for matters whose sharing is on", async () => {
    const { db } = memDb({
      client_memory_notes: [note("on", { content: "shared" }), note("off", { content: "private" }), note("empty", { content: "  " })],
      projects: [
        { id: "on", client_id: "c", share_with_client: true },
        { id: "off", client_id: "c", share_with_client: false },
        { id: "empty", client_id: "c", share_with_client: true },
      ],
    });
    expect((await listSharedMatterNotes(db, "c")).map((n) => n.projectId)).toEqual(["on"]);
  });
});

describe("what the prompt sees", () => {
  it("is empty-and-on for a client with no row", async () => {
    const { db } = memDb();
    expect(await loadClientMemoryForPrompt(db, "c")).toEqual({ enabled: true, content: "" });
  });

  it("is the base file followed by the sharing matters' notes, never a private matter's", async () => {
    const { db } = memDb({
      client_memory_files: [file({ content: "BASE FACTS" })],
      client_memory_notes: [note("on", { content: "SHARED NOTE" }), note("off", { content: "PRIVATE NOTE" })],
      projects: [
        { id: "on", client_id: "c", share_with_client: true },
        { id: "off", client_id: "c", share_with_client: false },
      ],
    });
    const { content } = await loadClientMemoryForPrompt(db, "c");
    expect(content).toContain("BASE FACTS");
    expect(content).toContain("SHARED NOTE");
    expect(content).not.toContain("PRIVATE NOTE");
    expect(content.indexOf("BASE FACTS")).toBeLessThan(content.indexOf("SHARED NOTE"));
  });

  it("shows nothing while client memory is off, even if notes remain", async () => {
    const { db } = memDb({
      client_memory_files: [file({ enabled: false })],
      client_memory_notes: [note("on", { content: "LEFTOVER" })],
      projects: [{ id: "on", client_id: "c", share_with_client: true }],
    });
    expect(await loadClientMemoryForPrompt(db, "c")).toEqual({ enabled: false, content: "" });
  });
});

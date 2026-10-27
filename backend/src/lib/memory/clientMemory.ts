// A client's own memory.md: one file per client, read by every conversation of
// that client (client level and every matter) and written by a separate
// curator job or by hand.
//
// It is deliberately independent of memory_files and its consolidation state
// machine, which is built around a conversation having ONE actor-private scope
// and ONE project. The rules here are small: a compare-and-swap on `revision`,
// a disabled file refuses writes, and disabling it wipes it, like every other
// memory file.

import type { Db } from "../dbq/types";
import {
  MemoryDisabledError,
  MemoryRevisionConflictError,
  normalizeMemoryMarkdown,
} from "./files";

export type ClientMemory = {
  clientId: string;
  enabled: boolean;
  revision: number;
  content: string;
  sizeBytes: number;
  updatedAt: string | null;
};

type Row = {
  client_id: string;
  enabled: boolean;
  revision: number | string;
  content: string;
  size_bytes: number | string;
  updated_at: string | null;
  last_source_job_id?: string | null;
};

const COLUMNS =
  "client_id, enabled, revision, content, size_bytes, updated_at, last_source_job_id";

function present(row: Row): ClientMemory {
  return {
    clientId: row.client_id,
    enabled: row.enabled,
    revision: Number(row.revision),
    content: row.content,
    sizeBytes: Number(row.size_bytes),
    updatedAt: row.updated_at,
  };
}

/** The client's memory, created empty (and on) the first time it is touched. */
export async function getClientMemory(db: Db, clientId: string): Promise<ClientMemory> {
  const read = async () =>
    db.from("client_memory_files").select(COLUMNS).eq("client_id", clientId).maybeSingle();
  const first = await read();
  if (first.error) throw new Error("Client memory could not be read");
  if (first.data) return present(first.data as Row);
  const { error } = await db
    .from("client_memory_files")
    .upsert({ client_id: clientId }, { onConflict: "client_id", ignoreDuplicates: true });
  if (error) throw new Error("Client memory could not be created");
  const second = await read();
  if (second.error || !second.data) throw new Error("Client memory could not be read");
  return present(second.data as Row);
}

/**
 * Replace the file's content if nobody changed it since `expectedRevision`.
 * `jobId` makes a retried curator job a no-op once it has landed.
 */
export async function writeClientMemory(
  db: Db,
  args: {
    clientId: string;
    content: string;
    expectedRevision: number;
    updatedBy: string;
    jobId?: string;
  },
): Promise<{ applied: boolean; memory: ClientMemory }> {
  const content = normalizeMemoryMarkdown(args.content);
  const current = await getClientMemory(db, args.clientId);
  if (!current.enabled) throw new MemoryDisabledError("Client memory is off");
  if (args.jobId) {
    const { data } = await db
      .from("client_memory_files")
      .select("last_source_job_id")
      .eq("client_id", args.clientId)
      .maybeSingle();
    if ((data as { last_source_job_id?: string | null } | null)?.last_source_job_id === args.jobId)
      return { applied: false, memory: current };
  }
  if (current.revision !== args.expectedRevision) throw new MemoryRevisionConflictError();
  if (content === current.content) return { applied: false, memory: current };
  const { data, error } = await db
    .from("client_memory_files")
    .update({
      content,
      size_bytes: Buffer.byteLength(content, "utf8"),
      revision: args.expectedRevision + 1,
      updated_by: args.updatedBy,
      updated_at: new Date().toISOString(),
      ...(args.jobId ? { last_source_job_id: args.jobId } : {}),
    })
    .eq("client_id", args.clientId)
    .eq("revision", args.expectedRevision)
    .eq("enabled", true)
    .select(COLUMNS);
  if (error) throw new Error("Client memory could not be saved");
  const row = (data as Row[] | null)?.[0];
  // Zero rows: someone else saved between the read and the write.
  if (!row) throw new MemoryRevisionConflictError();
  return { applied: true, memory: present(row) };
}

/** Turning it off deletes what was learned (as it does for other memory files). */
export async function setClientMemoryEnabled(
  db: Db,
  args: { clientId: string; enabled: boolean; updatedBy: string },
): Promise<ClientMemory> {
  const current = await getClientMemory(db, args.clientId);
  // Turning it off deletes everything learned for the client, notes included.
  if (!args.enabled) await deleteClientNotes(db, { clientId: args.clientId });
  const { data, error } = await db
    .from("client_memory_files")
    .update({
      enabled: args.enabled,
      ...(args.enabled
        ? {}
        : { content: "", size_bytes: 0, revision: current.revision + 1 }),
      updated_by: args.updatedBy,
      updated_at: new Date().toISOString(),
    })
    .eq("client_id", args.clientId)
    .select(COLUMNS);
  if (error) throw new Error("Client memory could not be changed");
  const row = (data as Row[] | null)?.[0];
  if (!row) throw new Error("Client memory could not be changed");
  return present(row);
}

// ---------------------------------------------------------------------------
// Matter notes: what a matter's chats taught the client's memory.
// ---------------------------------------------------------------------------
//
// Kept apart from the base file so that removal is exact: when a matter stops
// sharing with its client (or moves to another client) its notes are deleted,
// and nothing it taught is left behind in a file shared with everyone else.

export type MatterNote = {
  clientId: string;
  projectId: string;
  revision: number;
  content: string;
};

type NoteRow = {
  client_id: string;
  project_id: string;
  revision: number | string;
  content: string;
  last_source_job_id?: string | null;
};

const NOTE_COLUMNS = "client_id, project_id, revision, content, last_source_job_id";

function presentNote(row: NoteRow): MatterNote {
  return {
    clientId: row.client_id,
    projectId: row.project_id,
    revision: Number(row.revision),
    content: row.content,
  };
}

/** The matter's notes for the client, created empty the first time. */
export async function getMatterNote(
  db: Db,
  args: { clientId: string; projectId: string },
): Promise<MatterNote> {
  const read = async () =>
    db
      .from("client_memory_notes")
      .select(NOTE_COLUMNS)
      .eq("client_id", args.clientId)
      .eq("project_id", args.projectId)
      .maybeSingle();
  const first = await read();
  if (first.error) throw new Error("Client memory notes could not be read");
  if (first.data) return presentNote(first.data as NoteRow);
  const { error } = await db
    .from("client_memory_notes")
    .upsert(
      { client_id: args.clientId, project_id: args.projectId },
      { onConflict: "client_id,project_id", ignoreDuplicates: true },
    );
  if (error) throw new Error("Client memory notes could not be created");
  const second = await read();
  if (second.error || !second.data) throw new Error("Client memory notes could not be read");
  return presentNote(second.data as NoteRow);
}

/** Compare-and-swap write of one matter's notes; a retried job is a no-op. */
export async function writeMatterNote(
  db: Db,
  args: {
    clientId: string;
    projectId: string;
    content: string;
    expectedRevision: number;
    updatedBy: string;
    jobId?: string;
  },
): Promise<{ applied: boolean; note: MatterNote }> {
  const content = normalizeMemoryMarkdown(args.content);
  const current = await getMatterNote(db, args);
  if (args.jobId) {
    const { data } = await db
      .from("client_memory_notes")
      .select("last_source_job_id")
      .eq("client_id", args.clientId)
      .eq("project_id", args.projectId)
      .maybeSingle();
    if ((data as { last_source_job_id?: string | null } | null)?.last_source_job_id === args.jobId)
      return { applied: false, note: current };
  }
  if (current.revision !== args.expectedRevision) throw new MemoryRevisionConflictError();
  if (content === current.content) return { applied: false, note: current };
  const { data, error } = await db
    .from("client_memory_notes")
    .update({
      content,
      size_bytes: Buffer.byteLength(content, "utf8"),
      revision: args.expectedRevision + 1,
      updated_by: args.updatedBy,
      updated_at: new Date().toISOString(),
      ...(args.jobId ? { last_source_job_id: args.jobId } : {}),
    })
    .eq("client_id", args.clientId)
    .eq("project_id", args.projectId)
    .eq("revision", args.expectedRevision)
    .select(NOTE_COLUMNS);
  if (error) throw new Error("Client memory notes could not be saved");
  const row = (data as NoteRow[] | null)?.[0];
  if (!row) throw new MemoryRevisionConflictError();
  return { applied: true, note: presentNote(row) };
}

/**
 * Delete what a matter taught client memory: its notes, and the cursors that
 * record how far its chats were learned from, so that sharing again later
 * learns from them afresh. Called when the matter's sharing goes off and when
 * it moves to another client. Pass `clientId` to scope the delete to one
 * client (turning that client's memory off deletes every matter's notes).
 */
export async function deleteClientNotes(
  db: Db,
  args: { projectId: string } | { clientId: string },
): Promise<void> {
  const notes = db.from("client_memory_notes").delete();
  const { error } =
    "projectId" in args
      ? await notes.eq("project_id", args.projectId)
      : await notes.eq("client_id", args.clientId);
  if (error) throw new Error("Client memory notes could not be deleted");
  if ("projectId" in args) {
    const { data: chats, error: chatError } = await db
      .from("chats")
      .select("id")
      .eq("project_id", args.projectId);
    if (chatError) throw new Error("Client memory notes could not be deleted");
    const ids = ((chats ?? []) as { id: string }[]).map((c) => c.id);
    if (ids.length) {
      const { error: cursorError } = await db
        .from("client_memory_cursors")
        .delete()
        .in("chat_id", ids);
      if (cursorError) throw new Error("Client memory notes could not be deleted");
    }
  }
}

/** Notes from matters whose sharing is on, for one client. */
export async function listSharedMatterNotes(
  db: Db,
  clientId: string,
): Promise<MatterNote[]> {
  const [notes, matters] = await Promise.all([
    db.from("client_memory_notes").select(NOTE_COLUMNS).eq("client_id", clientId),
    db
      .from("projects")
      .select("id")
      .eq("client_id", clientId)
      .eq("share_with_client", true),
  ]);
  if (notes.error || matters.error) throw new Error("Client memory notes could not be read");
  // Checked again here, not only at deletion: a note outlives nothing the
  // matter's sharing switch says.
  const sharing = new Set(((matters.data ?? []) as { id: string }[]).map((m) => m.id));
  return ((notes.data ?? []) as NoteRow[])
    .filter((row) => sharing.has(row.project_id) && row.content.trim())
    .map(presentNote);
}

/**
 * What the prompt builder needs: the base file followed by the notes of the
 * matters that share. Never throws for a missing row.
 */
export async function loadClientMemoryForPrompt(
  db: Db,
  clientId: string,
): Promise<{ enabled: boolean; content: string }> {
  const { data, error } = await db
    .from("client_memory_files")
    .select("enabled, content")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error("Client memory could not be read");
  const row = data as { enabled: boolean; content: string } | null;
  const enabled = row?.enabled ?? true;
  if (!enabled) return { enabled, content: "" };
  const notes = await listSharedMatterNotes(db, clientId);
  const parts = [
    (row?.content ?? "").trim(),
    ...notes.map((note) => `Learned in the client's matters:\n${note.content.trim()}`),
  ].filter(Boolean);
  return { enabled, content: parts.join("\n\n") };
}

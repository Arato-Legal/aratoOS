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

/** What the prompt builder needs; never throws for a missing row. */
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
  return { enabled: row?.enabled ?? true, content: row?.content ?? "" };
}

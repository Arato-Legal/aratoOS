// Service behind the client memory routes: who may read or edit a client's
// memory.md, and the reads and writes themselves.
//
// Anyone who can open the client reads it (it is in every session of that
// client, so hiding it would only hide what the assistant already uses). Only
// the client's creator or an organization admin edits it, switches it on or
// off, or wipes it.

import { getOrgRole, isOrgAdmin } from "../../lib/access";
import type { Db } from "../../lib/supabase";
import { isUuid } from "../../lib/uuid";
import {
  getClientMemory,
  setClientMemoryEnabled,
  writeClientMemory,
  type ClientMemory,
} from "../../lib/memory/clientMemory";

export {
  MemoryDisabledError,
  MemoryRevisionConflictError,
  MemoryValidationError,
} from "../../lib/memory/files";

export type ClientMemoryView = {
  content: string;
  revision: number;
  enabled: boolean;
  size_bytes: number;
  updated_at: string | null;
  can_edit: boolean;
};

export type ClientMemoryAccess =
  | { ok: true; clientId: string; canEdit: boolean }
  | { ok: false; status: 404 | 403 };

export async function resolveClientMemoryAccess(
  db: Db,
  args: { clientId: string; userId: string; requireEdit: boolean },
): Promise<ClientMemoryAccess> {
  if (!isUuid(args.clientId)) return { ok: false, status: 404 };
  const { data } = await db
    .from("clients")
    .select("user_id, org_id")
    .eq("id", args.clientId)
    .maybeSingle();
  const client = data as { user_id: string | null; org_id: string | null } | null;
  if (!client) return { ok: false, status: 404 };
  let canRead: boolean;
  let isAdmin = false;
  if (client.org_id) {
    const role = await getOrgRole(args.userId, client.org_id, db);
    canRead = !!role;
    isAdmin = isOrgAdmin(role);
  } else {
    canRead = client.user_id === args.userId;
  }
  if (!canRead) return { ok: false, status: 404 };
  const canEdit = client.user_id === args.userId || isAdmin;
  if (args.requireEdit && !canEdit) return { ok: false, status: 403 };
  return { ok: true, clientId: args.clientId, canEdit };
}

function view(memory: ClientMemory, canEdit: boolean): ClientMemoryView {
  return {
    content: memory.content,
    revision: memory.revision,
    enabled: memory.enabled,
    size_bytes: memory.sizeBytes,
    updated_at: memory.updatedAt,
    can_edit: canEdit,
  };
}

export async function readClientMemory(db: Db, access: { clientId: string; canEdit: boolean }) {
  return view(await getClientMemory(db, access.clientId), access.canEdit);
}

export async function saveClientMemory(
  db: Db,
  args: { clientId: string; canEdit: boolean; content: string; expectedRevision: number; userId: string },
) {
  const { memory } = await writeClientMemory(db, {
    clientId: args.clientId,
    content: args.content,
    expectedRevision: args.expectedRevision,
    updatedBy: args.userId,
  });
  return view(memory, args.canEdit);
}

export async function switchClientMemory(
  db: Db,
  args: { clientId: string; canEdit: boolean; enabled: boolean; userId: string },
) {
  return view(
    await setClientMemoryEnabled(db, {
      clientId: args.clientId,
      enabled: args.enabled,
      updatedBy: args.userId,
    }),
    args.canEdit,
  );
}

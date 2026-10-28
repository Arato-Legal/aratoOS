// Matter-to-matter sharing inside one client.
//
// A matter with `share_with_client` on lets the client's OTHER matters read its
// data, read-only. This is reached only through a matter the caller can already
// open: it never grants anyone access to the shared matter's own page, and a
// sibling in a different workspace than the client is never returned. Callers
// must have verified access to `projectId` first.

import { checkProjectAccess, getOrgRole } from "./access";
import type { Db } from "./supabase";

export type SharedSiblingMatter = { id: string; name: string };

export async function listSharedSiblingMatters(
  db: Db,
  projectId: string,
): Promise<SharedSiblingMatter[]> {
  const { data: self } = await db
    .from("projects")
    .select("client_id, org_id")
    .eq("id", projectId)
    .maybeSingle();
  const clientId = (self as { client_id: string | null } | null)?.client_id;
  if (!clientId) return [];
  const { data, error } = await db
    .from("projects")
    .select("id, name, org_id")
    .eq("client_id", clientId)
    .eq("share_with_client", true)
    .is("archived_at", null)
    .neq("id", projectId)
    .order("name", { ascending: true });
  if (error) {
    console.error("[clientSharing] sibling lookup failed");
    return [];
  }
  const selfOrg = (self as { org_id: string | null }).org_id ?? null;
  return ((data ?? []) as { id: string; name: string; org_id: string | null }[])
    .filter((row) => (row.org_id ?? null) === selfOrg)
    .map(({ id, name }) => ({ id, name }));
}

export type ClientAccess =
  | { ok: true; orgId: string | null; name: string }
  | { ok: false };

// The client rule used everywhere in the clients module: a personal client is
// its creator's, an organization client is open to its members.
export async function checkClientAccess(
  db: Db,
  clientId: string,
  userId: string,
): Promise<ClientAccess> {
  const { data } = await db
    .from("clients")
    .select("user_id, org_id, name")
    .eq("id", clientId)
    .maybeSingle();
  const row = data as { user_id: string | null; org_id: string | null; name: string } | null;
  if (!row) return { ok: false };
  const open = row.org_id
    ? !!(await getOrgRole(userId, row.org_id, db))
    : row.user_id === userId;
  return open ? { ok: true, orgId: row.org_id, name: row.name } : { ok: false };
}

// What a CLIENT-level session may read: the client's matters whose sharing is
// on AND that the caller can open. Unlike a matter-level session, nothing here
// is reached through another matter, so the caller's own access is the gate.
export async function listReadableClientMatters(
  db: Db,
  clientId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<SharedSiblingMatter[]> {
  const client = await checkClientAccess(db, clientId, userId);
  if (!client.ok) return [];
  const { data, error } = await db
    .from("projects")
    .select("id, name, org_id")
    .eq("client_id", clientId)
    .eq("share_with_client", true)
    .is("archived_at", null)
    .order("name", { ascending: true });
  if (error) {
    console.error("[clientSharing] client matter lookup failed");
    return [];
  }
  const rows = ((data ?? []) as { id: string; name: string; org_id: string | null }[]).filter(
    (row) => (row.org_id ?? null) === client.orgId,
  );
  const readable = await Promise.all(
    rows.map(async (row) =>
      (await checkProjectAccess(row.id, userId, userEmail, db)).ok ? row : null,
    ),
  );
  return readable
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .map(({ id, name }) => ({ id, name }));
}

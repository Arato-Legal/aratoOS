// Matter-to-matter sharing inside one client.
//
// A matter with `share_with_client` on lets the client's OTHER matters read its
// data, read-only. This is reached only through a matter the caller can already
// open: it never grants anyone access to the shared matter's own page, and a
// sibling in a different workspace than the client is never returned. Callers
// must have verified access to `projectId` first.

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

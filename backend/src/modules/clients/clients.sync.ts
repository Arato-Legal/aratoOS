// Upsert clients and matters pushed from an outside system (Hubflo, or any
// system speaking the same payload). Rows are matched by (source, external id)
// inside one workspace, so a repeated or out-of-order push updates the same
// row instead of creating a duplicate.
//
// The sender is the source of truth for the fields it sends: a field left out
// is untouched, a field sent as null is cleared. A push carrying an
// `updated_at` older than the last applied one is ignored as stale.
//
// Callers (the crm-sync module) authenticate the endpoint and pass its scope;
// nothing here checks a person's access, because the endpoint's owner has
// already authorized the workspace.

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { createProject } from "../projects/projects.service";
import {
  CLIENT_COLUMNS,
  asRecord,
  optionalText,
  parseContactFields,
  parseFields,
  type ClientRow,
} from "./clients.shared";

export type SyncScope = {
  /** The endpoint's owner: creator of synced rows and of synced matters. */
  userId: string;
  /** A team organization's id, or null for a personal workspace. */
  orgId: string | null;
  source: string;
  matterVisibility: "private" | "organization";
};

export type SyncOutcome = "created" | "updated" | "unchanged" | "stale";
export type SyncApplied = { outcome: SyncOutcome; id: string };

const MAX_EXTERNAL_ID = 200;
const MAX_CONTACTS = 50;

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

function externalId(data: Record<string, unknown>, key = "external_id"): Parsed<string> {
  const raw = data[key];
  if (typeof raw !== "string" || !raw.trim())
    return { ok: false, detail: `${key} is required` };
  if (raw.trim().length > MAX_EXTERNAL_ID)
    return { ok: false, detail: `${key} must be at most ${MAX_EXTERNAL_ID} characters` };
  return { ok: true, value: raw.trim() };
}

function sentAt(data: Record<string, unknown>): Parsed<Date | null> {
  if (data.updated_at === undefined || data.updated_at === null)
    return { ok: true, value: null };
  if (typeof data.updated_at !== "string" || Number.isNaN(Date.parse(data.updated_at)))
    return { ok: false, detail: "updated_at must be an ISO date-time" };
  return { ok: true, value: new Date(data.updated_at) };
}

function isStale(sent: Date | null, last: string | null | undefined): boolean {
  return !!sent && !!last && sent.getTime() < Date.parse(last);
}

function differs(existing: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).some(
    ([key, value]) => JSON.stringify(existing[key] ?? null) !== JSON.stringify(value ?? null),
  );
}

// Narrow a query to this endpoint's workspace and one external identity.
// `any`: the Supabase builder's generic type is not worth threading through.
function scoped(query: any, scope: SyncScope, id: string) {
  const base = scope.orgId
    ? query.eq("org_id", scope.orgId)
    : query.is("org_id", null).eq("user_id", scope.userId);
  return base.eq("external_source", scope.source).eq("external_id", id);
}

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string } | null)?.code === "23505";

export async function upsertExternalClient(
  db: Db,
  scope: SyncScope,
  raw: unknown,
  attempt = 0,
): Promise<ServiceResult<SyncApplied>> {
  const data = asRecord(raw);
  const id = externalId(data);
  if (!id.ok) return failure("validation", id.detail, "invalid_payload");
  const at = sentAt(data);
  if (!at.ok) return failure("validation", at.detail, "invalid_payload");

  const { data: found, error: findError } = await scoped(
    db.from("clients").select(`${CLIENT_COLUMNS}, external_synced_at`),
    scope,
    id.value,
  ).maybeSingle();
  if (findError) return internalFailure(findError);
  const existing = found as (ClientRow & { external_synced_at: string | null }) | null;

  const parsed = parseFields(data, { requireName: !existing });
  if (!parsed.ok) return failure("validation", parsed.detail, "invalid_payload");
  const now = new Date().toISOString();
  const syncedAt = (at.value ?? new Date()).toISOString();

  let clientId: string;
  let changed: boolean;
  let outcome: SyncOutcome;
  if (existing) {
    if (isStale(at.value, existing.external_synced_at))
      return ok({ outcome: "stale", id: existing.id });
    clientId = existing.id;
    changed = differs(existing as unknown as Record<string, unknown>, parsed.value);
    const { error } = await db
      .from("clients")
      .update({
        ...parsed.value,
        external_synced_at: syncedAt,
        ...(changed ? { updated_at: now } : {}),
      })
      .eq("id", existing.id);
    if (error) return internalFailure(error);
    outcome = changed ? "updated" : "unchanged";
  } else {
    const { data: created, error } = await db
      .from("clients")
      .insert({
        ...parsed.value,
        user_id: scope.userId,
        org_id: scope.orgId,
        external_source: scope.source,
        external_id: id.value,
        external_synced_at: syncedAt,
      })
      .select("id")
      .single();
    // Two pushes for the same new record raced: the loser re-reads and updates.
    if (isUniqueViolation(error) && attempt === 0)
      return upsertExternalClient(db, scope, raw, 1);
    if (error || !created) return internalFailure(error);
    clientId = (created as { id: string }).id;
    changed = true;
    outcome = "created";
  }

  if (data.contacts !== undefined) {
    const contacts = await upsertContacts(db, clientId, data.contacts);
    if (!contacts.ok) return contacts;
    if (contacts.data && outcome === "unchanged") outcome = "updated";
  }
  return ok({ outcome, id: clientId });
}

// Contacts are matched by their own external_id within the client. Contacts the
// sender leaves out are kept: removing a person is not something a push does.
async function upsertContacts(
  db: Db,
  clientId: string,
  raw: unknown,
): Promise<ServiceResult<boolean>> {
  if (!Array.isArray(raw))
    return failure("validation", "contacts must be a list", "invalid_payload");
  if (raw.length > MAX_CONTACTS)
    return failure("validation", `at most ${MAX_CONTACTS} contacts per client`, "invalid_payload");
  let changed = false;
  for (const [index, item] of raw.entries()) {
    const contact = asRecord(item);
    const id = externalId(contact);
    if (!id.ok)
      return failure("validation", `contacts[${index}]: ${id.detail}`, "invalid_payload");
    const { data: found, error: findError } = await db
      .from("client_contacts")
      .select("id, name, role, email, phone, notes")
      .eq("client_id", clientId)
      .eq("external_id", id.value)
      .maybeSingle();
    if (findError) return internalFailure(findError);
    const parsed = parseContactFields(contact, { requireName: !found });
    if (!parsed.ok)
      return failure("validation", `contacts[${index}]: ${parsed.detail}`, "invalid_payload");
    if (found) {
      if (differs(found as Record<string, unknown>, parsed.value)) {
        const { error } = await db
          .from("client_contacts")
          .update({ ...parsed.value, updated_at: new Date().toISOString() })
          .eq("id", (found as { id: string }).id);
        if (error) return internalFailure(error);
        changed = true;
      }
    } else {
      const { error } = await db
        .from("client_contacts")
        .insert({ ...parsed.value, client_id: clientId, external_id: id.value });
      if (error) return internalFailure(error);
      changed = true;
    }
  }
  return ok(changed);
}

type MatterRow = {
  id: string;
  name: string;
  cm_number: string | null;
  practice: string | null;
  client_id: string | null;
  archived_at: string | null;
  external_synced_at: string | null;
};

export async function upsertExternalMatter(
  db: Db,
  scope: SyncScope,
  raw: unknown,
  attempt = 0,
): Promise<ServiceResult<SyncApplied>> {
  const data = asRecord(raw);
  const id = externalId(data);
  if (!id.ok) return failure("validation", id.detail, "invalid_payload");
  const at = sentAt(data);
  if (!at.ok) return failure("validation", at.detail, "invalid_payload");

  const patch: Record<string, unknown> = {};
  for (const [key, max] of [
    ["cm_number", 200],
    ["practice", 200],
  ] as const) {
    const parsed = optionalText(data, key, max);
    if (!parsed.ok) return failure("validation", parsed.detail, "invalid_payload");
    if (parsed.value !== undefined) patch[key] = parsed.value;
  }
  if (data.archived !== undefined) {
    if (typeof data.archived !== "boolean")
      return failure("validation", "archived must be true or false", "invalid_payload");
  }

  // Resolve the client link first: a matter pushed before its client is
  // rejected, and the sender can push the client and retry.
  let clientId: string | null | undefined;
  if (data.client_external_id === null) clientId = null;
  else if (data.client_external_id !== undefined) {
    const ref = externalId(data, "client_external_id");
    if (!ref.ok) return failure("validation", ref.detail, "invalid_payload");
    const { data: client, error } = await scoped(
      db.from("clients").select("id"),
      scope,
      ref.value,
    ).maybeSingle();
    if (error) return internalFailure(error);
    if (!client)
      return failure("validation", "client_external_id does not match a synced client", "client_not_found");
    clientId = (client as { id: string }).id;
  }
  if (clientId !== undefined) patch.client_id = clientId;

  const { data: found, error: findError } = await scoped(
    db.from("projects").select("id, name, cm_number, practice, client_id, archived_at, external_synced_at"),
    scope,
    id.value,
  ).maybeSingle();
  if (findError) return internalFailure(findError);
  const existing = found as MatterRow | null;

  let name: string | undefined;
  if (data.name !== undefined || !existing) {
    if (typeof data.name !== "string" || !data.name.trim())
      return failure("validation", "name is required", "invalid_payload");
    if (data.name.trim().length > 300)
      return failure("validation", "name must be at most 300 characters", "invalid_payload");
    name = data.name.trim();
    patch.name = name;
  }

  const now = new Date().toISOString();
  const syncedAt = (at.value ?? new Date()).toISOString();
  if (data.archived !== undefined)
    patch.archived_at = data.archived ? (existing?.archived_at ?? now) : null;

  if (existing) {
    if (isStale(at.value, existing.external_synced_at))
      return ok({ outcome: "stale", id: existing.id });
    const changed = differs(existing as unknown as Record<string, unknown>, patch);
    const { error } = await db
      .from("projects")
      .update({
        ...patch,
        external_synced_at: syncedAt,
        ...(changed ? { updated_at: now } : {}),
      })
      .eq("id", existing.id);
    if (error) return internalFailure(error);
    return ok({ outcome: changed ? "updated" : "unchanged", id: existing.id });
  }

  const created = await createProject(db, {
    userId: scope.userId,
    name,
    cm_number: typeof patch.cm_number === "string" ? patch.cm_number : undefined,
    practice: typeof patch.practice === "string" ? patch.practice : undefined,
    org_id: scope.orgId,
    visibility: scope.orgId ? scope.matterVisibility : undefined,
  });
  if (!created.ok) {
    if (created.kind === "validation")
      return failure("conflict", created.detail, "endpoint_owner_unavailable");
    return internalFailure(created.error);
  }
  const projectId = created.project.id as string;
  const { error } = await db
    .from("projects")
    .update({
      ...(clientId !== undefined ? { client_id: clientId } : {}),
      ...(patch.archived_at !== undefined ? { archived_at: patch.archived_at } : {}),
      external_source: scope.source,
      external_id: id.value,
      external_synced_at: syncedAt,
    })
    .eq("id", projectId);
  if (error) {
    // Without its external identity the next push would create a duplicate,
    // so take the half-made, still empty matter back out.
    await db.from("projects").delete().eq("id", projectId);
    // A racing push for the same new matter won: update theirs instead.
    if (isUniqueViolation(error) && attempt === 0)
      return upsertExternalMatter(db, scope, raw, 1);
    return internalFailure(error);
  }
  return ok({ outcome: "created", id: projectId });
}

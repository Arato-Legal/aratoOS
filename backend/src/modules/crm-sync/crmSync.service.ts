// Inbound CRM sync: webhook endpoints and the receiver behind them.
//
// An endpoint is a secret URL token plus a bearer secret. An outside system
// (Hubflo, through its automations, or any sender of the same JSON) POSTs
// batches of `client.upsert` and `matter.upsert` events; each is applied with
// clients.service's upsertExternal* and logged by outcome only (never the
// payload). Managing endpoints needs organization admin rights, or ownership
// of a personal one, because the URL is the capability to write into the
// workspace.

import crypto from "node:crypto";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { teamOrgIdOf } from "../../lib/personalOrgs";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { isUuid } from "../../lib/uuid";
import { PERSONAL_WORKSPACE, type WorkspaceFilter } from "../../lib/workspace";
import {
  upsertExternalClient,
  upsertExternalMatter,
  type SyncOutcome,
  type SyncScope,
} from "../clients/clients.service";

export const PROVIDERS = ["hubflo", "generic"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const MAX_EVENTS_PER_PUSH = 100;
const EVENT_RETENTION_DAYS = 30;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export type EndpointRow = {
  id: string;
  user_id: string;
  org_id: string | null;
  name: string;
  provider: Provider;
  token: string;
  enabled: boolean;
  matter_visibility: "private" | "organization";
  last_received_at: string | null;
  created_at: string;
};

const ENDPOINT_COLUMNS =
  "id, user_id, org_id, name, provider, token, enabled, matter_visibility, last_received_at, created_at";

export type EndpointView = Omit<EndpointRow, "token" | "user_id"> & {
  /** Path of the webhook on the API, secret included. */
  webhook_path: string;
};

// Named fields only, so nothing else on a row (the secret's hash above all)
// can reach a response.
function view(row: EndpointRow): EndpointView {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    provider: row.provider,
    enabled: row.enabled,
    matter_visibility: row.matter_visibility,
    last_received_at: row.last_received_at,
    created_at: row.created_at,
    webhook_path: `/webhooks/crm/${row.token}`,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function newSecret(): string {
  return `mike_whsec_${crypto.randomBytes(32).toString("base64url")}`;
}

function secretMatches(provided: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(provided), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Managing endpoints
// ---------------------------------------------------------------------------

async function canManage(db: Db, userId: string, row: Pick<EndpointRow, "org_id" | "user_id">): Promise<boolean> {
  if (!row.org_id) return row.user_id === userId;
  return isOrgAdmin(await getOrgRole(userId, row.org_id, db));
}

// An endpoint the caller may not manage is indistinguishable from a missing one.
async function loadManaged(
  db: Db,
  endpointId: string,
  userId: string,
): Promise<ServiceResult<EndpointRow>> {
  if (!isUuid(endpointId)) return failure("not_found", "Endpoint not found");
  const { data, error } = await db
    .from("crm_sync_endpoints")
    .select(ENDPOINT_COLUMNS)
    .eq("id", endpointId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data || !(await canManage(db, userId, data as EndpointRow)))
    return failure("not_found", "Endpoint not found");
  return ok(data as EndpointRow);
}

export async function listEndpoints(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter },
): Promise<ServiceResult<EndpointView[]>> {
  const personal = !args.workspace || args.workspace === PERSONAL_WORKSPACE;
  if (!personal) {
    const role = await getOrgRole(args.userId, args.workspace as string, db);
    if (!role) return failure("not_found", "Workspace not found", "workspace_not_found");
    if (!isOrgAdmin(role))
      return failure("forbidden", "Only organization admins can manage CRM sync.");
  }
  let query = db.from("crm_sync_endpoints").select(ENDPOINT_COLUMNS);
  query = personal
    ? query.is("org_id", null).eq("user_id", args.userId)
    : query.eq("org_id", args.workspace as string);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) return internalFailure(error);
  return ok(((data ?? []) as EndpointRow[]).map(view));
}

export async function createEndpoint(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter; body: unknown },
): Promise<ServiceResult<{ endpoint: EndpointView; secret: string }>> {
  const body = asRecord(args.body);
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200)
    return failure("validation", "name is required (up to 200 characters)");
  const provider = body.provider ?? "hubflo";
  if (!(PROVIDERS as readonly unknown[]).includes(provider))
    return failure("validation", "provider must be 'hubflo' or 'generic'");
  const visibility = body.matter_visibility ?? "private";
  if (visibility !== "private" && visibility !== "organization")
    return failure("validation", "matter_visibility must be 'private' or 'organization'");

  let orgId: string | null = null;
  if (args.workspace && args.workspace !== PERSONAL_WORKSPACE) {
    orgId = await teamOrgIdOf(db, args.workspace);
    if (!orgId) return failure("not_found", "Workspace not found", "workspace_not_found");
    const role = await getOrgRole(args.userId, orgId, db);
    if (!role) return failure("not_found", "Workspace not found", "workspace_not_found");
    if (!isOrgAdmin(role))
      return failure("forbidden", "Only organization admins can manage CRM sync.");
  }
  if (visibility === "organization" && !orgId)
    return failure("validation", "Only an organization's matters can be visible to the organization.");

  const secret = newSecret();
  const { data, error } = await db
    .from("crm_sync_endpoints")
    .insert({
      user_id: args.userId,
      org_id: orgId,
      name: body.name.trim(),
      provider,
      matter_visibility: visibility,
      secret_hash: hashSecret(secret),
    })
    .select(ENDPOINT_COLUMNS)
    .single();
  if (error || !data) return internalFailure(error);
  return ok({ endpoint: view(data as EndpointRow), secret });
}

export async function updateEndpoint(
  db: Db,
  args: { userId: string; endpointId: string; body: unknown },
): Promise<ServiceResult<EndpointView>> {
  const body = asRecord(args.body);
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200)
      return failure("validation", "name must be 1 to 200 characters");
    patch.name = body.name.trim();
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean")
      return failure("validation", "enabled must be true or false");
    patch.enabled = body.enabled;
  }
  if (body.matter_visibility !== undefined) {
    if (body.matter_visibility !== "private" && body.matter_visibility !== "organization")
      return failure("validation", "matter_visibility must be 'private' or 'organization'");
    patch.matter_visibility = body.matter_visibility;
  }
  if (Object.keys(patch).length === 0) return failure("validation", "No fields to update");
  const endpoint = await loadManaged(db, args.endpointId, args.userId);
  if (!endpoint.ok) return endpoint;
  if (patch.matter_visibility === "organization" && !endpoint.data.org_id)
    return failure("validation", "Only an organization's matters can be visible to the organization.");
  const { data, error } = await db
    .from("crm_sync_endpoints")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", endpoint.data.id)
    .select(ENDPOINT_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Endpoint not found");
  return ok(view(data as EndpointRow));
}

// Replace the secret: the old one stops working at once. The new one is
// returned this once.
export async function rotateEndpointSecret(
  db: Db,
  args: { userId: string; endpointId: string },
): Promise<ServiceResult<{ endpoint: EndpointView; secret: string }>> {
  const endpoint = await loadManaged(db, args.endpointId, args.userId);
  if (!endpoint.ok) return endpoint;
  const secret = newSecret();
  const { data, error } = await db
    .from("crm_sync_endpoints")
    .update({ secret_hash: hashSecret(secret), updated_at: new Date().toISOString() })
    .eq("id", endpoint.data.id)
    .select(ENDPOINT_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Endpoint not found");
  return ok({ endpoint: view(data as EndpointRow), secret });
}

export async function deleteEndpoint(
  db: Db,
  args: { userId: string; endpointId: string },
): Promise<ServiceResult<null>> {
  const endpoint = await loadManaged(db, args.endpointId, args.userId);
  if (!endpoint.ok) return endpoint;
  const { error } = await db.from("crm_sync_endpoints").delete().eq("id", endpoint.data.id);
  if (error) return internalFailure(error);
  return ok(null);
}

export type SyncEventRow = {
  id: string;
  received_at: string;
  event_type: string | null;
  external_id: string | null;
  outcome: string;
  error_code: string | null;
};

export async function listEndpointEvents(
  db: Db,
  args: { userId: string; endpointId: string },
): Promise<ServiceResult<SyncEventRow[]>> {
  const endpoint = await loadManaged(db, args.endpointId, args.userId);
  if (!endpoint.ok) return endpoint;
  const { data, error } = await db
    .from("crm_sync_events")
    .select("id, received_at, event_type, external_id, outcome, error_code")
    .eq("endpoint_id", endpoint.data.id)
    .order("received_at", { ascending: false })
    .limit(50);
  if (error) return internalFailure(error);
  return ok((data ?? []) as SyncEventRow[]);
}

// ---------------------------------------------------------------------------
// Receiving pushes
// ---------------------------------------------------------------------------

type EventType = "client.upsert" | "matter.upsert";
const EVENT_ORDER: Record<EventType, number> = { "client.upsert": 0, "matter.upsert": 1 };
const isEventType = (v: unknown): v is EventType =>
  v === "client.upsert" || v === "matter.upsert";

export type EventResult = {
  index: number;
  type: string | null;
  external_id: string | null;
  outcome: SyncOutcome | "rejected";
  error_code?: string;
  detail?: string;
};

export type ReceiveResult = {
  results: EventResult[];
  summary: Record<SyncOutcome | "rejected", number>;
};

// The caller must treat `forbidden` as 401 with one generic body: an unknown
// token, a disabled endpoint and a wrong secret are not told apart.
export async function receivePush(
  db: Db,
  args: { token: string; secret: string | null; body: unknown },
): Promise<ServiceResult<ReceiveResult>> {
  const denied = failure("forbidden", "Unauthorized");
  if (!TOKEN_RE.test(args.token) || !args.secret) return denied;
  const { data, error } = await db
    .from("crm_sync_endpoints")
    .select(`${ENDPOINT_COLUMNS}, secret_hash`)
    .eq("token", args.token)
    .eq("enabled", true)
    .maybeSingle();
  if (error) return internalFailure(error);
  const endpoint = data as (EndpointRow & { secret_hash: string }) | null;
  if (!endpoint || !secretMatches(args.secret, endpoint.secret_hash)) return denied;

  // Accept {events:[...]} or one bare {type, data} event.
  const body = asRecord(args.body);
  const rawEvents: unknown[] = Array.isArray(body.events)
    ? body.events
    : body.type !== undefined
      ? [body]
      : [];
  if (rawEvents.length === 0)
    return failure("validation", "Send an `events` list, or one event with `type` and `data`.", "invalid_payload");
  if (rawEvents.length > MAX_EVENTS_PER_PUSH)
    return failure("validation", `At most ${MAX_EVENTS_PER_PUSH} events per push.`, "too_many_events");

  // The owner may have left the organization; synced matters are made as them.
  if (endpoint.org_id && !(await getOrgRole(endpoint.user_id, endpoint.org_id, db)))
    return failure("conflict", "The person who created this endpoint is no longer a member.", "endpoint_owner_unavailable");

  const scope: SyncScope = {
    userId: endpoint.user_id,
    orgId: endpoint.org_id,
    source: endpoint.provider,
    matterVisibility: endpoint.matter_visibility,
  };

  const results: EventResult[] = new Array(rawEvents.length);
  // Clients first, so a matter in the same push can reference its client.
  const order = rawEvents
    .map((raw, index) => ({ raw: asRecord(raw), index }))
    .sort(
      (a, b) =>
        (isEventType(a.raw.type) ? EVENT_ORDER[a.raw.type] : 9) -
          (isEventType(b.raw.type) ? EVENT_ORDER[b.raw.type] : 9) || a.index - b.index,
    );

  for (const { raw, index } of order) {
    const type = typeof raw.type === "string" ? raw.type : null;
    const ext = asRecord(raw.data).external_id;
    const externalId = typeof ext === "string" ? ext.slice(0, 200) : null;
    if (!isEventType(raw.type)) {
      results[index] = { index, type, external_id: externalId, outcome: "rejected", error_code: "unknown_event_type", detail: "type must be client.upsert or matter.upsert" };
      continue;
    }
    const applied =
      raw.type === "client.upsert"
        ? await upsertExternalClient(db, scope, raw.data)
        : await upsertExternalMatter(db, scope, raw.data);
    if (applied.ok) {
      results[index] = { index, type, external_id: externalId, outcome: applied.data.outcome };
    } else if (applied.kind === "error") {
      // Unexpected: logged by the router's boundary; the sender is told only
      // that this event failed, and can retry it.
      results[index] = { index, type, external_id: externalId, outcome: "rejected", error_code: "internal_error", detail: "This event could not be processed." };
    } else {
      results[index] = { index, type, external_id: externalId, outcome: "rejected", error_code: applied.code ?? applied.kind, detail: applied.detail };
    }
  }

  const summary = { created: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0 };
  for (const r of results) summary[r.outcome] += 1;

  await db.from("crm_sync_events").insert(
    results.map((r) => ({
      endpoint_id: endpoint.id,
      event_type: r.type,
      external_id: r.external_id,
      outcome: r.outcome,
      error_code: r.error_code ?? null,
    })),
  );
  await db
    .from("crm_sync_endpoints")
    .update({ last_received_at: new Date().toISOString() })
    .eq("id", endpoint.id);
  await db
    .from("crm_sync_events")
    .delete()
    .eq("endpoint_id", endpoint.id)
    .lt("received_at", new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString());

  return ok({ results, summary });
}

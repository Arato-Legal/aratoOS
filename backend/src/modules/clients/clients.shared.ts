// Types and request parsing shared by the clients module's service files
// (clients.service.ts and the topic files behind it). No database access.

export const CLIENT_KINDS = ["individual", "organization"] as const;
export const CLIENT_STATUSES = ["lead", "active", "closed"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export type ClientRow = {
  id: string;
  user_id: string | null;
  org_id: string | null;
  name: string;
  client_number: string | null;
  kind: ClientKind;
  status: ClientStatus;
  email: string | null;
  phone: string | null;
  address: string | null;
  source: string | null;
  notes: string | null;
  custom_fields: Record<string, unknown>;
  drive_folder_id: string | null;
  drive_folder_name: string | null;
  created_at: string;
  updated_at: string;
};

export type ClientContactRow = {
  id: string;
  hubflo_url?: string | null;
  client_id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ClientMatter = {
  id: string;
  hubflo_url?: string | null;
  name: string;
  cm_number: string | null;
  practice: string | null;
  share_with_client: boolean;
  updated_at: string;
};

export type ClientDetail = ClientRow & {
  hubflo_url?: string | null;
  contacts: ClientContactRow[];
  matters: ClientMatter[];
};

export const CLIENT_COLUMNS =
  "id, user_id, org_id, name, client_number, kind, status, email, phone, address, source, notes, custom_fields, drive_folder_id, drive_folder_name, created_at, updated_at";
export const CONTACT_COLUMNS =
  "id, client_id, name, role, email, phone, notes, created_at, updated_at";

const MAX_NAME = 300;
const MAX_FIELD = 2000;
const MAX_NOTES = 50_000;
const MAX_CUSTOM_FIELDS_BYTES = 20_000;
export const MAX_MATTERS = 200;

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

// `undefined` leaves a field alone; null or "" clears it.
export function optionalText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): Parsed<string | null | undefined> {
  const raw = body[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string")
    return { ok: false, detail: `${key} must be a string` };
  const trimmed = raw.trim();
  if (trimmed.length > max)
    return { ok: false, detail: `${key} must be at most ${max} characters` };
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseFields(
  body: Record<string, unknown>,
  { requireName }: { requireName: boolean },
): Parsed<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  if (body.name !== undefined || requireName) {
    if (typeof body.name !== "string" || !body.name.trim())
      return { ok: false, detail: "name is required" };
    if (body.name.trim().length > MAX_NAME)
      return { ok: false, detail: `name must be at most ${MAX_NAME} characters` };
    out.name = body.name.trim();
  }

  if (body.kind !== undefined) {
    if (!(CLIENT_KINDS as readonly unknown[]).includes(body.kind))
      return { ok: false, detail: "kind must be 'individual' or 'organization'" };
    out.kind = body.kind;
  }
  if (body.status !== undefined) {
    if (!(CLIENT_STATUSES as readonly unknown[]).includes(body.status))
      return { ok: false, detail: "status must be 'lead', 'active' or 'closed'" };
    out.status = body.status;
  }

  for (const [key, max] of [
    ["client_number", 100],
    ["email", 320],
    ["phone", 100],
    ["address", MAX_FIELD],
    ["source", 200],
    ["notes", MAX_NOTES],
  ] as const) {
    const parsed = optionalText(body, key, max);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) out[key] = parsed.value;
  }
  if (typeof out.email === "string" && !EMAIL_RE.test(out.email))
    return { ok: false, detail: "email is not a valid address" };

  if (body.custom_fields !== undefined) {
    if (
      !body.custom_fields ||
      typeof body.custom_fields !== "object" ||
      Array.isArray(body.custom_fields)
    )
      return { ok: false, detail: "custom_fields must be an object" };
    if (JSON.stringify(body.custom_fields).length > MAX_CUSTOM_FIELDS_BYTES)
      return { ok: false, detail: "custom_fields is too large" };
    out.custom_fields = body.custom_fields;
  }
  return { ok: true, value: out };
}

export function parseContactFields(
  body: Record<string, unknown>,
  { requireName }: { requireName: boolean },
): Parsed<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined || requireName) {
    if (typeof body.name !== "string" || !body.name.trim())
      return { ok: false, detail: "name is required" };
    if (body.name.trim().length > MAX_NAME)
      return { ok: false, detail: `name must be at most ${MAX_NAME} characters` };
    out.name = body.name.trim();
  }
  for (const [key, max] of [
    ["role", 200],
    ["email", 320],
    ["phone", 100],
    ["notes", MAX_FIELD],
  ] as const) {
    const parsed = optionalText(body, key, max);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) out[key] = parsed.value;
  }
  if (typeof out.email === "string" && !EMAIL_RE.test(out.email))
    return { ok: false, detail: "email is not a valid address" };
  return { ok: true, value: out };
}


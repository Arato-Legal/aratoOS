// Per-workspace integration settings for clients and matters: the Hubflo link
// templates and the workspace-wide Google Drive connection.
//
// Hubflo links: an admin sets one https URL template per record type with an
// {id} placeholder (the record's Hubflo id). A link is built only for rows
// that were synced from Hubflo, so a hand-made client never gets a link.
//
// Drive: an admin makes their own Google connection the workspace's, so
// members browse, create and edit folders without connecting Google
// themselves. Every member then reaches Drive as that account.

import { getOrgRole, isOrgAdmin } from "../../lib/access";
import type { ConnectorOwner } from "../../lib/connectorOwner";
import { teamOrgIdOf } from "../../lib/personalOrgs";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { PERSONAL_WORKSPACE, type WorkspaceFilter } from "../../lib/workspace";

export type LinkKind = "client" | "matter" | "contact";

export type IntegrationSettings = {
  hubflo_client_url: string | null;
  hubflo_matter_url: string | null;
  hubflo_contact_url: string | null;
  /** Whether Drive is connected once for the whole workspace. */
  drive_shared: boolean;
  /** Whether the caller is the one whose Google account is shared. */
  drive_shared_by_me: boolean;
};

type SettingsRow = {
  hubflo_client_url: string | null;
  hubflo_matter_url: string | null;
  hubflo_contact_url: string | null;
  drive_owner_user_id: string | null;
};

const URL_KEYS = ["hubflo_client_url", "hubflo_matter_url", "hubflo_contact_url"] as const;
const COLUMNS =
  "hubflo_client_url, hubflo_matter_url, hubflo_contact_url, drive_owner_user_id";

export async function loadSettingsRow(
  db: Db,
  orgId: string | null | undefined,
): Promise<SettingsRow | null> {
  if (!orgId) return null;
  const { data } = await db
    .from("org_integration_settings")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .maybeSingle();
  return (data as SettingsRow | null) ?? null;
}

/** The Google Drive connection a member uses in this workspace. */
export async function driveOwnerFor(
  db: Db,
  userId: string,
  orgId: string | null | undefined,
): Promise<ConnectorOwner> {
  const teamOrg = await teamOrgIdOf(db, orgId ?? null);
  if (!teamOrg) return { userId, orgId: null };
  const settings = await loadSettingsRow(db, teamOrg);
  return { userId: settings?.drive_owner_user_id ?? userId, orgId: teamOrg };
}

export type HubfloLinks = {
  link: (kind: LinkKind, source: string | null | undefined, id: string | null | undefined) => string | null;
};

const TEMPLATE_KEY: Record<LinkKind, (typeof URL_KEYS)[number]> = {
  client: "hubflo_client_url",
  matter: "hubflo_matter_url",
  contact: "hubflo_contact_url",
};

/** Link builder for a workspace; every link is null when nothing is configured. */
export async function hubfloLinks(
  db: Db,
  orgId: string | null | undefined,
): Promise<HubfloLinks> {
  const settings = await loadSettingsRow(db, orgId);
  return {
    link(kind, source, id) {
      const template = settings?.[TEMPLATE_KEY[kind]];
      if (!template || source !== "hubflo" || !id) return null;
      return template.replace("{id}", encodeURIComponent(id));
    },
  };
}

async function adminRole(db: Db, userId: string, workspace: WorkspaceFilter) {
  if (!workspace || workspace === PERSONAL_WORKSPACE)
    return failure("validation", "Integration settings belong to a team workspace.", "workspace_required");
  const orgId = await teamOrgIdOf(db, workspace);
  const role = orgId ? await getOrgRole(userId, orgId, db) : null;
  if (!orgId || !role) return failure("not_found", "Workspace not found", "workspace_not_found");
  if (!isOrgAdmin(role)) return failure("forbidden", "Only a workspace admin can change these settings.");
  return ok(orgId);
}

function present(row: SettingsRow | null, userId: string): IntegrationSettings {
  return {
    hubflo_client_url: row?.hubflo_client_url ?? null,
    hubflo_matter_url: row?.hubflo_matter_url ?? null,
    hubflo_contact_url: row?.hubflo_contact_url ?? null,
    drive_shared: !!row?.drive_owner_user_id,
    drive_shared_by_me: row?.drive_owner_user_id === userId,
  };
}

export async function getIntegrationSettings(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter },
): Promise<ServiceResult<IntegrationSettings>> {
  const org = await adminRole(db, args.userId, args.workspace);
  if (!org.ok) return org;
  return ok(present(await loadSettingsRow(db, org.data), args.userId));
}

function parseTemplate(value: unknown): { ok: true; value: string | null | undefined } | { ok: false; detail: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, detail: "A link template must be text." };
  const trimmed = value.trim();
  if (trimmed.length > 500) return { ok: false, detail: "A link template is too long." };
  if (!/^https:\/\//i.test(trimmed)) return { ok: false, detail: "A link template must start with https://" };
  if (!trimmed.includes("{id}")) return { ok: false, detail: "A link template must contain {id}." };
  try {
    new URL(trimmed.replace("{id}", "x"));
  } catch {
    return { ok: false, detail: "A link template is not a valid URL." };
  }
  return { ok: true, value: trimmed };
}

// `drive_shared: true` makes the caller's own Google connection the
// workspace's, which needs that connection to exist; false clears it, but only
// for the person who set it or any admin (admins already manage the workspace).
export async function updateIntegrationSettings(
  db: Db,
  args: { userId: string; workspace: WorkspaceFilter; body: Record<string, unknown> },
): Promise<ServiceResult<IntegrationSettings>> {
  const org = await adminRole(db, args.userId, args.workspace);
  if (!org.ok) return org;

  const patch: Record<string, unknown> = {};
  for (const key of URL_KEYS) {
    const parsed = parseTemplate(args.body[key]);
    if (!parsed.ok) return failure("validation", parsed.detail);
    if (parsed.value !== undefined) patch[key] = parsed.value;
  }
  if (args.body.drive_shared !== undefined) {
    if (typeof args.body.drive_shared !== "boolean")
      return failure("validation", "drive_shared must be true or false");
    if (args.body.drive_shared) {
      const { data, error } = await db
        .from("user_google_drive_tokens")
        .select("user_id")
        .eq("user_id", args.userId)
        .eq("org_id", org.data)
        .not("encrypted_access_token", "is", null)
        .maybeSingle();
      if (error) return internalFailure(error);
      if (!data)
        return failure(
          "validation",
          "Connect Google Drive in this workspace first, then share it.",
          "drive_not_connected",
        );
      patch.drive_owner_user_id = args.userId;
    } else {
      patch.drive_owner_user_id = null;
    }
  }
  if (Object.keys(patch).length === 0) return failure("validation", "No settings to update");

  const { error } = await db
    .from("org_integration_settings")
    .upsert({ org_id: org.data, ...patch, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (error) return internalFailure(error);
  return ok(present(await loadSettingsRow(db, org.data), args.userId));
}

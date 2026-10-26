-- Migration date: 2026-10-26
--
-- Inbound CRM sync. A workspace owner creates a webhook endpoint (a secret URL
-- plus a bearer secret) that an outside system such as Hubflo pushes clients
-- and matters to. Records are matched by (source, external id) so a repeated
-- or out-of-order push updates the same row. Safe to re-run.

create table if not exists public.crm_sync_endpoints (
  id uuid primary key default gen_random_uuid(),
  -- The member who created it. Synced matters are created as this person, so
  -- the endpoint goes with them.
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  provider text not null default 'hubflo'
    constraint crm_sync_endpoints_provider_check
      check (provider in ('hubflo', 'generic')),
  -- 64 hex characters; the secret path of the webhook URL.
  token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  -- sha256 of the bearer secret; the secret itself is shown once.
  secret_hash text not null,
  enabled boolean not null default true,
  -- Who can open matters the endpoint creates in an organization.
  matter_visibility text not null default 'private'
    constraint crm_sync_endpoints_visibility_check
      check (matter_visibility in ('private', 'organization')),
  last_received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_sync_endpoints_visibility_scope_check
    check (matter_visibility = 'private' or org_id is not null)
);

create index if not exists idx_crm_sync_endpoints_org
  on public.crm_sync_endpoints(org_id);
create index if not exists idx_crm_sync_endpoints_user
  on public.crm_sync_endpoints(user_id);

alter table public.crm_sync_endpoints enable row level security;
revoke all on public.crm_sync_endpoints from anon, authenticated;

-- What each push did. No payload bodies: client details do not belong in a log.
create table if not exists public.crm_sync_events (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null
    references public.crm_sync_endpoints(id) on delete cascade,
  received_at timestamptz not null default now(),
  event_type text,
  external_id text,
  outcome text not null
    constraint crm_sync_events_outcome_check
      check (outcome in ('created', 'updated', 'unchanged', 'stale', 'rejected')),
  error_code text
);

create index if not exists idx_crm_sync_events_endpoint
  on public.crm_sync_events(endpoint_id, received_at desc);

alter table public.crm_sync_events enable row level security;
revoke all on public.crm_sync_events from anon, authenticated;

-- External identity on synced rows.
alter table public.clients
  add column if not exists external_source text,
  add column if not exists external_id text,
  add column if not exists external_synced_at timestamptz;
alter table public.clients
  drop constraint if exists clients_external_check;
alter table public.clients
  add constraint clients_external_check
  check ((external_source is null) = (external_id is null));

alter table public.projects
  add column if not exists external_source text,
  add column if not exists external_id text,
  add column if not exists external_synced_at timestamptz;
alter table public.projects
  drop constraint if exists projects_external_check;
alter table public.projects
  add constraint projects_external_check
  check ((external_source is null) = (external_id is null));

alter table public.client_contacts
  add column if not exists external_id text;

create unique index if not exists clients_external_org_uniq
  on public.clients(org_id, external_source, external_id)
  where org_id is not null and external_id is not null;
create unique index if not exists clients_external_personal_uniq
  on public.clients(user_id, external_source, external_id)
  where org_id is null and external_id is not null;
create unique index if not exists projects_external_org_uniq
  on public.projects(org_id, external_source, external_id)
  where org_id is not null and external_id is not null;
create unique index if not exists projects_external_personal_uniq
  on public.projects(user_id, external_source, external_id)
  where org_id is null and external_id is not null;
create unique index if not exists client_contacts_external_uniq
  on public.client_contacts(client_id, external_id)
  where external_id is not null;

-- The backend reaches these tables as service_role. A fresh install gets that
-- from schema.sql's blanket grant; an upgraded database needs it spelled out.
grant select, insert, update, delete
  on public.crm_sync_endpoints, public.crm_sync_events to service_role;

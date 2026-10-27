-- Migration date: 2026-10-26
--
-- Client numbers (imported from Hubflo), per-workspace Hubflo link templates,
-- and an optional workspace-wide Google Drive connection, so members do not
-- each connect Drive. Safe to re-run.

alter table public.clients
  add column if not exists client_number text;

alter table public.clients
  drop constraint if exists clients_client_number_check;
alter table public.clients
  add constraint clients_client_number_check
  check (client_number is null or char_length(client_number) <= 100);

-- One row per team workspace. The Hubflo templates hold an https URL with an
-- {id} placeholder that is filled with the record's Hubflo id. Drive is read
-- through the Google connection of drive_owner_user_id for every member.
create table if not exists public.org_integration_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  hubflo_client_url text,
  hubflo_matter_url text,
  hubflo_contact_url text,
  drive_owner_user_id uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint org_integration_settings_urls_check check (
    (hubflo_client_url is null or (hubflo_client_url ~ '^https://' and char_length(hubflo_client_url) <= 500))
    and (hubflo_matter_url is null or (hubflo_matter_url ~ '^https://' and char_length(hubflo_matter_url) <= 500))
    and (hubflo_contact_url is null or (hubflo_contact_url ~ '^https://' and char_length(hubflo_contact_url) <= 500))
  )
);

alter table public.org_integration_settings enable row level security;
revoke all on public.org_integration_settings from anon, authenticated;

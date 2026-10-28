-- Migration date: 2026-10-27
--
-- The Drive folders shown as Library tabs: the root folder that holds the
-- firm's matter folders, and the precedents/research folder. One row per
-- workspace and kind: a team workspace is keyed by org_id (set by an admin),
-- a personal workspace by user_id. Safe to re-run.

create table if not exists public.workspace_drive_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  kind text not null,
  drive_folder_id text not null,
  drive_folder_name text not null,
  updated_at timestamptz not null default now(),
  constraint workspace_drive_folders_kind_check check (kind in ('matters', 'precedents')),
  constraint workspace_drive_folders_owner_check check ((org_id is null) <> (user_id is null)),
  constraint workspace_drive_folders_folder_check check (
    drive_folder_id ~ '^[A-Za-z0-9_-]{1,200}$' and char_length(drive_folder_name) <= 500
  )
);

drop index if exists workspace_drive_folders_org_kind_idx;
create unique index workspace_drive_folders_org_kind_idx
  on public.workspace_drive_folders (org_id, kind) where org_id is not null;
drop index if exists workspace_drive_folders_user_kind_idx;
create unique index workspace_drive_folders_user_kind_idx
  on public.workspace_drive_folders (user_id, kind) where user_id is not null;

alter table public.workspace_drive_folders enable row level security;
revoke all on public.workspace_drive_folders from anon, authenticated;

-- The backend reaches these tables as service_role. A fresh install gets that
-- from schema.sql's blanket grant; an upgraded database needs it spelled out.
grant select, insert, update, delete on public.workspace_drive_folders to service_role;

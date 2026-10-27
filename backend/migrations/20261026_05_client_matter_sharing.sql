-- Migration date: 2026-10-26
--
-- A client can have a Google Drive folder that holds its matter folders, and
-- each matter can let the client's other matters read its data. Sharing
-- defaults to on, including for existing matters. Safe to re-run.

alter table public.clients
  add column if not exists drive_folder_id text,
  add column if not exists drive_folder_name text;

alter table public.clients
  drop constraint if exists clients_drive_folder_check;
alter table public.clients
  add constraint clients_drive_folder_check
  check (
    (drive_folder_id is null and drive_folder_name is null)
    or (drive_folder_id is not null and length(drive_folder_id) <= 200)
  );

alter table public.projects
  add column if not exists share_with_client boolean not null default true;

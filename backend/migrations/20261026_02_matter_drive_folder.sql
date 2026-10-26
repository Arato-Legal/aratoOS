-- Migration date: 2026-10-26
--
-- A matter (project) can be linked to its Google Drive matter folder. The
-- dashboard lists that folder's "Work in progress" subfolder through each
-- viewer's own Google connection. Safe to re-run.

alter table public.projects
  add column if not exists drive_folder_id text,
  add column if not exists drive_folder_name text;

alter table public.projects
  drop constraint if exists projects_drive_folder_check;
alter table public.projects
  add constraint projects_drive_folder_check
  check (
    (drive_folder_id is null and drive_folder_name is null)
    or (drive_folder_id is not null and length(drive_folder_id) <= 200)
  );

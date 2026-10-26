-- Migration date: 2026-10-26
--
-- A Mike document edited from a matter's Drive workspace remembers which Drive
-- file it came from, so it can be saved back to that same file and so Mike can
-- tell when either side has changed since the last sync. Safe to re-run.

create table if not exists public.document_drive_links (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique
    references public.documents(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  drive_file_id text not null check (length(drive_file_id) <= 200),
  drive_mime_type text not null,
  drive_name text,
  -- Drive's modifiedTime and the .docx hash as of the last sync either way.
  drive_modified_time timestamptz,
  synced_sha256 text,
  synced_at timestamptz not null default now(),
  linked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, drive_file_id)
);

alter table public.document_drive_links enable row level security;
revoke all on public.document_drive_links from anon, authenticated;

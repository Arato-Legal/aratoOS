-- Migration date: 2026-10-26
--
-- What a matter's chats teach the client's memory is kept as that matter's own
-- notes, apart from the client's base memory file. Client sessions read the base
-- file plus the notes of matters whose sharing is on. Switching a matter's
-- sharing off (or moving it to another client) deletes its notes, so the
-- removal is exact. Safe to re-run.

create table if not exists public.client_memory_notes (
  client_id uuid not null references public.clients(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  content text not null default '',
  size_bytes integer not null default 0
    check (size_bytes >= 0 and size_bytes <= 16384),
  last_source_job_id uuid,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (client_id, project_id)
);

create index if not exists client_memory_notes_project_idx
  on public.client_memory_notes(project_id);
create index if not exists client_memory_notes_updated_by_idx
  on public.client_memory_notes(updated_by) where updated_by is not null;

alter table public.client_memory_notes enable row level security;
revoke all on public.client_memory_notes from anon, authenticated;

-- The backend reaches these tables as service_role. A fresh install gets that
-- from schema.sql's blanket grant; an upgraded database needs it spelled out.
grant select, insert, update, delete on public.client_memory_notes to service_role;

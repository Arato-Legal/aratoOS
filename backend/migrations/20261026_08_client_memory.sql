-- Migration date: 2026-10-26
--
-- Client-level memory. A client keeps one Markdown memory file that every
-- conversation of that client reads, at client level and in every matter. It is
-- learned by a separate curator job from client-level chats and from matter
-- chats (unless the matter's sharing is off), and can be edited by hand by the
-- client's creator or an organization admin. The cursor table records how far
-- each chat has been learned from. Safe to re-run.

create table if not exists public.client_memory_files (
  client_id uuid primary key references public.clients(id) on delete cascade,
  enabled boolean not null default true,
  -- Compare-and-swap token: has this row moved since you read it?
  revision bigint not null default 0 check (revision >= 0),
  content text not null default '',
  size_bytes integer not null default 0
    check (size_bytes >= 0 and size_bytes <= 16384),
  -- The curator job that last applied a write, so a retried job is a no-op.
  last_source_job_id uuid,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_memory_files_updated_by_idx
  on public.client_memory_files(updated_by) where updated_by is not null;

alter table public.client_memory_files enable row level security;
revoke all on public.client_memory_files from anon, authenticated;

create table if not exists public.client_memory_cursors (
  client_id uuid not null references public.clients(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  -- Messages up to here have been considered for this client's memory.
  last_message_at timestamptz not null,
  primary key (client_id, chat_id)
);

create index if not exists client_memory_cursors_chat_idx
  on public.client_memory_cursors(chat_id);

alter table public.client_memory_cursors enable row level security;
revoke all on public.client_memory_cursors from anon, authenticated;

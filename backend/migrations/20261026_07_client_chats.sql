-- Migration date: 2026-10-26
--
-- Assistant chats can be run at the client level. A client chat has no
-- matter (project_id is null) and records the client it was run for. Access
-- to the chat itself is unchanged (its author, or its direct grants). Safe to
-- re-run.

alter table public.chats
  add column if not exists client_id uuid
  references public.clients(id) on delete cascade;

alter table public.chats
  drop constraint if exists chats_scope_check;
alter table public.chats
  add constraint chats_scope_check
  check (project_id is null or client_id is null);

create index if not exists idx_chats_client
  on public.chats(client_id) where client_id is not null;

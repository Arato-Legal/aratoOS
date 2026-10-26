-- Migration date: 2026-10-26
--
-- Clients, client contacts, and projects.client_id (a matter belongs to a client).
-- Safe to re-run.

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  -- Client data belongs to the organization and goes with it when purged.
  org_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  kind text not null default 'organization'
    constraint clients_kind_check check (kind in ('individual', 'organization')),
  status text not null default 'active'
    constraint clients_status_check check (status in ('lead', 'active', 'closed')),
  email text,
  phone text,
  address text,
  source text,
  notes text,
  custom_fields jsonb not null default '{}'::jsonb
    constraint clients_custom_fields_object check (jsonb_typeof(custom_fields) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_clients_org on public.clients(org_id);
create index if not exists idx_clients_user on public.clients(user_id);
create index if not exists idx_clients_updated_at
  on public.clients(updated_at desc, id);

alter table public.clients enable row level security;
revoke all on public.clients from anon, authenticated;

create table if not exists public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_client_contacts_client
  on public.client_contacts(client_id);

alter table public.client_contacts enable row level security;
revoke all on public.client_contacts from anon, authenticated;

alter table public.projects
  add column if not exists client_id uuid
  references public.clients(id) on delete set null;

create index if not exists idx_projects_client
  on public.projects(client_id) where client_id is not null;

-- The backend reaches these tables as service_role. A fresh install gets that
-- from schema.sql's blanket grant; an upgraded database needs it spelled out.
revoke all privileges on table public.clients, public.client_contacts
  from anon, authenticated;
grant select, insert, update, delete on public.clients, public.client_contacts
  to service_role;

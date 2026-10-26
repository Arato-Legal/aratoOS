-- Migration date: 2026-10-26
--
-- Public intake forms and their submission queue. A form is reached by an
-- unguessable token without signing in; each submission waits in a queue
-- until somebody in the workspace approves it (creating a lead client) or
-- rejects it. Access is enforced by the backend (service role).
-- Safe to re-run.

create table if not exists public.intake_forms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  org_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  title text not null,
  description text,
  -- 64 hex characters from two random UUIDs; the capability to submit.
  token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_intake_forms_org on public.intake_forms(org_id);
create index if not exists idx_intake_forms_user on public.intake_forms(user_id);

alter table public.intake_forms enable row level security;
revoke all on public.intake_forms from anon, authenticated;

create table if not exists public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.intake_forms(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  message text,
  status text not null default 'pending'
    constraint form_submissions_status_check
      check (status in ('pending', 'approved', 'rejected')),
  client_id uuid references public.clients(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_form_submissions_form_status
  on public.form_submissions(form_id, status, created_at desc);

alter table public.form_submissions enable row level security;
revoke all on public.form_submissions from anon, authenticated;

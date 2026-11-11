-- Disposable PostgreSQL harness for the cloud video migrations.
-- This intentionally stubs only the Supabase primitives required by these migrations.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end
$roles$;

create schema auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid()
returns uuid
language sql stable
set search_path = pg_catalog
as $auth_uid$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$auth_uid$;

create or replace function auth.role()
returns text
language sql stable
set search_path = pg_catalog
as $auth_role$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$auth_role$;

create schema executive_visuals;
grant usage on schema auth to authenticated, service_role;
grant usage on schema executive_visuals to authenticated, service_role;

create table executive_visuals.projects (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null
);

create table executive_visuals.project_members (
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('editor','reviewer','viewer')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  primary key(project_id,member_id)
);
grant select on executive_visuals.project_members to authenticated, service_role;
alter table executive_visuals.projects enable row level security;
grant select on executive_visuals.projects to authenticated;
create policy test_project_owner_read on executive_visuals.projects
  for select to authenticated using (owner_id = (select auth.uid()));
create table executive_visuals.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  job_type text not null,
  status text not null,
  progress numeric(5,2) not null default 0,
  input jsonb not null,
  output jsonb,
  error jsonb,
  idempotency_key text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 2,
  available_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  lease_heartbeat_at timestamptz,
  started_at timestamptz,
  estimated_cost jsonb,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(owner_id,idempotency_key)
);
create table executive_visuals.assets (
  id uuid primary key,
  owner_id uuid not null references auth.users(id),
  project_id uuid references executive_visuals.projects(id),
  original_name text not null,
  media_type text not null,
  byte_size bigint not null,
  sha256 text not null,
  storage_bucket text not null,
  object_path text not null unique,
  derivative_of uuid references executive_visuals.assets(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table executive_visuals.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references executive_visuals.jobs(id),
  owner_id uuid not null references auth.users(id),
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table executive_visuals.audit_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id),
  project_id uuid references executive_visuals.projects(id),
  event_type text not null,
  subject_type text not null,
  subject_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function executive_visuals.prevent_owner_reassignment()
returns trigger language plpgsql set search_path=pg_catalog as $owner_guard$
begin
  if new.owner_id is distinct from old.owner_id then raise exception 'owner_id is immutable'; end if;
  return new;
end;
$owner_guard$;

grant all on all tables in schema executive_visuals to service_role;
grant usage, select on all sequences in schema executive_visuals to service_role;

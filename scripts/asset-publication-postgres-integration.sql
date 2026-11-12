\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('44444444-4444-4444-8444-444444444444')
on conflict(id) do nothing;

insert into executive_visuals.projects(id,owner_id,name) values
 ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Asset publication integration')
on conflict(id) do nothing;

do $publication_privileges$
declare
  v_table regclass := 'executive_visuals.asset_publications'::regclass;
  v_rls boolean;
begin
  select relrowsecurity into v_rls from pg_class where oid=v_table;
  if not v_rls then raise exception 'asset publication ledger must enable RLS'; end if;
  if has_table_privilege('anon',v_table,'SELECT') or has_table_privilege('authenticated',v_table,'SELECT')
     or has_table_privilege('anon',v_table,'INSERT') or has_table_privilege('authenticated',v_table,'INSERT')
     or has_table_privilege('anon',v_table,'UPDATE') or has_table_privilege('authenticated',v_table,'UPDATE')
     or has_table_privilege('anon',v_table,'DELETE') or has_table_privilege('authenticated',v_table,'DELETE') then
    raise exception 'browser roles must not access asset publication ledger';
  end if;
  if not has_table_privilege('service_role',v_table,'SELECT')
     or not has_table_privilege('service_role',v_table,'INSERT')
     or not has_table_privilege('service_role',v_table,'UPDATE') then
    raise exception 'service_role must have required publication ledger privileges';
  end if;
  if has_function_privilege('anon','executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid)','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid)','EXECUTE')
     or has_function_privilege('anon','executive_visuals.complete_asset_publication(uuid,text,uuid)','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.complete_asset_publication(uuid,text,uuid)','EXECUTE') then
    raise exception 'browser roles must not execute asset publication RPCs';
  end if;
  if not has_function_privilege('service_role','executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.complete_asset_publication(uuid,text,uuid)','EXECUTE') then
    raise exception 'service_role must execute asset publication RPCs';
  end if;
end
$publication_privileges$;

set role service_role;
do $publication_behavior$
declare
  first_reservation record;
  replay_reservation record;
  completed record;
  expected_asset uuid := '33333333-3333-4333-8333-333333333333';
begin
  select * into first_reservation
  from executive_visuals.reserve_asset_publication(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'job-integration:output:v1', repeat('a',64), expected_asset
  );

  select * into replay_reservation
  from executive_visuals.reserve_asset_publication(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'job-integration:output:v1', repeat('a',64),
    '55555555-5555-4555-8555-555555555555'
  );

  if first_reservation.asset_id is distinct from replay_reservation.asset_id
     or replay_reservation.asset_id is distinct from expected_asset then
    raise exception 'idempotent reservation did not preserve the first asset identity';
  end if;

  begin
    perform * from executive_visuals.reserve_asset_publication(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'job-integration:output:v1', repeat('b',64),
      '66666666-6666-4666-8666-666666666666'
    );
    raise exception using errcode='P9999', message='expected checksum conflict was not rejected';
  exception when unique_violation then
    null;
  end;

  begin
    perform * from executive_visuals.complete_asset_publication(
      '11111111-1111-4111-8111-111111111111',
      'job-integration:output:v1', expected_asset
    );
    raise exception using errcode='P9999', message='publication completed without a matching asset';
  exception when raise_exception then
    if sqlerrm = 'publication completed without a matching asset' then raise; end if;
    if sqlerrm <> 'publication cannot be completed without its matching active asset' then raise; end if;
  end;

  insert into executive_visuals.assets(
    id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,deleted_at
  ) values (
    expected_asset,'11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222','render.mp4','video/mp4',4,repeat('a',64),
    'executive-visuals-media',
    '22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/original.mp4',null
  );

  select * into completed
  from executive_visuals.complete_asset_publication(
    '11111111-1111-4111-8111-111111111111',
    'job-integration:output:v1', expected_asset
  );

  if completed.status <> 'published' or completed.asset_id <> expected_asset or completed.published_at is null then
    raise exception 'matching asset publication did not complete';
  end if;

  if (select count(*) from executive_visuals.asset_publications
      where owner_id='11111111-1111-4111-8111-111111111111'
        and publication_key='job-integration:output:v1') <> 1 then
    raise exception 'publication replay created duplicate ledger rows';
  end if;
end
$publication_behavior$;
reset role;

select 'asset publication PostgreSQL integration passed' as result;


-- Run cloud video migration and approval/settlement integration tests in an isolated disposable database.
\connect cloud_video_test
\set ON_ERROR_STOP on

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

create table executive_visuals.customer_subscriptions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  status text not null check (status in ('pending','trialing','active','past_due','cancelled','expired','suspended')),
  current_period_start timestamptz not null,
  current_period_end timestamptz,
  entitlements_snapshot jsonb not null check (jsonb_typeof(entitlements_snapshot)='object')
);

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


-- 20261104120000_cloud_video_submission_ledger.sql
-- Cloud-only durable provider submission ledger for hosted video generation.
-- Source-controlled only. Apply to a dedicated development Supabase project after review;
-- this migration is not applied to shared staging or production.

create table if not exists executive_visuals.video_generation_submissions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references executive_visuals.jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 100),
  model text not null check (char_length(model) between 1 and 160),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'prepared' check (state in ('prepared','submitting','submitted','unknown','succeeded','failed','cancelled')),
  provider_task_id text unique check (provider_task_id is null or char_length(provider_task_id) between 1 and 256),
  submission_started_at timestamptz,
  submitted_at timestamptz,
  updated_at timestamptz not null default now(),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8000),
  check ((state in ('submitted','succeeded') and provider_task_id is not null) or state not in ('submitted','succeeded'))
);

create index if not exists ev_video_submissions_owner_updated
  on executive_visuals.video_generation_submissions(owner_id, updated_at desc);
create index if not exists ev_video_submissions_state_updated
  on executive_visuals.video_generation_submissions(state, updated_at);

alter table executive_visuals.video_generation_submissions enable row level security;
revoke all on executive_visuals.video_generation_submissions from public, anon, authenticated;
grant all privileges on executive_visuals.video_generation_submissions to service_role;

create or replace function executive_visuals.prepare_video_generation_submission(
  p_job_id uuid, p_owner_id uuid, p_provider text, p_model text, p_request_hash text
) returns setof executive_visuals.video_generation_submissions
language plpgsql security invoker
set search_path = pg_catalog, executive_visuals
as $$
declare
  queued executive_visuals.jobs;
  existing executive_visuals.video_generation_submissions;
begin
  if p_provider is null or char_length(p_provider) not between 1 and 100
     or p_model is null or char_length(p_model) not between 1 and 160
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'VIDEO_SUBMISSION_ARGUMENTS_INVALID';
  end if;
  select * into queued from executive_visuals.jobs
  where id = p_job_id and owner_id = p_owner_id and job_type = 'video.generate';
  if queued.id is null then raise exception 'VIDEO_SUBMISSION_JOB_SCOPE_INVALID'; end if;
  if coalesce(queued.input ->> 'provider','') <> p_provider
     or coalesce(queued.input ->> 'model','') <> p_model
     or coalesce(queued.input ->> 'requestHash','') <> p_request_hash then
    raise exception 'VIDEO_SUBMISSION_REQUEST_MISMATCH';
  end if;
  insert into executive_visuals.video_generation_submissions
    (job_id,owner_id,provider,model,request_hash,state)
  values (p_job_id,p_owner_id,p_provider,p_model,p_request_hash,'prepared')
  on conflict (job_id) do nothing;
  select * into existing from executive_visuals.video_generation_submissions where job_id = p_job_id;
  if existing.owner_id <> p_owner_id or existing.provider <> p_provider
     or existing.model <> p_model or existing.request_hash <> p_request_hash then
    raise exception 'VIDEO_SUBMISSION_CONFLICT';
  end if;
  return next existing;
end;
$$;

create or replace function executive_visuals.begin_video_generation_submission(
  p_job_id uuid, p_worker_id text
) returns boolean
language plpgsql security invoker
set search_path = pg_catalog, executive_visuals
as $$
declare changed integer;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then
    raise exception 'VIDEO_SUBMISSION_WORKER_INVALID';
  end if;
  update executive_visuals.video_generation_submissions s
  set state='submitting', submission_started_at=clock_timestamp(), updated_at=clock_timestamp(), last_error_code=null
  from executive_visuals.jobs j
  where s.job_id=p_job_id and j.id=s.job_id and j.job_type='video.generate'
    and j.status='processing' and j.lease_owner=p_worker_id and j.lease_expires_at > clock_timestamp()
    and s.state='prepared';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function executive_visuals.record_video_generation_submission(
  p_job_id uuid, p_worker_id text, p_provider_task_id text, p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql security invoker
set search_path = pg_catalog, executive_visuals
as $$
declare changed integer; current_task text; current_state text;
begin
  if p_provider_task_id is null or char_length(btrim(p_provider_task_id)) not between 1 and 256
     or jsonb_typeof(coalesce(p_metadata,'{}'::jsonb)) <> 'object'
     or octet_length(coalesce(p_metadata,'{}'::jsonb)::text) > 8000 then
    raise exception 'VIDEO_SUBMISSION_RESULT_INVALID';
  end if;
  update executive_visuals.video_generation_submissions s
  set state='submitted', provider_task_id=p_provider_task_id, submitted_at=clock_timestamp(),
      updated_at=clock_timestamp(), metadata=coalesce(p_metadata,'{}'::jsonb), last_error_code=null
  from executive_visuals.jobs j
  where s.job_id=p_job_id and j.id=s.job_id and j.status='processing'
    and j.lease_owner=p_worker_id and j.lease_expires_at > clock_timestamp()
    and s.state='submitting';
  get diagnostics changed = row_count;
  if changed = 1 then return true; end if;
  select provider_task_id,state into current_task,current_state
  from executive_visuals.video_generation_submissions where job_id=p_job_id;
  if current_state='submitted' and current_task=p_provider_task_id then return true; end if;
  if current_task is not null and current_task <> p_provider_task_id then
    raise exception 'VIDEO_SUBMISSION_TASK_CONFLICT';
  end if;
  return false;
end;
$$;

create or replace function executive_visuals.mark_video_generation_submission_unknown(
  p_job_id uuid, p_worker_id text, p_error_code text
) returns boolean
language plpgsql security invoker
set search_path = pg_catalog, executive_visuals
as $$
declare changed integer;
begin
  update executive_visuals.video_generation_submissions s
  set state='unknown', updated_at=clock_timestamp(),
      last_error_code=left(coalesce(nullif(p_error_code,''),'VIDEO_SUBMISSION_AMBIGUOUS'),100)
  from executive_visuals.jobs j
  where s.job_id=p_job_id and j.id=s.job_id and j.status='processing'
    and j.lease_owner=p_worker_id and j.lease_expires_at > clock_timestamp()
    and s.state='submitting' and s.provider_task_id is null;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function executive_visuals.get_video_generation_submission(p_job_id uuid)
returns setof executive_visuals.video_generation_submissions
language sql security invoker
set search_path = pg_catalog, executive_visuals
as $$
  select s.* from executive_visuals.video_generation_submissions s
  join executive_visuals.jobs j on j.id=s.job_id
  where s.job_id=p_job_id and s.owner_id=j.owner_id and j.job_type='video.generate'
$$;

revoke all on function executive_visuals.prepare_video_generation_submission(uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function executive_visuals.begin_video_generation_submission(uuid,text) from public, anon, authenticated;
revoke all on function executive_visuals.record_video_generation_submission(uuid,text,text,jsonb) from public, anon, authenticated;
revoke all on function executive_visuals.mark_video_generation_submission_unknown(uuid,text,text) from public, anon, authenticated;
revoke all on function executive_visuals.get_video_generation_submission(uuid) from public, anon, authenticated;
grant execute on function executive_visuals.prepare_video_generation_submission(uuid,uuid,text,text,text) to service_role;
grant execute on function executive_visuals.begin_video_generation_submission(uuid,text) to service_role;
grant execute on function executive_visuals.record_video_generation_submission(uuid,text,text,jsonb) to service_role;
grant execute on function executive_visuals.mark_video_generation_submission_unknown(uuid,text,text) to service_role;
grant execute on function executive_visuals.get_video_generation_submission(uuid) to service_role;

-- The ledger is intentionally not auto-retried by queue recovery. A worker must
-- inspect this row before any provider call; only 'prepared' may transition to submitting.
create or replace function executive_visuals.reconcile_unknown_video_generation_submission(
  p_job_id uuid, p_provider_task_id text, p_evidence_reference text, p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql security invoker
set search_path = pg_catalog, executive_visuals
as $$
declare changed integer; current_task text; current_state text;
begin
  if p_provider_task_id is null or char_length(btrim(p_provider_task_id)) not between 1 and 256
     or p_evidence_reference is null or char_length(btrim(p_evidence_reference)) not between 1 and 1000
     or jsonb_typeof(coalesce(p_metadata,'{}'::jsonb)) <> 'object'
     or octet_length(coalesce(p_metadata,'{}'::jsonb)::text) > 8000 then
    raise exception 'VIDEO_SUBMISSION_RECONCILIATION_INVALID';
  end if;
  update executive_visuals.video_generation_submissions
  set state='submitted', provider_task_id=p_provider_task_id, submitted_at=clock_timestamp(),
      updated_at=clock_timestamp(), last_error_code=null,
      metadata=coalesce(p_metadata,'{}'::jsonb) || jsonb_build_object('reconciled',true,'evidenceReference',p_evidence_reference)
  where job_id=p_job_id and state='unknown' and provider_task_id is null;
  get diagnostics changed = row_count;
  if changed=1 then return true; end if;
  select provider_task_id,state into current_task,current_state
  from executive_visuals.video_generation_submissions where job_id=p_job_id;
  if current_state='submitted' and current_task=p_provider_task_id then return true; end if;
  if current_task is not null and current_task <> p_provider_task_id then raise exception 'VIDEO_SUBMISSION_TASK_CONFLICT'; end if;
  return false;
end;
$$;

create or replace function executive_visuals.finish_video_generation_submission(
  p_job_id uuid, p_worker_id text, p_state text, p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql security invoker
set search_path = pg_catalog, executive_visuals
as $$
declare changed integer;
begin
  if p_state not in ('succeeded','failed','cancelled')
     or jsonb_typeof(coalesce(p_metadata,'{}'::jsonb)) <> 'object'
     or octet_length(coalesce(p_metadata,'{}'::jsonb)::text) > 8000 then
    raise exception 'VIDEO_SUBMISSION_TERMINAL_STATE_INVALID';
  end if;
  update executive_visuals.video_generation_submissions s
  set state=p_state, updated_at=clock_timestamp(), metadata=coalesce(p_metadata,'{}'::jsonb)
  from executive_visuals.jobs j
  where s.job_id=p_job_id and j.id=s.job_id and j.status='processing'
    and j.lease_owner=p_worker_id and j.lease_expires_at > clock_timestamp()
    and s.state in ('submitted','unknown')
    and (p_state <> 'succeeded' or s.provider_task_id is not null);
  get diagnostics changed = row_count;
  return changed=1;
end;
$$;

revoke all on function executive_visuals.reconcile_unknown_video_generation_submission(uuid,text,text,jsonb) from public, anon, authenticated;
revoke all on function executive_visuals.finish_video_generation_submission(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function executive_visuals.reconcile_unknown_video_generation_submission(uuid,text,text,jsonb) to service_role;
grant execute on function executive_visuals.finish_video_generation_submission(uuid,text,text,jsonb) to service_role;

-- 20261104143000_cloud_video_budget_enqueue.sql
-- Cloud video budget policy, explicit approval and atomic enqueue boundary.
-- Source-controlled only. Do not apply to shared staging or production from this PR.
-- Provider execution remains disabled by default. The service boundary and worker flags gate every remote provider submission.

create table if not exists executive_visuals.video_generation_budget_policies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 100),
  model text not null check (char_length(model) between 1 and 160),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  spend_limit_amount numeric(14,6) not null check (spend_limit_amount > 0),
  max_per_job_amount numeric(14,6) not null check (max_per_job_amount > 0 and max_per_job_amount <= spend_limit_amount),
  reserved_amount numeric(14,6) not null default 0 check (reserved_amount >= 0),
  spent_amount numeric(14,6) not null default 0 check (spent_amount >= 0),
  rolling_24h_request_limit integer not null default 0 check (rolling_24h_request_limit between 0 and 10000),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ev_video_budget_policy_scope
  on executive_visuals.video_generation_budget_policies
  (owner_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), provider, model);

create table if not exists executive_visuals.video_generation_budget_approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 100),
  model text not null check (char_length(model) between 1 and 160),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  approved_max_amount numeric(14,6) not null check (approved_max_amount > 0),
  approval_note text not null default '' check (char_length(approval_note) <= 1000),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table if not exists executive_visuals.video_generation_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references executive_visuals.jobs(id) on delete cascade,
  approval_id uuid not null unique references executive_visuals.video_generation_budget_approvals(id),
  policy_id uuid not null references executive_visuals.video_generation_budget_policies(id),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  provider text not null,
  model text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reserved_amount numeric(14,6) not null check (reserved_amount > 0),
  actual_amount numeric(14,6) check (actual_amount is null or actual_amount >= 0),
  state text not null default 'reserved' check (state in ('reserved','settled','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists executive_visuals.video_generation_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references executive_visuals.jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  model text not null,
  capability text not null default 'video.generate',
  created_at timestamptz not null default now()
);

create index if not exists ev_video_usage_owner_provider_created
  on executive_visuals.video_generation_usage_reservations(owner_id, provider, model, created_at desc);

alter table executive_visuals.video_generation_budget_policies enable row level security;
alter table executive_visuals.video_generation_budget_approvals enable row level security;
alter table executive_visuals.video_generation_budget_reservations enable row level security;
alter table executive_visuals.video_generation_usage_reservations enable row level security;

revoke all on executive_visuals.video_generation_budget_policies from public, anon, authenticated;
revoke all on executive_visuals.video_generation_budget_approvals from public, anon, authenticated;
revoke all on executive_visuals.video_generation_budget_reservations from public, anon, authenticated;
revoke all on executive_visuals.video_generation_usage_reservations from public, anon, authenticated;
grant select on executive_visuals.video_generation_budget_policies to authenticated;
-- Clients may configure limits but cannot forge the server-maintained accounting totals or scope.
grant insert (owner_id, project_id, provider, model, currency, spend_limit_amount, max_per_job_amount, rolling_24h_request_limit, enabled)
  on executive_visuals.video_generation_budget_policies to authenticated;
grant update (provider, model, currency, spend_limit_amount, max_per_job_amount, rolling_24h_request_limit, enabled, updated_at)
  on executive_visuals.video_generation_budget_policies to authenticated;
grant select, insert on executive_visuals.video_generation_budget_approvals to authenticated;
grant all privileges on executive_visuals.video_generation_budget_policies to service_role;
grant all privileges on executive_visuals.video_generation_budget_approvals to service_role;
grant all privileges on executive_visuals.video_generation_budget_reservations to service_role;
grant all privileges on executive_visuals.video_generation_usage_reservations to service_role;

create or replace function executive_visuals.validate_video_budget_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $$
begin
  if new.owner_id is distinct from auth.uid() then
    raise exception 'VIDEO_BUDGET_APPROVAL_OWNER_INVALID';
  end if;
  new.created_at := clock_timestamp();
  new.consumed_at := null;
  if new.expires_at <= clock_timestamp()
     or new.expires_at > clock_timestamp() + interval '15 minutes' then
    raise exception 'VIDEO_BUDGET_APPROVAL_EXPIRY_INVALID';
  end if;
  return new;
end;
$$;

create trigger ev_video_budget_approval_validate
  before insert on executive_visuals.video_generation_budget_approvals
  for each row execute function executive_visuals.validate_video_budget_approval();

create or replace function executive_visuals.validate_video_budget_policy_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $video_policy_scope$
begin
  if (new.provider is distinct from old.provider
      or new.model is distinct from old.model
      or new.currency is distinct from old.currency)
     and (old.reserved_amount > 0 or old.spent_amount > 0) then
    raise exception 'VIDEO_BUDGET_POLICY_SCOPE_LOCKED_AFTER_USE';
  end if;
  if new.spend_limit_amount < old.reserved_amount + old.spent_amount then
    raise exception 'VIDEO_BUDGET_LIMIT_BELOW_COMMITTED_SPEND';
  end if;
  return new;
end;
$video_policy_scope$;

create trigger ev_video_budget_policy_scope_immutable
  before update of provider, model, currency, spend_limit_amount on executive_visuals.video_generation_budget_policies
  for each row execute function executive_visuals.validate_video_budget_policy_scope();

create trigger ev_video_budget_policy_owner_immutable
  before update of owner_id on executive_visuals.video_generation_budget_policies
  for each row execute function executive_visuals.prevent_owner_reassignment();
create trigger ev_video_budget_approval_owner_immutable
  before update of owner_id on executive_visuals.video_generation_budget_approvals
  for each row execute function executive_visuals.prevent_owner_reassignment();

create policy ev_video_budget_policy_owner_all
  on executive_visuals.video_generation_budget_policies for all to authenticated
  using (
    owner_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from executive_visuals.projects p
      where p.id = video_generation_budget_policies.project_id
        and p.owner_id = (select auth.uid())
    ))
  )
  with check (
    owner_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from executive_visuals.projects p
      where p.id = video_generation_budget_policies.project_id
        and p.owner_id = (select auth.uid())
    ))
  );

create policy ev_video_budget_approval_owner_read
  on executive_visuals.video_generation_budget_approvals for select to authenticated
  using (owner_id = (select auth.uid()));

create policy ev_video_budget_approval_owner_insert
  on executive_visuals.video_generation_budget_approvals for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from executive_visuals.projects p
      where p.id = video_generation_budget_approvals.project_id
        and p.owner_id = (select auth.uid())
    ))
  );

create or replace function executive_visuals.enqueue_video_generation_job(
  p_owner_id uuid,
  p_project_id uuid,
  p_idempotency_key text,
  p_provider text,
  p_model text,
  p_request_hash text,
  p_input jsonb,
  p_budget_approval_id uuid,
  p_reserved_amount numeric,
  p_currency text
)
returns table(job_id uuid, job_status text, idempotent_replay boolean, budget_reservation_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_enqueue$
declare
  existing executive_visuals.jobs;
  policy executive_visuals.video_generation_budget_policies;
  approval executive_visuals.video_generation_budget_approvals;
  inserted_job executive_visuals.jobs;
  reservation_id uuid;
  used_requests bigint;
begin
  if p_owner_id is null
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,180}$'
     or p_provider is null or char_length(p_provider) not between 1 and 100
     or p_model is null or char_length(p_model) not between 1 and 160
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_input) <> 'object'
     or octet_length(p_input::text) > 32000
     or coalesce(p_input ->> 'provider','') <> p_provider
     or coalesce(p_input ->> 'model','') <> p_model
     or coalesce(p_input ->> 'requestHash','') <> p_request_hash
     or coalesce(p_input ->> 'projectId','') <> coalesce(p_project_id::text,'')
     or p_reserved_amount is null or p_reserved_amount <= 0
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'VIDEO_ENQUEUE_ARGUMENTS_INVALID';
  end if;
  if not (
    (p_provider = 'runway' and p_model = 'gen4.5')
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then
    raise exception 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED';
  end if;
  if p_currency <> 'USD' then
    raise exception 'VIDEO_PRICE_CURRENCY_UNSUPPORTED';
  end if;
  if coalesce(p_input ->> 'outputFormat','mp4') <> 'mp4' then
    raise exception 'VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED';
  end if;
  if p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_reserved_amount < ((p_input ->> 'durationSeconds')::numeric * 0.12) then
      raise exception 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE';
    end if;
  else
    -- Gemini Omni direct API preflight: 1,048,576 input tokens at $1.50/M
    -- plus 57,920 output video tokens (10s at 5,792 tokens/s) at $17.50/M.
    -- The reservation is deliberately conservative; actual usage is reconciled
    -- from the completed interaction before budget settlement.
    if coalesce(p_input ->> 'durationSeconds','') not in ('3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if coalesce(p_input ->> 'resolution','provider_default') not in ('provider_default','720p') then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_RESOLUTION';
    end if;
    if p_reserved_amount < 2.586464 then
      raise exception 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':video.generate', 0));

  select * into existing from executive_visuals.jobs
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if existing.id is not null then
    if existing.job_type <> 'video.generate'
       or existing.project_id is distinct from p_project_id
       or coalesce(existing.input ->> 'requestHash','') <> p_request_hash
       or coalesce(existing.input ->> 'provider','') <> p_provider
       or coalesce(existing.input ->> 'model','') <> p_model then
      raise exception 'VIDEO_JOB_IDEMPOTENCY_CONFLICT';
    end if;
    select r.id into reservation_id
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = existing.id;
    return query select existing.id, existing.status, true, reservation_id;
    return;
  end if;

  if p_project_id is not null and not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id
    and b.project_id is not distinct from p_project_id
    and b.provider = p_provider and b.model = p_model
    and b.currency = p_currency and b.enabled = true
  for update;
  if policy.id is null then raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED'; end if;
  if p_reserved_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_reserved_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;

  select * into approval
  from executive_visuals.video_generation_budget_approvals a
  where a.id = p_budget_approval_id and a.owner_id = p_owner_id
  for update;
  if approval.id is null
     or approval.project_id is distinct from p_project_id
     or approval.provider <> p_provider or approval.model <> p_model
     or approval.request_hash <> p_request_hash or approval.currency <> p_currency
     or approval.approved_max_amount < p_reserved_amount
     or approval.expires_at <= clock_timestamp()
     or approval.consumed_at is not null then
    raise exception 'VIDEO_JOB_BUDGET_APPROVAL_INVALID';
  end if;

  select count(*) into used_requests
  from executive_visuals.video_generation_usage_reservations u
  where u.owner_id = p_owner_id and u.provider = p_provider and u.model = p_model
    and u.created_at >= clock_timestamp() - interval '24 hours';
  if policy.rolling_24h_request_limit = 0 or used_requests >= policy.rolling_24h_request_limit then
    raise exception 'VIDEO_JOB_USAGE_LIMIT_REACHED';
  end if;

  insert into executive_visuals.jobs(
    owner_id, project_id, job_type, status, input, idempotency_key,
    estimated_cost, approved_by, approved_at
  ) values (
    p_owner_id, p_project_id, 'video.generate', 'queued', p_input, p_idempotency_key,
    jsonb_build_object('amount', p_reserved_amount, 'currency', p_currency),
    p_owner_id, clock_timestamp()
  ) returning * into inserted_job;

  insert into executive_visuals.video_generation_budget_reservations(
    job_id, approval_id, policy_id, owner_id, project_id, provider, model, currency, reserved_amount
  ) values (
    inserted_job.id, approval.id, policy.id, p_owner_id, p_project_id,
    p_provider, p_model, p_currency, p_reserved_amount
  ) returning id into reservation_id;

  insert into executive_visuals.video_generation_usage_reservations(
    job_id, owner_id, provider, model
  ) values (inserted_job.id, p_owner_id, p_provider, p_model);

  update executive_visuals.video_generation_budget_policies
  set reserved_amount = reserved_amount + p_reserved_amount,
      updated_at = clock_timestamp()
  where id = policy.id;

  update executive_visuals.video_generation_budget_approvals
  set consumed_at = clock_timestamp()
  where id = approval.id;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    inserted_job.id, p_owner_id, 'job.queued',
    jsonb_build_object('jobType','video.generate','provider',p_provider,'model',p_model,
      'requestHash',p_request_hash,'budgetReservationId',reservation_id,
      'reservedAmount',p_reserved_amount,'currency',p_currency)
  );

  insert into executive_visuals.audit_events(owner_id, project_id, event_type, subject_type, subject_id, details)
  values (
    p_owner_id, p_project_id, 'job.queued', 'job', inserted_job.id::text,
    jsonb_build_object('jobType','video.generate','provider',p_provider,'model',p_model,
      'requestHash',p_request_hash,'budgetReservationId',reservation_id)
  );

  return query select inserted_job.id, inserted_job.status, false, reservation_id;
end;
$video_enqueue$;

revoke all on function executive_visuals.enqueue_video_generation_job(uuid, uuid, text, text, text, text, jsonb, uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function executive_visuals.enqueue_video_generation_job(uuid, uuid, text, text, text, text, jsonb, uuid, numeric, text)
  to service_role;


create or replace function executive_visuals.finish_video_generation_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_output jsonb default null,
  p_error jsonb default null,
  p_actual_amount numeric default null
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_finish$
declare
  current_job executive_visuals.jobs;
  reservation executive_visuals.video_generation_budget_reservations;
  policy executive_visuals.video_generation_budget_policies;
  submission executive_visuals.video_generation_submissions;
  target_submission_state text;
  target_budget_state text;
  output_asset_id uuid;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_status is null or p_status not in ('succeeded','partial','failed','cancelled')
     or (p_output is not null and jsonb_typeof(p_output) <> 'object')
     or (p_error is not null and jsonb_typeof(p_error) <> 'object')
     or octet_length(coalesce(p_output,'{}'::jsonb)::text) > 32000
     or octet_length(coalesce(p_error,'{}'::jsonb)::text) > 8000
     or (p_actual_amount is not null and p_actual_amount < 0) then
    raise exception 'VIDEO_JOB_FINISH_ARGUMENTS_INVALID';
  end if;

  select * into current_job
  from executive_visuals.jobs j
  where j.id = p_job_id and j.job_type = 'video.generate'
  for update;
  if current_job.id is null or current_job.status <> 'processing'
     or current_job.lease_owner is distinct from p_worker_id
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= clock_timestamp() then
    return false;
  end if;

  if p_status in ('succeeded','partial') and p_actual_amount is null then
    raise exception 'VIDEO_BUDGET_ACTUAL_COST_REQUIRED';
  end if;
  if p_status in ('failed','cancelled') and p_actual_amount is not null then
    raise exception 'VIDEO_BUDGET_FAILURE_MUST_RELEASE_RESERVATION';
  end if;

  select * into reservation
  from executive_visuals.video_generation_budget_reservations r
  where r.job_id = p_job_id
  for update;
  if reservation.id is null or reservation.state <> 'reserved' then
    raise exception 'VIDEO_BUDGET_RESERVATION_NOT_SETTLEABLE';
  end if;
  if p_actual_amount is not null and p_actual_amount > reservation.reserved_amount then
    raise exception 'VIDEO_BUDGET_ACTUAL_EXCEEDS_RESERVATION';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.id = reservation.policy_id
  for update;
  if policy.id is null or policy.reserved_amount < reservation.reserved_amount then
    raise exception 'VIDEO_BUDGET_LEDGER_INVARIANT_FAILED';
  end if;

  target_budget_state := case when p_actual_amount is null then 'released' else 'settled' end;
  update executive_visuals.video_generation_budget_policies
  set reserved_amount = reserved_amount - reservation.reserved_amount,
      spent_amount = spent_amount + coalesce(p_actual_amount, 0),
      updated_at = clock_timestamp()
  where id = policy.id;

  update executive_visuals.video_generation_budget_reservations
  set state = target_budget_state, actual_amount = p_actual_amount, updated_at = clock_timestamp()
  where id = reservation.id;

  target_submission_state := case when p_status in ('succeeded','partial') then 'succeeded' else p_status end;
  select * into submission
  from executive_visuals.video_generation_submissions s
  where s.job_id = p_job_id
  for update;
  if p_status in ('succeeded','partial') then
    if p_output is null
       or coalesce(jsonb_typeof(p_output -> 'assetIds'),'null') <> 'array'
       or coalesce(jsonb_array_length(p_output -> 'assetIds'),0) not between 1 and 10
       or p_output ->> 'providerTaskId' is distinct from submission.provider_task_id then
      raise exception 'VIDEO_JOB_OUTPUT_ASSET_RECEIPTS_INVALID';
    end if;
    for output_asset_id in
      select value::uuid from jsonb_array_elements_text(p_output -> 'assetIds') as asset_ids(value)
    loop
      if not exists (
        select 1 from executive_visuals.assets a
        where a.id = output_asset_id
          and a.owner_id = current_job.owner_id
          and a.project_id is not distinct from current_job.project_id
          and a.storage_bucket = 'executive-visuals-media'
          and a.media_type like 'video/%'
          and a.deleted_at is null
      ) then
        raise exception 'VIDEO_JOB_OUTPUT_ASSET_SCOPE_INVALID';
      end if;
    end loop;
  end if;

  if submission.id is not null then
    if p_status in ('succeeded','partial')
       and (submission.state <> 'submitted' or submission.provider_task_id is null) then
      raise exception 'VIDEO_SUBMISSION_TASK_ID_REQUIRED';
    end if;
    -- An interrupted POST may already have been accepted and billed. Never
    -- release its reservation until an operator reconciles the provider task.
    if p_status in ('failed','cancelled') and submission.state in ('submitting','unknown') then
      raise exception 'VIDEO_SUBMISSION_RECONCILIATION_REQUIRED';
    end if;
    if submission.state not in ('prepared','submitting','submitted','unknown') then
      raise exception 'VIDEO_SUBMISSION_NOT_SETTLEABLE';
    end if;
    update executive_visuals.video_generation_submissions
    set state = target_submission_state, updated_at = clock_timestamp(),
        metadata = metadata || jsonb_build_object('jobStatus',p_status,'budgetState',target_budget_state)
    where id = submission.id;
  elsif p_status in ('succeeded','partial') then
    raise exception 'VIDEO_SUBMISSION_LEDGER_REQUIRED';
  end if;

  update executive_visuals.jobs
  set status = p_status,
      progress = case when p_status in ('succeeded','partial') then 100 else progress end,
      output = p_output,
      error = p_error,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      lease_owner = null,
      lease_expires_at = null,
      lease_heartbeat_at = null
  where id = p_job_id and status = 'processing' and lease_owner = p_worker_id;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    p_job_id, current_job.owner_id, 'job.' || p_status,
    jsonb_build_object('status',p_status,'budgetReservationId',reservation.id,
      'reservedAmount',reservation.reserved_amount,'actualAmount',p_actual_amount,
      'currency',reservation.currency)
  );

  insert into executive_visuals.audit_events(owner_id, project_id, event_type, subject_type, subject_id, details)
  values (
    current_job.owner_id, current_job.project_id, 'video.budget.' || target_budget_state,
    'video_budget_reservation', reservation.id::text,
    jsonb_build_object('jobId',p_job_id,'reservedAmount',reservation.reserved_amount,
      'actualAmount',p_actual_amount,'currency',reservation.currency,'jobStatus',p_status)
  );
  return true;
end;
$video_finish$;

revoke all on function executive_visuals.finish_video_generation_job(uuid, text, text, jsonb, jsonb, numeric)
  from public, anon, authenticated;
grant execute on function executive_visuals.finish_video_generation_job(uuid, text, text, jsonb, jsonb, numeric)
  to service_role;

-- Job completion, submission terminalization and budget settlement commit atomically.


create or replace function executive_visuals.defer_video_generation_job(
  p_job_id uuid, p_worker_id text, p_delay_seconds integer default 30, p_reason_code text default 'VIDEO_PROVIDER_POLL_DEFERRED'
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_defer$
declare
  current_job executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_delay_seconds is null or p_delay_seconds not between 5 and 900
     or p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{1,100}$' then
    raise exception 'VIDEO_JOB_DEFER_ARGUMENTS_INVALID';
  end if;
  select * into current_job from executive_visuals.jobs
  where id=p_job_id and job_type='video.generate' for update;
  if current_job.id is null or current_job.status <> 'processing'
     or current_job.lease_owner is distinct from p_worker_id
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= clock_timestamp() then
    return false;
  end if;
  select * into submission from executive_visuals.video_generation_submissions
  where job_id=p_job_id for update;
  if submission.id is null or submission.state <> 'submitted' or submission.provider_task_id is null then
    raise exception 'VIDEO_JOB_DEFER_REQUIRES_SUBMITTED_TASK';
  end if;
  if not exists (
    select 1 from executive_visuals.video_generation_budget_reservations r
    where r.job_id=p_job_id and r.state='reserved'
  ) then raise exception 'VIDEO_JOB_DEFER_BUDGET_RESERVATION_MISSING'; end if;

  update executive_visuals.jobs
  set status='queued', available_at=clock_timestamp()+make_interval(secs=>p_delay_seconds),
      error=null, updated_at=clock_timestamp(), lease_owner=null,
      lease_expires_at=null, lease_heartbeat_at=null
  where id=p_job_id;
  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values(p_job_id,current_job.owner_id,'job.deferred',
    jsonb_build_object('reasonCode',p_reason_code,'delaySeconds',p_delay_seconds,'providerTaskId',submission.provider_task_id));
  insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
  values(current_job.owner_id,current_job.project_id,'job.deferred','job',p_job_id::text,
    jsonb_build_object('reasonCode',p_reason_code,'delaySeconds',p_delay_seconds));
  return true;
end;
$video_defer$;

revoke all on function executive_visuals.defer_video_generation_job(uuid,text,integer,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.defer_video_generation_job(uuid,text,integer,text)
  to service_role;


create or replace function executive_visuals.quarantine_video_generation_job(
  p_job_id uuid, p_worker_id text, p_reason_code text default 'VIDEO_SUBMISSION_REQUIRES_RECONCILIATION'
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_quarantine$
declare
  current_job executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{1,100}$' then
    raise exception 'VIDEO_JOB_QUARANTINE_ARGUMENTS_INVALID';
  end if;
  select * into current_job from executive_visuals.jobs
  where id=p_job_id and job_type='video.generate' for update;
  if current_job.id is null or current_job.status <> 'processing'
     or current_job.lease_owner is distinct from p_worker_id
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= clock_timestamp() then
    return false;
  end if;
  select * into submission from executive_visuals.video_generation_submissions
  where job_id=p_job_id for update;
  if submission.id is null or submission.state not in ('submitting','unknown','submitted') then
    raise exception 'VIDEO_JOB_QUARANTINE_REQUIRES_AMBIGUOUS_SUBMISSION';
  end if;
  if not exists (
    select 1 from executive_visuals.video_generation_budget_reservations r
    where r.job_id=p_job_id and r.state='reserved'
  ) then raise exception 'VIDEO_JOB_QUARANTINE_BUDGET_RESERVATION_MISSING'; end if;

  update executive_visuals.jobs
  set status='needs_input', error=jsonb_build_object('code',p_reason_code,
      'message','Provider execution, output ingestion, or cost requires operator review.'),
      updated_at=clock_timestamp(), lease_owner=null,
      lease_expires_at=null, lease_heartbeat_at=null
  where id=p_job_id;
  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values(p_job_id,current_job.owner_id,'job.needs_input',
    jsonb_build_object('reasonCode',p_reason_code,'submissionState',submission.state));
  insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
  values(current_job.owner_id,current_job.project_id,'job.needs_input','job',p_job_id::text,
    jsonb_build_object('reasonCode',p_reason_code,'submissionState',submission.state));
  return true;
end;
$video_quarantine$;

revoke all on function executive_visuals.quarantine_video_generation_job(uuid,text,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.quarantine_video_generation_job(uuid,text,text)
  to service_role;


create or replace function executive_visuals.resume_reconciled_video_generation_job(
  p_job_id uuid, p_owner_id uuid, p_evidence_reference text
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_resume$
declare
  current_job executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
begin
  if p_evidence_reference is null or char_length(btrim(p_evidence_reference)) not between 1 and 1000 then
    raise exception 'VIDEO_JOB_RESUME_EVIDENCE_REQUIRED';
  end if;
  select * into current_job from executive_visuals.jobs
  where id=p_job_id and owner_id=p_owner_id and job_type='video.generate'
  for update;
  if current_job.id is null or current_job.status <> 'needs_input' then return false; end if;
  select * into submission from executive_visuals.video_generation_submissions
  where job_id=p_job_id for update;
  if submission.id is null or submission.state <> 'submitted' or submission.provider_task_id is null then
    raise exception 'VIDEO_JOB_RESUME_REQUIRES_RECONCILED_TASK';
  end if;
  if not exists (
    select 1 from executive_visuals.video_generation_budget_reservations r
    where r.job_id=p_job_id and r.state='reserved'
  ) then raise exception 'VIDEO_JOB_RESUME_BUDGET_RESERVATION_MISSING'; end if;

  update executive_visuals.jobs
  set status='queued', available_at=clock_timestamp(), error=null,
      updated_at=clock_timestamp(), lease_owner=null,
      lease_expires_at=null, lease_heartbeat_at=null
  where id=p_job_id;
  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values(p_job_id,p_owner_id,'job.reconciled_resumed',
    jsonb_build_object('providerTaskId',submission.provider_task_id,'evidenceReference',p_evidence_reference));
  insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
  values(p_owner_id,current_job.project_id,'job.reconciled_resumed','job',p_job_id::text,
    jsonb_build_object('providerTaskId',submission.provider_task_id,'evidenceReference',p_evidence_reference));
  return true;
end;
$video_resume$;

revoke all on function executive_visuals.resume_reconciled_video_generation_job(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.resume_reconciled_video_generation_job(uuid,uuid,text)
  to service_role;


create or replace function executive_visuals.recover_expired_video_generation_jobs(p_limit integer default 100)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_recover$
declare
  expired executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
  reservation executive_visuals.video_generation_budget_reservations;
  policy executive_visuals.video_generation_budget_policies;
  retryable boolean;
  delay_seconds integer;
  recovered integer := 0;
  recovery_code text;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'VIDEO_RECOVERY_LIMIT_INVALID';
  end if;

  for expired in
    select * from executive_visuals.jobs
    where job_type='video.generate' and status='processing'
      and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
    order by lease_expires_at nulls first, created_at
    limit p_limit
    for update skip locked
  loop
    select * into submission from executive_visuals.video_generation_submissions
    where job_id=expired.id for update;

    if submission.id is not null and submission.state <> 'prepared' then
      recovery_code := 'VIDEO_WORKER_LEASE_EXPIRED_REVIEW';
      update executive_visuals.jobs
      set status='needs_input',
          error=jsonb_build_object('code',recovery_code,
            'message','Video task state requires operator review before another worker attempt.'),
          updated_at=clock_timestamp(), completed_at=null,
          lease_owner=null, lease_expires_at=null, lease_heartbeat_at=null
      where id=expired.id;
      insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
      values(expired.id,expired.owner_id,'job.needs_input',
        jsonb_build_object('reasonCode',recovery_code,'submissionState',submission.state));
      insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
      values(expired.owner_id,expired.project_id,'job.needs_input','job',expired.id::text,
        jsonb_build_object('reasonCode',recovery_code,'submissionState',submission.state));
    else
      retryable := expired.attempt_count < expired.max_attempts;
      delay_seconds := case when retryable
        then least(300, 5 * (2 ^ greatest(0, expired.attempt_count - 1)))
        else 0 end;

      if retryable then
        update executive_visuals.jobs
        set status='queued', error=jsonb_build_object('code','VIDEO_WORKER_LEASE_EXPIRED',
            'message','No provider POST had started; the video job is safe to retry.'),
            updated_at=clock_timestamp(), completed_at=null,
            available_at=clock_timestamp()+make_interval(secs=>delay_seconds),
            lease_owner=null, lease_expires_at=null, lease_heartbeat_at=null
        where id=expired.id;
        insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
        values(expired.id,expired.owner_id,'job.lease_expired_retry',
          jsonb_build_object('retryDelaySeconds',delay_seconds,'submissionState',coalesce(submission.state,'absent')));
      else
        select * into reservation from executive_visuals.video_generation_budget_reservations
        where job_id=expired.id for update;
        if reservation.id is not null and reservation.state='reserved' then
          select * into policy from executive_visuals.video_generation_budget_policies
          where id=reservation.policy_id for update;
          if policy.id is null or policy.reserved_amount < reservation.reserved_amount then
            raise exception 'VIDEO_BUDGET_LEDGER_INVARIANT_FAILED';
          end if;
          update executive_visuals.video_generation_budget_policies
          set reserved_amount=reserved_amount-reservation.reserved_amount, updated_at=clock_timestamp()
          where id=policy.id;
          update executive_visuals.video_generation_budget_reservations
          set state='released', actual_amount=null, updated_at=clock_timestamp()
          where id=reservation.id;
        end if;
        if submission.id is not null and submission.state='prepared' then
          update executive_visuals.video_generation_submissions
          set state='failed', updated_at=clock_timestamp(),
              last_error_code='VIDEO_WORKER_LEASE_EXPIRED'
          where id=submission.id;
        end if;
        update executive_visuals.jobs
        set status='failed',
            error=jsonb_build_object('code','VIDEO_WORKER_LEASE_EXPIRED',
              'message','The video job exhausted its safe pre-submission attempts.'),
            updated_at=clock_timestamp(), completed_at=clock_timestamp(),
            available_at=null, lease_owner=null, lease_expires_at=null, lease_heartbeat_at=null
        where id=expired.id;
        insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
        values(expired.id,expired.owner_id,'job.lease_expired_failed',
          jsonb_build_object('submissionState',coalesce(submission.state,'absent'),'budgetReleased',reservation.id is not null));
        insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
        values(expired.owner_id,expired.project_id,'job.lease_expired_failed','job',expired.id::text,
          jsonb_build_object('submissionState',coalesce(submission.state,'absent'),'budgetReservationId',reservation.id));
      end if;
    end if;
    recovered := recovered + 1;
  end loop;
  return recovered;
end;
$video_recover$;

revoke all on function executive_visuals.recover_expired_video_generation_jobs(integer)
  from public, anon, authenticated;
grant execute on function executive_visuals.recover_expired_video_generation_jobs(integer)
  to service_role;


-- 20261105120000_google_video_interactions.sql
-- Durable ownership and retention metadata for Gemini Omni Interactions.
-- Source-controlled only; do not apply to staging or production without review.

create table if not exists executive_visuals.google_video_interactions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'google'),
  model text not null check (model = 'gemini-omni-1.1-flash'),
  interaction_id text not null unique check (interaction_id ~ '^v1_[A-Za-z0-9_-]{6,200}$'),
  job_id uuid not null references executive_visuals.jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  parent_interaction_id text check (
    parent_interaction_id is null or parent_interaction_id ~ '^v1_[A-Za-z0-9_-]{6,200}$'
  ),
  state text not null check (state in (
    'running', 'waiting', 'succeeded', 'failed', 'canceled', 'incomplete', 'unknown', 'deleting', 'deleted'
  )),
  output_file_name text,
  output_uri text,
  constraint google_video_interactions_output_uri_check check (
    output_uri is null or (
      split_part(output_uri, '/', 1) = 'https:' and
      split_part(output_uri, '/', 2) = '' and
      split_part(output_uri, '/', 3) = 'generativelanguage.googleapis.com' and
      split_part(output_uri, '/', 4) = 'v1beta' and
      split_part(output_uri, '/', 5) = 'files' and
      split_part(output_uri, '/', 6) ~ '^[A-Za-z0-9_-]+(:download[?]alt=media)?$' and
      array_length(string_to_array(output_uri, '/'), 1) = 6
    )
  ),
  submitted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists google_video_interactions_owner_project_idx
  on executive_visuals.google_video_interactions (owner_id, project_id, submitted_at desc);

create index if not exists google_video_interactions_expiry_idx
  on executive_visuals.google_video_interactions (expires_at)
  where state <> 'deleted';

create index if not exists google_video_interactions_job_idx
  on executive_visuals.google_video_interactions (job_id, owner_id);

alter table executive_visuals.google_video_interactions enable row level security;
alter table executive_visuals.google_video_interactions force row level security;

revoke all on table executive_visuals.google_video_interactions from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update, delete on table executive_visuals.google_video_interactions to service_role;


-- 20261108120000_aleph2_transformation_budget_approval.sql
-- Aleph 2 transformation approval bridge.
-- Source-controlled only. Do not apply to shared staging or production without release approval.
-- Enables the existing transformation lane only after an exact, short-lived approval
-- is recorded in the durable budget ledger. Provider execution flags remain independent.

create or replace function executive_visuals.validate_video_budget_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $approval_trigger$
begin
  -- Preserve the authenticated owner check while allowing the trusted service-role RPC.
  if current_user <> 'service_role' and new.owner_id is distinct from auth.uid() then
    raise exception 'VIDEO_BUDGET_APPROVAL_OWNER_INVALID';
  end if;
  new.created_at := clock_timestamp();
  new.consumed_at := null;
  if new.expires_at <= clock_timestamp()
     or new.expires_at > clock_timestamp() + interval '15 minutes' then
    raise exception 'VIDEO_BUDGET_APPROVAL_EXPIRY_INVALID';
  end if;
  return new;
end;
$approval_trigger$;

create or replace function executive_visuals.create_video_generation_budget_approval(
  p_approval_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_provider text,
  p_model text,
  p_request_hash text,
  p_currency text,
  p_approved_max_amount numeric,
  p_approval_note text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_approval$
declare
  policy executive_visuals.video_generation_budget_policies;
begin
  if p_approval_id is null or p_owner_id is null or p_project_id is null
     or p_provider <> 'runway' or p_model <> 'aleph2'
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_currency <> 'USD'
     or p_approved_max_amount is null or p_approved_max_amount < 0.56
     or p_approval_note is null or char_length(p_approval_note) > 1000
     or p_expires_at is null or p_expires_at <= clock_timestamp()
     or p_expires_at > clock_timestamp() + interval '15 minutes' then
    raise exception 'VIDEO_BUDGET_APPROVAL_ARGUMENTS_INVALID';
  end if;
  if not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;
  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id and b.project_id = p_project_id
    and b.provider = p_provider and b.model = p_model
    and b.currency = p_currency and b.enabled = true
  for update;
  if policy.id is null then
    raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED';
  end if;
  if p_approved_max_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_approved_max_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;
  insert into executive_visuals.video_generation_budget_approvals(
    id,owner_id,project_id,provider,model,request_hash,currency,
    approved_max_amount,approval_note,expires_at
  ) values (
    p_approval_id,p_owner_id,p_project_id,p_provider,p_model,p_request_hash,p_currency,
    p_approved_max_amount,p_approval_note,p_expires_at
  );
  return p_approval_id;
end;
$video_approval$;

revoke all on function executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)
  from public, anon, authenticated;
grant execute on function executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)
  to service_role;

create or replace function executive_visuals.enqueue_video_generation_job(
  p_owner_id uuid,
  p_project_id uuid,
  p_idempotency_key text,
  p_provider text,
  p_model text,
  p_request_hash text,
  p_input jsonb,
  p_budget_approval_id uuid,
  p_reserved_amount numeric,
  p_currency text
)
returns table(job_id uuid, job_status text, idempotent_replay boolean, budget_reservation_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_enqueue$
declare
  existing executive_visuals.jobs;
  policy executive_visuals.video_generation_budget_policies;
  approval executive_visuals.video_generation_budget_approvals;
  inserted_job executive_visuals.jobs;
  reservation_id uuid;
  used_requests bigint;
begin
  if p_owner_id is null
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,180}$'
     or p_provider is null or char_length(p_provider) not between 1 and 100
     or p_model is null or char_length(p_model) not between 1 and 160
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_input) <> 'object'
     or octet_length(p_input::text) > 32000
     or coalesce(p_input ->> 'provider','') <> p_provider
     or coalesce(p_input ->> 'model','') <> p_model
     or coalesce(p_input ->> 'requestHash','') <> p_request_hash
     or coalesce(p_input ->> 'projectId','') <> coalesce(p_project_id::text,'')
     or p_reserved_amount is null or p_reserved_amount <= 0
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'VIDEO_ENQUEUE_ARGUMENTS_INVALID';
  end if;
  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then
    raise exception 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED';
  end if;
  if p_currency <> 'USD' then
    raise exception 'VIDEO_PRICE_CURRENCY_UNSUPPORTED';
  end if;
  if coalesce(p_input ->> 'outputFormat','mp4') <> 'mp4' then
    raise exception 'VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED';
  end if;
  if p_provider = 'runway' and p_model = 'aleph2' then
    if coalesce(p_input ->> 'operation','') <> 'video-to-video'
       or coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]'
       or coalesce(p_input ->> 'durationSeconds','') ~ '[^0-9]'
       or length(coalesce(p_input ->> 'durationSeconds','')) > 2
       or (p_input ->> 'durationSeconds')::numeric < 2
       or (p_input ->> 'durationSeconds')::numeric > 30 then
      raise exception 'VIDEO_PRICE_DURATION_OR_OPERATION_INVALID';
    end if;
    -- Aleph 2.0: 28 credits per output second, 56-credit minimum.
    if p_reserved_amount < greatest(0.56, (p_input ->> 'durationSeconds')::numeric * 0.28) then
      raise exception 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE';
    end if;
  elsif p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_reserved_amount < ((p_input ->> 'durationSeconds')::numeric * 0.12) then
      raise exception 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE';
    end if;
  else
    -- Gemini Omni direct API preflight: 1,048,576 input tokens at $1.50/M
    -- plus 57,920 output video tokens (10s at 5,792 tokens/s) at $17.50/M.
    -- The reservation is deliberately conservative; actual usage is reconciled
    -- from the completed interaction before budget settlement.
    if coalesce(p_input ->> 'durationSeconds','') not in ('3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if coalesce(p_input ->> 'resolution','provider_default') not in ('provider_default','720p') then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_RESOLUTION';
    end if;
    if p_reserved_amount < 2.586464 then
      raise exception 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':video.generate', 0));

  select * into existing from executive_visuals.jobs
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if existing.id is not null then
    if existing.job_type <> 'video.generate'
       or existing.project_id is distinct from p_project_id
       or coalesce(existing.input ->> 'requestHash','') <> p_request_hash
       or coalesce(existing.input ->> 'provider','') <> p_provider
       or coalesce(existing.input ->> 'model','') <> p_model then
      raise exception 'VIDEO_JOB_IDEMPOTENCY_CONFLICT';
    end if;
    select r.id into reservation_id
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = existing.id;
    return query select existing.id, existing.status, true, reservation_id;
    return;
  end if;

  if p_project_id is not null and not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id
    and b.project_id is not distinct from p_project_id
    and b.provider = p_provider and b.model = p_model
    and b.currency = p_currency and b.enabled = true
  for update;
  if policy.id is null then raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED'; end if;
  if p_reserved_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_reserved_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;

  select * into approval
  from executive_visuals.video_generation_budget_approvals a
  where a.id = p_budget_approval_id and a.owner_id = p_owner_id
  for update;
  if approval.id is null
     or approval.project_id is distinct from p_project_id
     or approval.provider <> p_provider or approval.model <> p_model
     or approval.request_hash <> p_request_hash or approval.currency <> p_currency
     or approval.approved_max_amount < p_reserved_amount
     or approval.expires_at <= clock_timestamp()
     or approval.consumed_at is not null then
    raise exception 'VIDEO_JOB_BUDGET_APPROVAL_INVALID';
  end if;

  select count(*) into used_requests
  from executive_visuals.video_generation_usage_reservations u
  where u.owner_id = p_owner_id and u.provider = p_provider and u.model = p_model
    and u.created_at >= clock_timestamp() - interval '24 hours';
  if policy.rolling_24h_request_limit = 0 or used_requests >= policy.rolling_24h_request_limit then
    raise exception 'VIDEO_JOB_USAGE_LIMIT_REACHED';
  end if;

  insert into executive_visuals.jobs(
    owner_id, project_id, job_type, status, input, idempotency_key,
    estimated_cost, approved_by, approved_at
  ) values (
    p_owner_id, p_project_id, 'video.generate', 'queued', p_input, p_idempotency_key,
    jsonb_build_object('amount', p_reserved_amount, 'currency', p_currency),
    p_owner_id, clock_timestamp()
  ) returning * into inserted_job;

  insert into executive_visuals.video_generation_budget_reservations(
    job_id, approval_id, policy_id, owner_id, project_id, provider, model, currency, reserved_amount
  ) values (
    inserted_job.id, approval.id, policy.id, p_owner_id, p_project_id,
    p_provider, p_model, p_currency, p_reserved_amount
  ) returning id into reservation_id;

  insert into executive_visuals.video_generation_usage_reservations(
    job_id, owner_id, provider, model
  ) values (inserted_job.id, p_owner_id, p_provider, p_model);

  update executive_visuals.video_generation_budget_policies
  set reserved_amount = reserved_amount + p_reserved_amount,
      updated_at = clock_timestamp()
  where id = policy.id;

  update executive_visuals.video_generation_budget_approvals
  set consumed_at = clock_timestamp()
  where id = approval.id;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    inserted_job.id, p_owner_id, 'job.queued',
    jsonb_build_object('jobType','video.generate','provider',p_provider,'model',p_model,
      'requestHash',p_request_hash,'budgetReservationId',reservation_id,
      'reservedAmount',p_reserved_amount,'currency',p_currency)
  );

  insert into executive_visuals.audit_events(owner_id, project_id, event_type, subject_type, subject_id, details)
  values (
    p_owner_id, p_project_id, 'job.queued', 'job', inserted_job.id::text,
    jsonb_build_object('jobType','video.generate','provider',p_provider,'model',p_model,
      'requestHash',p_request_hash,'budgetReservationId',reservation_id)
  );

  return query select inserted_job.id, inserted_job.status, false, reservation_id;
end;
$video_enqueue$;


revoke all on function executive_visuals.enqueue_video_generation_job(uuid, uuid, text, text, text, text, jsonb, uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function executive_visuals.enqueue_video_generation_job(uuid, uuid, text, text, text, text, jsonb, uuid, numeric, text)
  to service_role;


-- 20261108190000_video_cancellation_requests.sql
-- Durable, owner/editor-authorized cancellation intent for hosted video jobs.
-- This records intent only; provider cancellation and billing reconciliation are separate worker steps.
alter table executive_visuals.jobs
  add column if not exists cancel_requested_at timestamptz;

create table if not exists executive_visuals.video_generation_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references executive_visuals.jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  status text not null default 'requested'
    check (status in ('requested','dispatching','provider_cancelled','reconciliation_required','settled','rejected')),
  provider text not null,
  provider_task_id text,
  requested_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8000)
);

create index if not exists ev_video_cancel_requests_status
  on executive_visuals.video_generation_cancellation_requests(status, requested_at);

alter table executive_visuals.video_generation_cancellation_requests enable row level security;
revoke all on executive_visuals.video_generation_cancellation_requests from public, anon, authenticated;
grant all privileges on executive_visuals.video_generation_cancellation_requests to service_role;

create or replace function executive_visuals.request_video_generation_cancellation(
  p_job_id uuid,
  p_requested_by uuid
)
returns table(request_id uuid, job_id uuid, request_status text, cancel_requested_at timestamptz, idempotent_replay boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $video_cancel$
declare
  target_job executive_visuals.jobs;
  existing_request executive_visuals.video_generation_cancellation_requests;
  provider_name text;
  provider_task text;
  reserved_provider text;
  requested_at_value timestamptz;
begin
  if p_job_id is null or p_requested_by is null then
    raise exception 'VIDEO_CANCELLATION_ARGUMENTS_INVALID';
  end if;

  select * into target_job
  from executive_visuals.jobs j
  where j.id = p_job_id and j.job_type = 'video.generate'
  for update;
  if target_job.id is null then
    raise exception 'VIDEO_CANCELLATION_JOB_NOT_FOUND';
  end if;

  if target_job.owner_id <> p_requested_by and not exists (
    select 1
    from executive_visuals.projects p
    join executive_visuals.project_members m on m.project_id = p.id
    where p.id = target_job.project_id
      and m.member_id = p_requested_by
      and m.role = 'editor'
  ) and not exists (
    select 1 from executive_visuals.projects p
    where p.id = target_job.project_id and p.owner_id = p_requested_by
  ) then
    raise exception 'VIDEO_CANCELLATION_ACCESS_DENIED';
  end if;

  select * into existing_request
  from executive_visuals.video_generation_cancellation_requests r
  where r.job_id = p_job_id
  for update;
  if existing_request.id is not null then
    return query select existing_request.id, existing_request.job_id, existing_request.status,
      target_job.cancel_requested_at, true;
    return;
  end if;

  if target_job.status not in ('queued','submitted','processing','needs_input') then
    raise exception 'VIDEO_CANCELLATION_JOB_NOT_ACTIVE';
  end if;

  select r.provider into reserved_provider
  from executive_visuals.video_generation_budget_reservations r
  where r.job_id = p_job_id;
  provider_name := coalesce(reserved_provider,'');
  if provider_name not in ('runway','fal') then
    raise exception 'VIDEO_CANCELLATION_PROVIDER_UNSUPPORTED';
  end if;

  select s.provider_task_id into provider_task
  from executive_visuals.video_generation_submissions s
  where s.job_id = p_job_id and s.owner_id = target_job.owner_id;

  update executive_visuals.jobs
  set cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where id = p_job_id
  returning cancel_requested_at into requested_at_value;

  insert into executive_visuals.video_generation_cancellation_requests(
    job_id, owner_id, requested_by, project_id, provider, provider_task_id
  ) values (
    p_job_id, target_job.owner_id, p_requested_by, target_job.project_id, provider_name, provider_task
  ) returning id into request_id;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (p_job_id, target_job.owner_id, 'video.cancellation_requested',
    jsonb_build_object('requestId',request_id,'requestedBy',p_requested_by,'provider',provider_name));

  insert into executive_visuals.audit_events(owner_id, project_id, event_type, subject_type, subject_id, details)
  values (target_job.owner_id, target_job.project_id, 'video.cancellation.requested',
    'video_generation_cancellation_request', request_id::text,
    jsonb_build_object('jobId',p_job_id,'requestedBy',p_requested_by,'provider',provider_name));

  return query select request_id, p_job_id, 'requested'::text, requested_at_value, false;
end;
$video_cancel$;

revoke all on function executive_visuals.request_video_generation_cancellation(uuid,uuid) from public, anon, authenticated;
grant execute on function executive_visuals.request_video_generation_cancellation(uuid,uuid) to service_role;


-- 20261108210000_runway_model_router_enqueue_contract.sql
-- Enable the existing Runway Model Router adapter at the durable SQL boundary.
-- This is an allowlist/contract migration only: it does not enable provider flags,
-- create customer budget policies, or submit paid tasks.
--
-- Use pg_get_functiondef + guarded exact replacements so the existing function's
-- approval binding, idempotency locks, reservation ledger and grants are preserved.
do $runway_router_enqueue$
declare
  function_oid regprocedure;
  function_sql text;
  old_allowlist text := $old_allowlist$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then$old_allowlist$;
  new_allowlist text := $new_allowlist$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2','model-router'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then$new_allowlist$;
  old_runway_branch text := $old_runway_branch$  elsif p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;$old_runway_branch$;
  new_runway_branch text := $new_runway_branch$  elsif p_provider = 'runway' and p_model = 'model-router' then
    if coalesce(p_input ->> 'operation','') not in ('text-to-video','image-to-video','video-to-video') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]{1,2}$' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if (p_input ->> 'durationSeconds')::numeric < 2
       or (p_input ->> 'durationSeconds')::numeric > 30 then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
  elsif p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;$new_runway_branch$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.enqueue_video_generation_job(uuid,uuid,text,text,text,text,jsonb,uuid,numeric,text)'
  );
  if function_oid is null then
    raise exception 'RUNWAY_ROUTER_ENQUEUE_FUNCTION_NOT_FOUND';
  end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql, old_allowlist) = 0 then
    raise exception 'RUNWAY_ROUTER_ENQUEUE_ALLOWLIST_SOURCE_MISMATCH';
  end if;
  if strpos(function_sql, old_runway_branch) = 0 then
    raise exception 'RUNWAY_ROUTER_ENQUEUE_PRICING_BRANCH_SOURCE_MISMATCH';
  end if;
  function_sql := replace(function_sql, old_allowlist, new_allowlist);
  function_sql := replace(function_sql, old_runway_branch, new_runway_branch);
  execute function_sql;
end
$runway_router_enqueue$;


-- 20261108230000_video_workflow_quote_ledger.sql
-- Durable, immutable quote records for governed Video Studio workflow generation.
-- Quotes are non-billable evidence only. This migration does not approve, reserve,
-- enqueue or enable provider execution.

create table if not exists executive_visuals.video_workflow_quotes (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  request_id text not null check (request_id ~ '^[A-Za-z0-9._:-]{1,160}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider = 'runway'),
  model text not null check (model = 'model-router'),
  operation text not null check (operation in ('text-to-video','image-to-video','video-to-video')),
  routed_provider text not null check (char_length(routed_provider) between 1 and 100),
  routed_model text not null check (char_length(routed_model) between 1 and 160),
  estimated_credits integer not null check (estimated_credits > 0),
  estimated_amount numeric(14,6) not null check (estimated_amount > 0),
  currency text not null check (currency = 'USD'),
  config_id text not null check (char_length(config_id) <= 64),
  pricing_source text not null check (pricing_source = 'runway_model_router_dry_run'),
  state text not null default 'quoted' check (state in ('quoted','approved','consumed','expired','revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '5 minutes 30 seconds')
);

create index if not exists ev_video_workflow_quotes_scope_created
  on executive_visuals.video_workflow_quotes(owner_id, project_id, created_at desc);
create index if not exists ev_video_workflow_quotes_expiry
  on executive_visuals.video_workflow_quotes(expires_at)
  where state = 'quoted';

alter table executive_visuals.video_workflow_quotes enable row level security;
revoke all on executive_visuals.video_workflow_quotes from public, anon, authenticated;
grant select, insert, update on executive_visuals.video_workflow_quotes to service_role;

create or replace function executive_visuals.record_video_workflow_quote(
  p_quote_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_request_id text,
  p_request_hash text,
  p_provider text,
  p_model text,
  p_operation text,
  p_routed_provider text,
  p_routed_model text,
  p_estimated_credits integer,
  p_estimated_amount numeric,
  p_currency text,
  p_config_id text,
  p_pricing_source text,
  p_expires_at timestamptz
) returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $record_video_workflow_quote$
begin
  if p_quote_id is null or p_owner_id is null or p_project_id is null
     or p_provider is null or p_model is null or p_operation is null
     or p_currency is null or p_pricing_source is null
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9._:-]{1,160}$'
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_provider <> 'runway' or p_model <> 'model-router'
     or p_operation not in ('text-to-video','image-to-video','video-to-video')
     or p_routed_provider is null or char_length(p_routed_provider) not between 1 and 100
     or p_routed_model is null or char_length(p_routed_model) not between 1 and 160
     or p_estimated_credits is null or p_estimated_credits <= 0
     or p_estimated_amount is null or p_estimated_amount <= 0 or p_estimated_amount > 1000000
     or p_currency <> 'USD'
     or p_config_id is null or char_length(p_config_id) > 64
     or p_pricing_source <> 'runway_model_router_dry_run'
     or p_expires_at is null or p_expires_at <= clock_timestamp()
     or p_expires_at > clock_timestamp() + interval '5 minutes 30 seconds' then
    raise exception 'VIDEO_WORKFLOW_QUOTE_ARGUMENTS_INVALID';
  end if;
  if not exists (
    select 1 from executive_visuals.projects p where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_WORKFLOW_QUOTE_PROJECT_NOT_FOUND';
  end if;
  insert into executive_visuals.video_workflow_quotes(
    id,owner_id,project_id,request_id,request_hash,provider,model,operation,
    routed_provider,routed_model,estimated_credits,estimated_amount,currency,
    config_id,pricing_source,expires_at
  ) values (
    p_quote_id,p_owner_id,p_project_id,p_request_id,p_request_hash,p_provider,p_model,p_operation,
    p_routed_provider,p_routed_model,p_estimated_credits,p_estimated_amount,p_currency,
    p_config_id,p_pricing_source,p_expires_at
  );
  return p_quote_id;
end;
$record_video_workflow_quote$;

revoke all on function executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)
  to service_role;


-- Durable retry queue for storage objects whose compensating delete failed.
-- This migration is additive and does not modify existing asset or job rows.
create table if not exists executive_visuals.asset_storage_cleanup (
  id uuid primary key default gen_random_uuid(),
  storage_bucket text not null check (storage_bucket = 'executive-visuals-media'),
  object_path text not null unique,
  reason text not null default 'asset_metadata_persistence_failed'
    check (char_length(reason) between 1 and 100),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/original\.[a-z0-9]{1,8}$'
  )
);

create index if not exists ev_asset_storage_cleanup_pending
  on executive_visuals.asset_storage_cleanup(next_attempt_at, created_at)
  where completed_at is null;

alter table executive_visuals.asset_storage_cleanup enable row level security;
revoke all on executive_visuals.asset_storage_cleanup from public, anon, authenticated;
grant select, insert, update on executive_visuals.asset_storage_cleanup to service_role;

comment on table executive_visuals.asset_storage_cleanup is
  'Service-role-only durable outbox for retrying exact private storage object deletions after failed asset publication compensation.';


-- Idempotent publication ledger for cloud-render outputs.
-- Additive only: existing jobs, assets, and storage objects are untouched.
create table if not exists executive_visuals.asset_publications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  publication_key text not null check (char_length(publication_key) between 1 and 200),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  asset_id uuid not null,
  status text not null default 'reserved' check (status in ('reserved','published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint ev_asset_publications_owner_key unique(owner_id, publication_key),
  constraint ev_asset_publications_asset_id_key unique(asset_id),
  check ((status='published') = (published_at is not null))
);

create index if not exists ev_asset_publications_pending
  on executive_visuals.asset_publications(updated_at)
  where status='reserved';

alter table executive_visuals.asset_publications enable row level security;
revoke all on executive_visuals.asset_publications from public, anon, authenticated;
grant select, insert, update on executive_visuals.asset_publications to service_role;

create or replace function executive_visuals.reserve_asset_publication(
  p_owner_id uuid,
  p_project_id uuid,
  p_publication_key text,
  p_payload_sha256 text,
  p_asset_id uuid
)
returns table(owner_id uuid, project_id uuid, publication_key text, payload_sha256 text, asset_id uuid, status text)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare reserved executive_visuals.asset_publications;
begin
  if p_owner_id is null or p_asset_id is null
     or p_publication_key is null or char_length(p_publication_key) not between 1 and 200
     or p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid asset publication reservation';
  end if;

  insert into executive_visuals.asset_publications as current_publication
    (owner_id, project_id, publication_key, payload_sha256, asset_id)
  values
    (p_owner_id, p_project_id, p_publication_key, p_payload_sha256, p_asset_id)
  on conflict on constraint ev_asset_publications_owner_key do update
    set updated_at = now()
    where current_publication.project_id is not distinct from excluded.project_id
      and current_publication.payload_sha256 = excluded.payload_sha256
  returning current_publication.* into reserved;

  if not found then
    raise exception 'publication key already reserved for different project or payload'
      using errcode = '23505';
  end if;

  return query select reserved.owner_id, reserved.project_id, reserved.publication_key,
    reserved.payload_sha256, reserved.asset_id, reserved.status;
end;
$$;

create or replace function executive_visuals.complete_asset_publication(
  p_owner_id uuid,
  p_publication_key text,
  p_asset_id uuid
)
returns table(owner_id uuid, publication_key text, asset_id uuid, status text, published_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare completed executive_visuals.asset_publications;
begin
  update executive_visuals.asset_publications publication
    set status='published', published_at=coalesce(publication.published_at, now()), updated_at=now()
  where publication.owner_id=p_owner_id
    and publication.publication_key=p_publication_key
    and publication.asset_id=p_asset_id
    and exists (
      select 1 from executive_visuals.assets asset
      where asset.id=publication.asset_id
        and asset.owner_id=publication.owner_id
        and asset.project_id is not distinct from publication.project_id
        and asset.sha256=publication.payload_sha256
        and asset.deleted_at is null
    )
  returning publication.* into completed;

  if not found then
    raise exception 'publication cannot be completed without its matching active asset';
  end if;

  return query select completed.owner_id, completed.publication_key,
    completed.asset_id, completed.status, completed.published_at;
end;
$$;

revoke all on function executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid) from public, anon, authenticated;
revoke all on function executive_visuals.complete_asset_publication(uuid,text,uuid) from public, anon, authenticated;
grant execute on function executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid) to service_role;
grant execute on function executive_visuals.complete_asset_publication(uuid,text,uuid) to service_role;

comment on table executive_visuals.asset_publications is
  'Service-role-only idempotency ledger for render outputs. Stable owner-scoped publication keys bind one payload checksum to one asset UUID.';


-- 20261108240000_video_workflow_approval_enqueue.sql
-- Atomically bind a human-approved workflow quote to the existing budget approval,
-- durable job, reservation, usage ledger and job event transaction.
-- The RPC is service-role-only; callers must authenticate and authorize the actor first.
-- This records approval and queues work but does not enable provider workers or paid execution.

create or replace function executive_visuals.approve_and_enqueue_video_workflow(
  p_quote_id uuid,
  p_approval_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_request_hash text,
  p_config_id text,
  p_idempotency_key text,
  p_input jsonb,
  p_approved_max_amount numeric,
  p_approval_note text
)
returns table(
  job_id uuid,
  job_status text,
  idempotent_replay boolean,
  budget_reservation_id uuid,
  approval_id uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $approve_and_enqueue_video_workflow$
declare
  quote_row executive_visuals.video_workflow_quotes;
  existing executive_visuals.jobs;
  policy executive_visuals.video_generation_budget_policies;
  enqueued record;
  reservation_id uuid;
  consumed_approval_id uuid;
  reservation_amount numeric;
begin
  if p_quote_id is null or p_approval_id is null or p_owner_id is null or p_project_id is null
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_config_id is null or p_config_id !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,180}$'
     or jsonb_typeof(p_input) is distinct from 'object'
     or octet_length(p_input::text) > 32000
     or p_approved_max_amount is null or p_approved_max_amount <= 0 or p_approved_max_amount > 1000000
     or p_approval_note is null or char_length(btrim(p_approval_note)) < 1
     or char_length(p_approval_note) > 1000 then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_ARGUMENTS_INVALID';
  end if;

  select * into quote_row
  from executive_visuals.video_workflow_quotes q
  where q.id = p_quote_id
  for update;

  if quote_row.id is null
     or quote_row.owner_id is distinct from p_owner_id
     or quote_row.project_id is distinct from p_project_id then
    raise exception 'VIDEO_WORKFLOW_QUOTE_NOT_FOUND';
  end if;

  -- A retry of the exact same approved request returns the existing durable job.
  select * into existing
  from executive_visuals.jobs j
  where j.owner_id = p_owner_id and j.idempotency_key = p_idempotency_key
  for update;

  if existing.id is not null then
    if existing.job_type <> 'video.generate'
       or existing.project_id is distinct from p_project_id
       or coalesce(existing.input ->> 'requestHash','') <> p_request_hash
       or existing.input is distinct from p_input
       or coalesce(existing.input ->> 'workflowQuoteId','') <> p_quote_id::text
       or coalesce(existing.input ->> 'workflowRequestId','') <> quote_row.request_id
       or coalesce(existing.input ->> 'provider','') <> 'runway'
       or coalesce(existing.input ->> 'model','') <> 'model-router'
       or quote_row.request_hash <> p_request_hash
       or quote_row.request_id <> p_idempotency_key
       or quote_row.config_id <> p_config_id
       or quote_row.state <> 'consumed' then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_IDEMPOTENCY_CONFLICT';
    end if;

    select r.id, r.approval_id, r.reserved_amount into reservation_id, consumed_approval_id, reservation_amount
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = existing.id;

    if reservation_id is null or consumed_approval_id is null or reservation_amount is distinct from p_approved_max_amount then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_RESERVATION_MISSING';
    end if;

    return query select existing.id, existing.status, true, reservation_id, consumed_approval_id;
    return;
  end if;

  if quote_row.state <> 'quoted' or quote_row.expires_at <= clock_timestamp() then
    raise exception 'VIDEO_WORKFLOW_QUOTE_EXPIRED_OR_CONSUMED';
  end if;

  if quote_row.request_hash <> p_request_hash
     or quote_row.request_id <> p_idempotency_key
     or quote_row.provider <> 'runway'
     or quote_row.model <> 'model-router'
     or quote_row.config_id <> p_config_id
     or coalesce(p_input ->> 'provider','') <> quote_row.provider
     or coalesce(p_input ->> 'model','') <> quote_row.model
     or coalesce(p_input ->> 'operation','') <> quote_row.operation
     or coalesce(p_input ->> 'requestHash','') <> quote_row.request_hash
     or coalesce(p_input ->> 'projectId','') <> quote_row.project_id::text
     or coalesce(p_input ->> 'workflowQuoteId','') <> quote_row.id::text
     or coalesce(p_input ->> 'workflowRequestId','') <> quote_row.request_id then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_REQUEST_MISMATCH';
  end if;

  if p_approved_max_amount < quote_row.estimated_amount then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_BELOW_QUOTE';
  end if;

  if not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id
    and b.project_id = p_project_id
    and b.provider = 'runway'
    and b.model = 'model-router'
    and b.currency = quote_row.currency
    and b.enabled = true
  for update;

  if policy.id is null then
    raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED';
  end if;

  if p_approved_max_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_approved_max_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;

  insert into executive_visuals.video_generation_budget_approvals(
    id,owner_id,project_id,provider,model,request_hash,currency,
    approved_max_amount,approval_note,expires_at
  ) values (
    p_approval_id,p_owner_id,p_project_id,quote_row.provider,quote_row.model,
    quote_row.request_hash,quote_row.currency,p_approved_max_amount,
    btrim(p_approval_note),quote_row.expires_at
  );

  select * into enqueued
  from executive_visuals.enqueue_video_generation_job(
    p_owner_id,p_project_id,p_idempotency_key,quote_row.provider,quote_row.model,
    quote_row.request_hash,p_input,p_approval_id,p_approved_max_amount,quote_row.currency
  );

  if enqueued.job_id is null or enqueued.budget_reservation_id is null then
    raise exception 'VIDEO_WORKFLOW_ENQUEUE_RECEIPT_INVALID';
  end if;

  update executive_visuals.video_workflow_quotes
  set state = 'consumed'
  where id = p_quote_id and state = 'quoted';

  if not found then
    raise exception 'VIDEO_WORKFLOW_QUOTE_STATE_CONFLICT';
  end if;

  return query select enqueued.job_id,enqueued.job_status,enqueued.idempotent_replay,
    enqueued.budget_reservation_id,p_approval_id;
end;
$approve_and_enqueue_video_workflow$;

revoke all on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  to service_role;


-- 20261109200000_model_router_budget_enqueue_owner_gate.sql
-- Repair the governed Runway Model Router workflow enqueue contract.
-- The generic video enqueue RPC intentionally supports direct provider adapters;
-- this workflow RPC has its own quote-bound price evidence and atomic reservation.
-- This migration is source-controlled only; do not apply to shared staging/production.

create or replace function executive_visuals.validate_video_budget_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $validate_video_budget_approval$
begin
  -- Server-side approval RPCs execute with service_role. Direct authenticated
  -- inserts remain bound to auth.uid() and the project's owner.
  if current_user not in ('postgres','service_role')
     and coalesce(auth.role(), '') <> 'service_role'
     and new.owner_id is distinct from auth.uid() then
    raise exception 'VIDEO_BUDGET_APPROVAL_OWNER_INVALID';
  end if;
  if new.project_id is not null and not exists (
    select 1 from executive_visuals.projects p
    where p.id = new.project_id and p.owner_id = new.owner_id
  ) then
    raise exception 'VIDEO_BUDGET_APPROVAL_PROJECT_OWNER_INVALID' using errcode = '42501';
  end if;
  new.created_at := clock_timestamp();
  new.consumed_at := null;
  if new.expires_at <= clock_timestamp()
     or new.expires_at > clock_timestamp() + interval '15 minutes' then
    raise exception 'VIDEO_BUDGET_APPROVAL_EXPIRY_INVALID';
  end if;
  return new;
end;
$validate_video_budget_approval$;

create or replace function executive_visuals.approve_and_enqueue_video_workflow(
  p_quote_id uuid,
  p_approval_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_request_hash text,
  p_config_id text,
  p_idempotency_key text,
  p_input jsonb,
  p_approved_max_amount numeric,
  p_approval_note text
)
returns table(
  job_id uuid,
  job_status text,
  idempotent_replay boolean,
  budget_reservation_id uuid,
  approval_id uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $approve_and_enqueue_video_workflow$
declare
  quote_row executive_visuals.video_workflow_quotes;
  existing executive_visuals.jobs;
  policy executive_visuals.video_generation_budget_policies;
  inserted_job executive_visuals.jobs;
  reservation_id uuid;
  consumed_approval_id uuid;
  reservation_amount numeric;
  used_requests bigint;
begin
  if p_quote_id is null or p_approval_id is null or p_owner_id is null or p_project_id is null
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_config_id is null or p_config_id !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,180}$'
     or jsonb_typeof(p_input) is distinct from 'object'
     or octet_length(p_input::text) > 32000
     or p_approved_max_amount is null or p_approved_max_amount <= 0 or p_approved_max_amount > 1000000
     or p_approval_note is null or char_length(btrim(p_approval_note)) < 1
     or char_length(p_approval_note) > 1000 then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_ARGUMENTS_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':video.generate', 0));

  if not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
    for update
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;

  select * into quote_row
  from executive_visuals.video_workflow_quotes q
  where q.id = p_quote_id
  for update;

  if quote_row.id is null
     or quote_row.owner_id is distinct from p_owner_id
     or quote_row.project_id is distinct from p_project_id then
    raise exception 'VIDEO_WORKFLOW_QUOTE_NOT_FOUND';
  end if;

  -- A retry of the exact same consumed quote returns its original job and
  -- reservation. It never creates a second approval or charges twice.
  select * into existing
  from executive_visuals.jobs j
  where j.owner_id = p_owner_id and j.idempotency_key = p_idempotency_key
  for update;

  if existing.id is not null then
    if existing.job_type <> 'video.generate'
       or existing.project_id is distinct from p_project_id
       or coalesce(existing.input ->> 'requestHash','') <> p_request_hash
       or existing.input is distinct from p_input
       or coalesce(existing.input ->> 'workflowQuoteId','') <> p_quote_id::text
       or coalesce(existing.input ->> 'workflowRequestId','') <> quote_row.request_id
       or coalesce(existing.input ->> 'provider','') <> 'runway'
       or coalesce(existing.input ->> 'model','') <> 'model-router'
       or quote_row.request_hash <> p_request_hash
       or quote_row.request_id <> p_idempotency_key
       or quote_row.config_id <> p_config_id
       or quote_row.state <> 'consumed' then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_IDEMPOTENCY_CONFLICT';
    end if;

    select r.id, r.approval_id, r.reserved_amount
      into reservation_id, consumed_approval_id, reservation_amount
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = existing.id;

    if reservation_id is null or consumed_approval_id is null
       or reservation_amount is distinct from p_approved_max_amount then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_RESERVATION_MISSING';
    end if;

    return query select existing.id, existing.status, true, reservation_id, consumed_approval_id;
    return;
  end if;

  if quote_row.state <> 'quoted' or quote_row.expires_at <= clock_timestamp() then
    raise exception 'VIDEO_WORKFLOW_QUOTE_EXPIRED_OR_CONSUMED';
  end if;

  if quote_row.request_hash <> p_request_hash
     or quote_row.request_id <> p_idempotency_key
     or quote_row.provider <> 'runway'
     or quote_row.model <> 'model-router'
     or quote_row.config_id <> p_config_id
     or coalesce(p_input ->> 'provider','') <> quote_row.provider
     or coalesce(p_input ->> 'model','') <> quote_row.model
     or coalesce(p_input ->> 'operation','') <> quote_row.operation
     or coalesce(p_input ->> 'requestHash','') <> quote_row.request_hash
     or coalesce(p_input ->> 'projectId','') <> quote_row.project_id::text
     or coalesce(p_input ->> 'workflowQuoteId','') <> quote_row.id::text
     or coalesce(p_input ->> 'workflowRequestId','') <> quote_row.request_id
     or coalesce(p_input ->> 'outputFormat','mp4') <> 'mp4'
     or coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]{1,2}$'
     or (p_input ->> 'durationSeconds')::integer not between 2 and 30 then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_REQUEST_MISMATCH';
  end if;

  if p_approved_max_amount < quote_row.estimated_amount then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_BELOW_QUOTE';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id
    and b.project_id = p_project_id
    and b.provider = 'runway'
    and b.model = 'model-router'
    and b.currency = quote_row.currency
    and b.enabled = true
  for update;

  if policy.id is null then
    raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED';
  end if;

  if p_approved_max_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_approved_max_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;

  select count(*) into used_requests
  from executive_visuals.video_generation_usage_reservations u
  where u.owner_id = p_owner_id and u.provider = 'runway' and u.model = 'model-router'
    and u.created_at >= clock_timestamp() - interval '24 hours';

  if policy.rolling_24h_request_limit = 0 or used_requests >= policy.rolling_24h_request_limit then
    raise exception 'VIDEO_JOB_USAGE_LIMIT_REACHED';
  end if;

  insert into executive_visuals.video_generation_budget_approvals(
    id,owner_id,project_id,provider,model,request_hash,currency,
    approved_max_amount,approval_note,expires_at
  ) values (
    p_approval_id,p_owner_id,p_project_id,'runway','model-router',
    quote_row.request_hash,quote_row.currency,p_approved_max_amount,
    btrim(p_approval_note),quote_row.expires_at
  );

  -- Model Router uses a quote-bound dynamic route, so its verified dry-run
  -- estimate is the price floor. The generic direct-provider allowlist and
  -- hard-coded per-second price floor do not apply to this adapter.
  insert into executive_visuals.jobs(
    owner_id,project_id,job_type,status,input,idempotency_key,
    estimated_cost,approved_by,approved_at
  ) values (
    p_owner_id,p_project_id,'video.generate','queued',p_input,p_idempotency_key,
    jsonb_build_object('amount',p_approved_max_amount,'currency',quote_row.currency),
    p_owner_id,clock_timestamp()
  ) returning * into inserted_job;

  insert into executive_visuals.video_generation_budget_reservations(
    job_id,approval_id,policy_id,owner_id,project_id,provider,model,currency,reserved_amount
  ) values (
    inserted_job.id,p_approval_id,policy.id,p_owner_id,p_project_id,
    'runway','model-router',quote_row.currency,p_approved_max_amount
  ) returning id into reservation_id;

  insert into executive_visuals.video_generation_usage_reservations(job_id,owner_id,provider,model)
  values (inserted_job.id,p_owner_id,'runway','model-router');

  update executive_visuals.video_generation_budget_policies
  set reserved_amount=reserved_amount+p_approved_max_amount,updated_at=clock_timestamp()
  where id=policy.id;

  update executive_visuals.video_generation_budget_approvals
  set consumed_at=clock_timestamp()
  where id=p_approval_id;

  update executive_visuals.video_workflow_quotes
  set state='consumed'
  where id=p_quote_id and state='quoted';

  if not found then
    raise exception 'VIDEO_WORKFLOW_QUOTE_STATE_CONFLICT';
  end if;

  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values (
    inserted_job.id,p_owner_id,'job.queued',
    jsonb_build_object('jobType','video.generate','provider','runway','model','model-router',
      'requestHash',p_request_hash,'workflowQuoteId',p_quote_id,
      'budgetReservationId',reservation_id,'reservedAmount',p_approved_max_amount,'currency',quote_row.currency)
  );

  insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
  values (
    p_owner_id,p_project_id,'job.queued','job',inserted_job.id::text,
    jsonb_build_object('jobType','video.generate','provider','runway','model','model-router',
      'requestHash',p_request_hash,'workflowQuoteId',p_quote_id,'budgetReservationId',reservation_id)
  );

  return query select inserted_job.id,inserted_job.status,false,reservation_id,p_approval_id;
end;
$approve_and_enqueue_video_workflow$;

revoke all on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  to service_role;


-- 20261109213000_video_generation_cost_ledger.sql
-- Immutable, request-level provider cost ledger for cloud video completion.
-- Source-controlled only: CI applies this migration to disposable PostgreSQL.
-- It is deliberately separate from provider budget policy counters so every
-- completed paid task has a durable, independently reconcilable cost record.

create table if not exists executive_visuals.video_generation_cost_ledger (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique,
  owner_id uuid not null references auth.users(id) on delete restrict,
  project_id uuid references executive_visuals.projects(id) on delete set null,
  provider text not null check (char_length(provider) between 1 and 100),
  model text not null check (char_length(model) between 1 and 160),
  provider_task_id text not null check (char_length(provider_task_id) between 1 and 240),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reserved_amount numeric(14,6) not null check (reserved_amount > 0),
  actual_amount numeric(14,6) not null check (actual_amount >= 0 and actual_amount <= reserved_amount),
  unused_reservation numeric(14,6) generated always as (reserved_amount - actual_amount) stored,
  evidence_reference text not null check (char_length(evidence_reference) between 1 and 1000),
  idempotency_key text not null unique,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists ev_video_cost_owner_created
  on executive_visuals.video_generation_cost_ledger(owner_id,created_at desc);
create index if not exists ev_video_cost_provider_created
  on executive_visuals.video_generation_cost_ledger(provider,model,created_at desc);

alter table executive_visuals.video_generation_cost_ledger enable row level security;
revoke all on executive_visuals.video_generation_cost_ledger from public, anon, authenticated;
grant select, insert on executive_visuals.video_generation_cost_ledger to service_role;

create or replace function executive_visuals.record_video_generation_cost_ledger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $record_video_generation_cost_ledger$
declare
  reservation executive_visuals.video_generation_budget_reservations;
  provider_name text;
  model_name text;
  task_id text;
  evidence_ref text;
begin
  if new.job_type <> 'video.generate'
     or new.status not in ('succeeded','partial')
     or old.status is not distinct from new.status then
    return new;
  end if;

  select * into reservation
  from executive_visuals.video_generation_budget_reservations r
  where r.job_id = new.id;

  if reservation.id is null or reservation.state <> 'settled'
     or reservation.actual_amount is null then
    raise exception 'VIDEO_COST_LEDGER_REQUIRES_SETTLED_BUDGET';
  end if;

  provider_name := lower(coalesce(new.output ->> 'provider',''));
  model_name := coalesce(new.output ->> 'model','');
  task_id := coalesce(new.output ->> 'providerTaskId','');
  evidence_ref := coalesce(new.output ->> 'costEvidenceReference','');

  if provider_name <> reservation.provider
     or model_name = ''
     or task_id = ''
     or char_length(task_id) > 240
     or evidence_ref = ''
     or char_length(evidence_ref) > 1000 then
    raise exception 'VIDEO_COST_LEDGER_EVIDENCE_INVALID';
  end if;

  insert into executive_visuals.video_generation_cost_ledger(
    job_id,owner_id,project_id,provider,model,provider_task_id,currency,
    reserved_amount,actual_amount,evidence_reference,idempotency_key
  ) values (
    new.id,new.owner_id,new.project_id,provider_name,model_name,task_id,
    reservation.currency,reservation.reserved_amount,reservation.actual_amount,
    evidence_ref,'video-generation-cost:' || new.id::text
  );

  return new;
end;
$record_video_generation_cost_ledger$;

revoke all on function executive_visuals.record_video_generation_cost_ledger()
  from public, anon, authenticated;

drop trigger if exists ev_video_generation_cost_ledger_after_completion
  on executive_visuals.jobs;
create trigger ev_video_generation_cost_ledger_after_completion
after update of status on executive_visuals.jobs
for each row
when (new.job_type = 'video.generate' and new.status in ('succeeded','partial'))
execute function executive_visuals.record_video_generation_cost_ledger();

comment on table executive_visuals.video_generation_cost_ledger is
  'Append-only provider actual-cost evidence written in the same transaction as cloud video job completion.';

create or replace function executive_visuals.reject_video_cost_ledger_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $reject_video_cost_ledger_mutation$
begin
  raise exception 'VIDEO_COST_LEDGER_IS_APPEND_ONLY';
end;
$reject_video_cost_ledger_mutation$;

revoke all on function executive_visuals.reject_video_cost_ledger_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists ev_video_cost_ledger_immutable
  on executive_visuals.video_generation_cost_ledger;
create trigger ev_video_cost_ledger_immutable
before update or delete on executive_visuals.video_generation_cost_ledger
for each row execute function executive_visuals.reject_video_cost_ledger_mutation();


-- 20261109230000_cloud_customer_credit_reservations.sql
-- Durable customer generation-credit accounts and atomic reserve/settle RPCs.
-- This migration is additive and source-controlled. It is applied only to disposable
-- PostgreSQL CI databases until a separate production migration approval is given.

create table if not exists executive_visuals.billing_credit_accounts (
  owner_id uuid primary key references auth.users(id) on delete restrict,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists executive_visuals.billing_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  amount bigint not null check (amount <> 0),
  event_type text not null check (event_type in ('grant','admin_adjustment','generation_reserve','generation_refund','generation_settlement','expiry')),
  reference_id uuid,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  description text not null default '' check (char_length(description) <= 500),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists ev_billing_credit_ledger_owner_created
  on executive_visuals.billing_credit_ledger(owner_id, created_at desc);
create index if not exists ev_billing_credit_ledger_reference
  on executive_visuals.billing_credit_ledger(reference_id) where reference_id is not null;

create table if not exists executive_visuals.billing_credit_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  job_id uuid references executive_visuals.jobs(id) on delete restrict,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  reserved_credits bigint not null check (reserved_credits > 0),
  actual_credits bigint check (actual_credits is null or actual_credits >= 0),
  state text not null default 'reserved' check (state in ('reserved','settled','released')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  unique(job_id)
);

alter table executive_visuals.billing_credit_accounts enable row level security;
alter table executive_visuals.billing_credit_ledger enable row level security;
alter table executive_visuals.billing_credit_reservations enable row level security;
revoke all on executive_visuals.billing_credit_accounts from public, anon, authenticated;
revoke all on executive_visuals.billing_credit_ledger from public, anon, authenticated;
revoke all on executive_visuals.billing_credit_reservations from public, anon, authenticated;
grant select, insert, update on executive_visuals.billing_credit_accounts to service_role;
grant select, insert on executive_visuals.billing_credit_ledger to service_role;
grant select, insert, update on executive_visuals.billing_credit_reservations to service_role;

create or replace function executive_visuals.reject_billing_credit_ledger_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $reject_billing_credit_ledger_mutation$
begin
  raise exception 'BILLING_CREDIT_LEDGER_IS_APPEND_ONLY';
end;
$reject_billing_credit_ledger_mutation$;
revoke all on function executive_visuals.reject_billing_credit_ledger_mutation()
  from public, anon, authenticated, service_role;
drop trigger if exists ev_billing_credit_ledger_immutable on executive_visuals.billing_credit_ledger;
create trigger ev_billing_credit_ledger_immutable
before update or delete on executive_visuals.billing_credit_ledger
for each row execute function executive_visuals.reject_billing_credit_ledger_mutation();

create or replace function executive_visuals.grant_generation_credits(
  p_owner_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_description text default 'Credit grant',
  p_evidence jsonb default '{}'::jsonb
)
returns table(ledger_id uuid, balance bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $grant_generation_credits$
declare
  existing executive_visuals.billing_credit_ledger;
  new_id uuid;
  current_balance bigint;
begin
  if p_owner_id is null or p_amount is null or p_amount <= 0 or p_amount > 1000000000
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'BILLING_CREDIT_GRANT_ARGUMENTS_INVALID';
  end if;

  insert into executive_visuals.billing_credit_accounts(owner_id)
  values(p_owner_id) on conflict(owner_id) do nothing;

  perform 1 from executive_visuals.billing_credit_accounts a
  where a.owner_id = p_owner_id and a.status = 'active'
  for update;
  if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

  select * into existing from executive_visuals.billing_credit_ledger l
  where l.idempotency_key = p_idempotency_key;
  if existing.id is not null then
    if existing.owner_id <> p_owner_id or existing.amount <> p_amount
       or existing.event_type <> 'grant' or existing.evidence <> p_evidence then
      raise exception 'BILLING_CREDIT_IDEMPOTENCY_CONFLICT';
    end if;
    select coalesce(sum(l.amount),0) into current_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
    return query select existing.id,current_balance,true;
    return;
  end if;

  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,idempotency_key,description,evidence)
  values(p_owner_id,p_amount,'grant',p_idempotency_key,left(coalesce(p_description,''),500),p_evidence)
  returning id into new_id;
  update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
  where owner_id=p_owner_id;
  select coalesce(sum(l.amount),0) into current_balance
  from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
  return query select new_id,current_balance,false;
end;
$grant_generation_credits$;

create or replace function executive_visuals.reserve_generation_credits(
  p_owner_id uuid,
  p_job_id uuid,
  p_credits bigint,
  p_idempotency_key text
)
returns table(reservation_id uuid, balance bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $reserve_generation_credits$
declare
  existing executive_visuals.billing_credit_reservations;
  account_status text;
  current_balance bigint;
  new_reservation_id uuid;
begin
  if p_owner_id is null or p_job_id is null or p_credits is null or p_credits <= 0 or p_credits > 100000000
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception 'BILLING_CREDIT_RESERVATION_ARGUMENTS_INVALID';
  end if;
  if not exists(select 1 from executive_visuals.jobs j where j.id=p_job_id and j.owner_id=p_owner_id) then
    raise exception 'BILLING_JOB_OWNER_MISMATCH';
  end if;

  insert into executive_visuals.billing_credit_accounts(owner_id)
  values(p_owner_id) on conflict(owner_id) do nothing;
  select a.status into account_status
  from executive_visuals.billing_credit_accounts a
  where a.owner_id=p_owner_id for update;
  if account_status is distinct from 'active' then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

  select * into existing from executive_visuals.billing_credit_reservations r
  where r.idempotency_key=p_idempotency_key;
  if existing.id is not null then
    if existing.owner_id<>p_owner_id or existing.job_id<>p_job_id or existing.reserved_credits<>p_credits then
      raise exception 'BILLING_CREDIT_IDEMPOTENCY_CONFLICT';
    end if;
    select coalesce(sum(l.amount),0) into current_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
    return query select existing.id,current_balance,true;
    return;
  end if;

  select coalesce(sum(l.amount),0) into current_balance
  from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
  if current_balance < p_credits then raise exception 'BILLING_INSUFFICIENT_CREDITS'; end if;

  insert into executive_visuals.billing_credit_reservations(owner_id,job_id,idempotency_key,reserved_credits)
  values(p_owner_id,p_job_id,p_idempotency_key,p_credits)
  returning id into new_reservation_id;
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
  values(p_owner_id,-p_credits,'generation_reserve',p_job_id,'credit-reserve:'||p_idempotency_key,'Generation credit reservation');
  current_balance := current_balance - p_credits;
  return query select new_reservation_id,current_balance,false;
end;
$reserve_generation_credits$;

create or replace function executive_visuals.settle_generation_credit_reservation(
  p_reservation_id uuid,
  p_actual_credits bigint,
  p_evidence jsonb
)
returns table(balance bigint, adjustment bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $settle_generation_credit_reservation$
declare
  reservation executive_visuals.billing_credit_reservations;
  current_balance bigint;
  delta bigint;
begin
  if p_reservation_id is null or p_actual_credits is null or p_actual_credits < 0
     or p_actual_credits > 1000000000 or p_evidence is null
     or jsonb_typeof(p_evidence) <> 'object'
     or coalesce(p_evidence->>'provider','') = ''
     or coalesce(p_evidence->>'evidenceType','') not in
       ('provider_task_receipt','provider_invoice','provider_usage_reconciliation','verified_no_charge_cancellation')
     or coalesce(p_evidence->>'evidenceId','') = '' then
    raise exception 'BILLING_CREDIT_SETTLEMENT_EVIDENCE_INVALID';
  end if;

  select * into reservation from executive_visuals.billing_credit_reservations r
  where r.id=p_reservation_id;
  if reservation.id is null then raise exception 'BILLING_CREDIT_RESERVATION_NOT_FOUND'; end if;
  perform 1 from executive_visuals.billing_credit_accounts a
  where a.owner_id=reservation.owner_id for update;
  if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
  select * into reservation from executive_visuals.billing_credit_reservations r
  where r.id=p_reservation_id for update;

  if reservation.state='settled' then
    if reservation.actual_credits<>p_actual_credits or reservation.evidence<>p_evidence then
      raise exception 'BILLING_CREDIT_SETTLEMENT_CONFLICT';
    end if;
    select coalesce(sum(l.amount),0) into current_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=reservation.owner_id;
    return query select current_balance,reservation.reserved_credits-p_actual_credits,true;
    return;
  end if;
  if reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_SETTLEABLE'; end if;

  delta := reservation.reserved_credits - p_actual_credits;
  if delta <> 0 then
    insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description,evidence)
    values(
      reservation.owner_id,delta,
      case when delta>0 then 'generation_refund' else 'generation_settlement' end,
      reservation.job_id,'credit-settlement:'||reservation.id::text,
      'Provider-verified generation credit settlement',p_evidence
    );
  end if;
  update executive_visuals.billing_credit_reservations
  set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
  where id=reservation.id;
  update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
  where owner_id=reservation.owner_id;
  select coalesce(sum(l.amount),0) into current_balance
  from executive_visuals.billing_credit_ledger l where l.owner_id=reservation.owner_id;
  return query select current_balance,delta,false;
end;
$settle_generation_credit_reservation$;

create or replace function executive_visuals.release_generation_credit_reservation(
  p_reservation_id uuid,
  p_reason text
)
returns table(balance bigint,replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $release_generation_credit_reservation$
declare
  reservation executive_visuals.billing_credit_reservations;
  current_balance bigint;
begin
  if p_reservation_id is null or char_length(coalesce(p_reason,'')) not between 1 and 500 then
    raise exception 'BILLING_CREDIT_RELEASE_ARGUMENTS_INVALID';
  end if;
  select * into reservation from executive_visuals.billing_credit_reservations r
  where r.id=p_reservation_id;
  if reservation.id is null then raise exception 'BILLING_CREDIT_RESERVATION_NOT_FOUND'; end if;
  perform 1 from executive_visuals.billing_credit_accounts a
  where a.owner_id=reservation.owner_id for update;
  if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
  select * into reservation from executive_visuals.billing_credit_reservations r
  where r.id=p_reservation_id for update;
  if reservation.state='released' then
    select coalesce(sum(l.amount),0) into current_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=reservation.owner_id;
    return query select current_balance,true;
    return;
  end if;
  if reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_RELEASABLE'; end if;
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
  values(reservation.owner_id,reservation.reserved_credits,'generation_refund',reservation.job_id,
    'credit-release:'||reservation.id::text,left(p_reason,500));
  update executive_visuals.billing_credit_reservations set state='released',settled_at=clock_timestamp()
  where id=reservation.id;
  update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
  where owner_id=reservation.owner_id;
  select coalesce(sum(l.amount),0) into current_balance
  from executive_visuals.billing_credit_ledger l where l.owner_id=reservation.owner_id;
  return query select current_balance,false;
end;
$release_generation_credit_reservation$;

revoke all on function executive_visuals.grant_generation_credits(uuid,bigint,text,text,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text) from public,anon,authenticated;
revoke all on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.release_generation_credit_reservation(uuid,text) from public,anon,authenticated;
grant execute on function executive_visuals.grant_generation_credits(uuid,bigint,text,text,jsonb) to service_role;
grant execute on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text) to service_role;

-- 20261111230000_video_generation_entitlement_gate.sql
create or replace function executive_visuals.assert_video_generation_entitlement(p_owner_id uuid)
returns void language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $assert_video_generation_entitlement$
declare
  active_subscription_id uuid;
begin
  if p_owner_id is null then
    raise exception 'VIDEO_GENERATION_ENTITLEMENT_OWNER_REQUIRED' using errcode='22023';
  end if;
  select s.id into active_subscription_id
  from executive_visuals.customer_subscriptions s
  where s.owner_id=p_owner_id
    and s.status in ('active','trialing')
    and s.current_period_start <= clock_timestamp()
    and s.current_period_end > clock_timestamp()
    and s.entitlements_snapshot @> '{"ai_generation":true}'::jsonb
  order by s.current_period_end desc
  limit 1
  for share;
  if active_subscription_id is null then
    raise exception 'VIDEO_GENERATION_ENTITLEMENT_REQUIRED' using errcode='42501';
  end if;
end;
$assert_video_generation_entitlement$;
revoke all on function executive_visuals.assert_video_generation_entitlement(uuid)
  from public,anon,authenticated,service_role;
alter function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  rename to reserve_generation_credits_without_entitlement;
revoke all on function executive_visuals.reserve_generation_credits_without_entitlement(uuid,uuid,bigint,text)
  from public,anon,authenticated,service_role;
create or replace function executive_visuals.reserve_generation_credits(
  p_owner_id uuid,p_job_id uuid,p_credits bigint,p_idempotency_key text
) returns table(reservation_id uuid,balance bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $reserve_generation_credits_entitlement_gate$
begin
  perform executive_visuals.assert_video_generation_entitlement(p_owner_id);
  return query select r.reservation_id,r.balance,r.replayed
  from executive_visuals.reserve_generation_credits_without_entitlement(
    p_owner_id,p_job_id,p_credits,p_idempotency_key
  ) r;
end;
$reserve_generation_credits_entitlement_gate$;
revoke all on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  from public,anon,authenticated;
grant execute on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  to service_role;

grant execute on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb) to service_role;
grant execute on function executive_visuals.release_generation_credit_reservation(uuid,text) to service_role;


-- 20261109240000_video_workflow_customer_credit_gate.sql
-- Bind customer-credit reservation to cloud video workflow approval/enqueue.
-- This replacement is additive and remains disabled on production until separately approved.
create or replace function executive_visuals.approve_and_enqueue_video_workflow(
  p_quote_id uuid,
  p_approval_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_request_hash text,
  p_config_id text,
  p_idempotency_key text,
  p_input jsonb,
  p_approved_max_amount numeric,
  p_approval_note text
)
returns table(
  job_id uuid,
  job_status text,
  idempotent_replay boolean,
  budget_reservation_id uuid,
  approval_id uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $approve_and_enqueue_video_workflow$
declare
  quote_row executive_visuals.video_workflow_quotes;
  existing executive_visuals.jobs;
  policy executive_visuals.video_generation_budget_policies;
  enqueued record;
  reservation_id uuid;
  consumed_approval_id uuid;
  reservation_amount numeric;
  credit_reservation record;
begin
  if p_quote_id is null or p_approval_id is null or p_owner_id is null or p_project_id is null
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_config_id is null or p_config_id !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,180}$'
     or jsonb_typeof(p_input) is distinct from 'object'
     or octet_length(p_input::text) > 32000
     or p_approved_max_amount is null or p_approved_max_amount <= 0 or p_approved_max_amount > 1000000
     or p_approval_note is null or char_length(btrim(p_approval_note)) < 1
     or char_length(p_approval_note) > 1000 then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_ARGUMENTS_INVALID';
  end if;

  select * into quote_row
  from executive_visuals.video_workflow_quotes q
  where q.id = p_quote_id
  for update;

  if quote_row.id is null
     or quote_row.owner_id is distinct from p_owner_id
     or quote_row.project_id is distinct from p_project_id then
    raise exception 'VIDEO_WORKFLOW_QUOTE_NOT_FOUND';
  end if;

  -- A retry of the exact same approved request returns the existing durable job.
  select * into existing
  from executive_visuals.jobs j
  where j.owner_id = p_owner_id and j.idempotency_key = p_idempotency_key
  for update;

  if existing.id is not null then
    if existing.job_type <> 'video.generate'
       or existing.project_id is distinct from p_project_id
       or coalesce(existing.input ->> 'requestHash','') <> p_request_hash
       or existing.input is distinct from p_input
       or coalesce(existing.input ->> 'workflowQuoteId','') <> p_quote_id::text
       or coalesce(existing.input ->> 'workflowRequestId','') <> quote_row.request_id
       or coalesce(existing.input ->> 'provider','') <> 'runway'
       or coalesce(existing.input ->> 'model','') <> 'model-router'
       or quote_row.request_hash <> p_request_hash
       or quote_row.request_id <> p_idempotency_key
       or quote_row.config_id <> p_config_id
       or quote_row.state <> 'consumed' then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_IDEMPOTENCY_CONFLICT';
    end if;

    select r.id, r.approval_id, r.reserved_amount into reservation_id, consumed_approval_id, reservation_amount
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = existing.id;

    if reservation_id is null or consumed_approval_id is null or reservation_amount is distinct from p_approved_max_amount then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_RESERVATION_MISSING';
    end if;
    if not exists (
      select 1 from executive_visuals.billing_credit_reservations cr
      where cr.job_id=existing.id and cr.owner_id=p_owner_id
        and cr.reserved_credits=quote_row.estimated_credits
    ) then
      raise exception 'VIDEO_WORKFLOW_CUSTOMER_CREDIT_RESERVATION_MISSING';
    end if;

    return query select existing.id, existing.status, true, reservation_id, consumed_approval_id;
    return;
  end if;

  if quote_row.state <> 'quoted' or quote_row.expires_at <= clock_timestamp() then
    raise exception 'VIDEO_WORKFLOW_QUOTE_EXPIRED_OR_CONSUMED';
  end if;

  if quote_row.request_hash <> p_request_hash
     or quote_row.request_id <> p_idempotency_key
     or quote_row.provider <> 'runway'
     or quote_row.model <> 'model-router'
     or quote_row.config_id <> p_config_id
     or coalesce(p_input ->> 'provider','') <> quote_row.provider
     or coalesce(p_input ->> 'model','') <> quote_row.model
     or coalesce(p_input ->> 'operation','') <> quote_row.operation
     or coalesce(p_input ->> 'requestHash','') <> quote_row.request_hash
     or coalesce(p_input ->> 'projectId','') <> quote_row.project_id::text
     or coalesce(p_input ->> 'workflowQuoteId','') <> quote_row.id::text
     or coalesce(p_input ->> 'workflowRequestId','') <> quote_row.request_id then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_REQUEST_MISMATCH';
  end if;

  if p_approved_max_amount < quote_row.estimated_amount then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_BELOW_QUOTE';
  end if;

  if not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id
    and b.project_id = p_project_id
    and b.provider = 'runway'
    and b.model = 'model-router'
    and b.currency = quote_row.currency
    and b.enabled = true
  for update;

  if policy.id is null then
    raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED';
  end if;

  if p_approved_max_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_approved_max_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;

  insert into executive_visuals.video_generation_budget_approvals(
    id,owner_id,project_id,provider,model,request_hash,currency,
    approved_max_amount,approval_note,expires_at
  ) values (
    p_approval_id,p_owner_id,p_project_id,quote_row.provider,quote_row.model,
    quote_row.request_hash,quote_row.currency,p_approved_max_amount,
    btrim(p_approval_note),quote_row.expires_at
  );

  select * into enqueued
  from executive_visuals.enqueue_video_generation_job(
    p_owner_id,p_project_id,p_idempotency_key,quote_row.provider,quote_row.model,
    quote_row.request_hash,p_input,p_approval_id,p_approved_max_amount,quote_row.currency
  );

  if enqueued.job_id is null or enqueued.budget_reservation_id is null then
    raise exception 'VIDEO_WORKFLOW_ENQUEUE_RECEIPT_INVALID';
  end if;

  -- Customer credits and provider-budget reservations commit or roll back with
  -- the same approval/enqueue transaction. An insufficient balance therefore
  -- cannot leave a queued provider job or consume a quote.
  select * into credit_reservation
  from executive_visuals.reserve_generation_credits(
    p_owner_id,enqueued.job_id,quote_row.estimated_credits,
    'video-workflow:' || quote_row.id::text
  );
  if credit_reservation.reservation_id is null then
    raise exception 'VIDEO_WORKFLOW_CUSTOMER_CREDIT_RESERVATION_INVALID';
  end if;

  update executive_visuals.video_workflow_quotes
  set state = 'consumed'
  where id = p_quote_id and state = 'quoted';

  if not found then
    raise exception 'VIDEO_WORKFLOW_QUOTE_STATE_CONFLICT';
  end if;

  return query select enqueued.job_id,enqueued.job_status,enqueued.idempotent_replay,
    enqueued.budget_reservation_id,p_approval_id;
end;
$approve_and_enqueue_video_workflow$;

revoke all on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  to service_role;


-- 20261109250000_cloud_customer_credit_job_settlement.sql
-- Settle the customer credit reservation against authoritative provider evidence.
-- The worker calls this only for workflow-quoted jobs; service-role only.
create or replace function executive_visuals.settle_generation_credits_for_job(
  p_job_id uuid,
  p_owner_id uuid,
  p_provider text,
  p_actual_credits bigint,
  p_evidence jsonb
)
returns table(balance bigint, adjustment bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $settle_generation_credits_for_job$
declare
  job_row executive_visuals.jobs;
  reservation_id uuid;
begin
  if p_job_id is null or p_owner_id is null
     or p_provider is null or char_length(p_provider) not between 1 and 100
     or p_actual_credits is null or p_actual_credits < 0 or p_actual_credits > 1000000000
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
     or p_evidence->>'provider' is distinct from p_provider
     or coalesce(p_evidence->>'evidenceType','') not in
       ('provider_task_receipt','provider_invoice','provider_usage_reconciliation')
     or coalesce(p_evidence->>'evidenceId','') = ''
     or coalesce(p_evidence->>'evidenceReference','') = '' then
    raise exception 'BILLING_CREDIT_JOB_SETTLEMENT_ARGUMENTS_INVALID';
  end if;

  select * into job_row from executive_visuals.jobs j
  where j.id=p_job_id and j.owner_id=p_owner_id and j.job_type='video.generate';
  if job_row.id is null then raise exception 'BILLING_CREDIT_JOB_OWNER_MISMATCH'; end if;
  if coalesce(job_row.input->>'provider','') <> p_provider then
    raise exception 'BILLING_CREDIT_PROVIDER_MISMATCH';
  end if;

  select r.id into reservation_id
  from executive_visuals.billing_credit_reservations r
  where r.job_id=p_job_id and r.owner_id=p_owner_id;
  if reservation_id is null then raise exception 'BILLING_CREDIT_JOB_RESERVATION_NOT_FOUND'; end if;

  return query
  select s.balance,s.adjustment,s.replayed
  from executive_visuals.settle_generation_credit_reservation(
    reservation_id,p_actual_credits,p_evidence
  ) s;
end;
$settle_generation_credits_for_job$;

revoke all on function executive_visuals.settle_generation_credits_for_job(uuid,uuid,text,bigint,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.settle_generation_credits_for_job(uuid,uuid,text,bigint,jsonb)
  to service_role;


\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('123e4567-e89b-42d3-a456-426614174000'),
 ('223e4567-e89b-42d3-a456-426614174000');
insert into executive_visuals.projects(id,owner_id,name) values
 ('323e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000','Cloud video PostgreSQL test');

select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);
set role authenticated;

insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5','USD',10,5,10,true
);
select set_config('test.video_policy_id',id::text,false)
from executive_visuals.video_generation_budget_policies
where owner_id='123e4567-e89b-42d3-a456-426614174000'
  and project_id='323e4567-e89b-42d3-a456-426614174000'
  and provider='runway' and model='gen4.5' and currency='USD';
insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'google','gemini-omni-1.1-flash','USD',10,3,10,true
);
select set_config('test.google_video_policy_id',id::text,false)
from executive_visuals.video_generation_budget_policies
where owner_id='123e4567-e89b-42d3-a456-426614174000'
  and project_id='323e4567-e89b-42d3-a456-426614174000'
  and provider='google' and model='gemini-omni-1.1-flash' and currency='USD';
insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2','USD',10,5,10,true
);
select set_config('test.aleph2_video_policy_id',id::text,false)
from executive_visuals.video_generation_budget_policies
where owner_id='123e4567-e89b-42d3-a456-426614174000'
  and project_id='323e4567-e89b-42d3-a456-426614174000'
  and provider='runway' and model='aleph2' and currency='USD';
insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','model-router','USD',10,5,10,true
);
do $column_guard$
begin
 if has_column_privilege('authenticated','executive_visuals.video_generation_budget_policies','reserved_amount','UPDATE')
    or has_column_privilege('authenticated','executive_visuals.video_generation_budget_policies','spent_amount','UPDATE') then
   raise exception 'authenticated unexpectedly has budget counter update privileges';
 end if;
 if not has_column_privilege('authenticated','executive_visuals.video_generation_budget_policies','spend_limit_amount','UPDATE') then
   raise exception 'authenticated cannot update permitted budget configuration';
 end if;
end
$column_guard$;

insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values (
 '523e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5',repeat('a',64),'USD',2,'integration test',clock_timestamp()+interval '10 minutes'
);
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values
 ('b23e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000','google','gemini-omni-1.1-flash',repeat('b',64),'USD',3,'Gemini integration test',clock_timestamp()+interval '10 minutes'),
 ('c23e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000','google','gemini-omni-1.1-flash',repeat('c',64),'USD',3,'Gemini under-reservation test',clock_timestamp()+interval '10 minutes'),
 ('d23e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000','google','gemini-omni-1.1-flash',repeat('d',64),'USD',3,'Gemini resolution test',clock_timestamp()+interval '10 minutes');
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values (
 'f23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','model-router',repeat('f',64),'USD',5,'Runway Model Router integration test',clock_timestamp()+interval '10 minutes'
);
do $owner_guard$
begin
 begin
  insert into executive_visuals.video_generation_budget_approvals(
   id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,expires_at
  ) values (
   '623e4567-e89b-42d3-a456-426614174000',
   '223e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'runway','gen4.5',repeat('b',64),'USD',1,clock_timestamp()+interval '10 minutes'
  );
  raise exception 'approval owner spoof unexpectedly succeeded';
 exception when others then
  if sqlerrm = 'approval owner spoof unexpectedly succeeded' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_APPROVAL_OWNER_INVALID' then raise; end if;
 end;
end
$owner_guard$;

-- A different authenticated user cannot issue an approval against another owner's project.
select set_config('request.jwt.claim.sub','223e4567-e89b-42d3-a456-426614174000',false);
do $project_approval_guard$
begin
 begin
  insert into executive_visuals.video_generation_budget_approvals(
   id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,expires_at
  ) values (
   'a23e4567-e89b-42d3-a456-426614174000',
   '223e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'runway','gen4.5',repeat('d',64),'USD',1,clock_timestamp()+interval '10 minutes'
  );
  raise exception 'non-owner project approval unexpectedly succeeded';
 exception when others then
  if sqlerrm = 'non-owner project approval unexpectedly succeeded' then raise; end if;
  if sqlstate <> '42501' then raise; end if;
 end;
end
$project_approval_guard$;
select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);

reset role;
set role service_role;

select * from executive_visuals.grant_generation_credits(
 '123e4567-e89b-42d3-a456-426614174000',100000,
 'cloud-video-workflow-credit-seed','Cloud video PostgreSQL integration seed',
 '{"source":"disposable_ci_fixture"}'::jsonb
);

-- Credits alone must not authorize generation without an active AI entitlement.
insert into executive_visuals.jobs(owner_id,project_id,job_type,status,input)
values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'video.generate','queued','{}'::jsonb
);
do $generation_entitlement_denied$
declare test_job uuid;
begin
  select id into test_job from executive_visuals.jobs
  where owner_id='123e4567-e89b-42d3-a456-426614174000'
    and job_type='video.generate'
  order by created_at desc limit 1;
  begin
    perform * from executive_visuals.reserve_generation_credits(
      '123e4567-e89b-42d3-a456-426614174000',test_job,1,'no-entitlement-must-fail'
    );
    raise exception 'generation reservation unexpectedly succeeded without AI entitlement';
  exception when insufficient_privilege then
    if sqlerrm <> 'VIDEO_GENERATION_ENTITLEMENT_REQUIRED' then raise; end if;
  end;
end
$generation_entitlement_denied$;

-- The workflow owner receives an active, time-bounded AI-generation entitlement.
insert into executive_visuals.customer_subscriptions(
 id,owner_id,status,current_period_start,current_period_end,entitlements_snapshot
) values (
 '923e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 'active',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '30 days',
 '{"ai_generation":true,"video_generation":true}'::jsonb
);

-- Workflow quote ledger: service-role-only immutable quote recording.
do $workflow_quote_privileges$
begin
 if has_table_privilege('authenticated','executive_visuals.video_workflow_quotes','SELECT')
    or has_table_privilege('authenticated','executive_visuals.video_workflow_quotes','INSERT')
    or has_table_privilege('authenticated','executive_visuals.video_workflow_quotes','UPDATE') then
   raise exception 'authenticated unexpectedly has direct workflow quote table access';
 end if;
 if has_function_privilege('authenticated',
   'executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)',
   'EXECUTE') then
   raise exception 'authenticated unexpectedly can record workflow quotes';
 end if;
end
$workflow_quote_privileges$;

select executive_visuals.record_video_workflow_quote(
 '723e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-workflow-quote-001',repeat('e',64),'runway','model-router','text-to-video',
 'runway','gen4.5',275,2.75,'USD','studio-video',
 'runway_model_router_dry_run',clock_timestamp()+interval '4 minutes'
);

do $workflow_quote_record$
declare quote_row executive_visuals.video_workflow_quotes;
begin
 select * into quote_row from executive_visuals.video_workflow_quotes
 where id='723e4567-e89b-42d3-a456-426614174000';
 if quote_row.id is null or quote_row.owner_id <> '123e4567-e89b-42d3-a456-426614174000'
    or quote_row.project_id <> '323e4567-e89b-42d3-a456-426614174000'
    or quote_row.request_hash <> repeat('e',64)
    or quote_row.state <> 'quoted'
    or quote_row.estimated_amount <> 2.75
    or quote_row.currency <> 'USD' then
   raise exception 'workflow quote ledger did not preserve the exact quote scope';
 end if;
 begin
  perform executive_visuals.record_video_workflow_quote(
   '823e4567-e89b-42d3-a456-426614174000',
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-workflow-quote-invalid',repeat('d',64),'runway','model-router','text-to-video',
   'runway','gen4.5',275,-1,'USD','studio-video',
   'runway_model_router_dry_run',clock_timestamp()+interval '4 minutes'
  );
  raise exception 'invalid workflow quote amount unexpectedly recorded';
 exception when others then
  if sqlerrm = 'invalid workflow quote amount unexpectedly recorded' then raise; end if;
  if sqlerrm <> 'VIDEO_WORKFLOW_QUOTE_ARGUMENTS_INVALID' then raise; end if;
 end;
end
$workflow_quote_record$;

-- Explicit workflow approval atomically consumes the quote, records the approval,
-- reserves the project budget and queues one idempotent durable job.
do $workflow_quote_approval_privileges$
begin
 if has_function_privilege('authenticated',
   'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)',
   'EXECUTE') then
  raise exception 'authenticated unexpectedly can approve and enqueue workflow video';
 end if;
end
$workflow_quote_approval_privileges$;

create temporary table workflow_approval_result as
select * from executive_visuals.approve_and_enqueue_video_workflow(
 '723e4567-e89b-42d3-a456-426614174000',
 'e23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 repeat('e',64),'studio-video','pg-workflow-quote-001',
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','runway','model','model-router','requestHash',repeat('e',64),
  'operation','text-to-video','durationSeconds',5,'outputFormat','mp4',
  'workflowQuoteId','723e4567-e89b-42d3-a456-426614174000',
  'workflowRequestId','pg-workflow-quote-001'
 ),2.75,'Approved exact workflow quote integration test'
);

do $workflow_quote_approval_result$
declare result_row record; quote_row executive_visuals.video_workflow_quotes;
       reservation executive_visuals.video_generation_budget_reservations;
       customer_reservation executive_visuals.billing_credit_reservations;
       approval executive_visuals.video_generation_budget_approvals;
       policy executive_visuals.video_generation_budget_policies;
begin
 select * into result_row from workflow_approval_result;
 select * into quote_row from executive_visuals.video_workflow_quotes
  where id='723e4567-e89b-42d3-a456-426614174000';
 select * into reservation from executive_visuals.video_generation_budget_reservations
  where job_id=result_row.job_id;
 select * into customer_reservation from executive_visuals.billing_credit_reservations
  where job_id=result_row.job_id;
 select * into approval from executive_visuals.video_generation_budget_approvals
  where id=reservation.approval_id;
 select * into policy from executive_visuals.video_generation_budget_policies
  where owner_id='123e4567-e89b-42d3-a456-426614174000'
   and project_id='323e4567-e89b-42d3-a456-426614174000'
   and provider='runway' and model='model-router';
 if result_row.job_id is null or result_row.job_status <> 'queued'
    or result_row.idempotent_replay
    or result_row.budget_reservation_id is distinct from reservation.id
    or result_row.approval_id is distinct from approval.id
    or quote_row.state <> 'consumed'
    or reservation.state <> 'reserved'
    or reservation.reserved_amount <> 2.75
    or customer_reservation.id is null
    or customer_reservation.owner_id <> '123e4567-e89b-42d3-a456-426614174000'
    or customer_reservation.reserved_credits <> quote_row.estimated_credits
    or customer_reservation.state <> 'reserved'
    or approval.consumed_at is null
    or policy.reserved_amount <> 2.75 then
  raise exception 'workflow approval did not atomically consume quote, approve, reserve and enqueue';
 end if;
end
$workflow_quote_approval_result$;

create temporary table workflow_approval_replay as
select * from executive_visuals.approve_and_enqueue_video_workflow(
 '723e4567-e89b-42d3-a456-426614174000',
 'e23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 repeat('e',64),'studio-video','pg-workflow-quote-001',
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','runway','model','model-router','requestHash',repeat('e',64),
  'operation','text-to-video','durationSeconds',5,'outputFormat','mp4',
  'workflowQuoteId','723e4567-e89b-42d3-a456-426614174000',
  'workflowRequestId','pg-workflow-quote-001'
 ),2.75,'Idempotent replay of approved workflow quote'
);

do $workflow_quote_approval_replay$
declare first_row record; replay_row record;
begin
 select * into first_row from workflow_approval_result;
 select * into replay_row from workflow_approval_replay;
 if not replay_row.idempotent_replay
    or replay_row.job_id is distinct from first_row.job_id
    or replay_row.budget_reservation_id is distinct from first_row.budget_reservation_id
    or replay_row.approval_id is distinct from first_row.approval_id
    or (select count(*) from executive_visuals.billing_credit_reservations
        where job_id=first_row.job_id) <> 1
    or (select count(*) from executive_visuals.billing_credit_ledger
        where idempotency_key='credit-reserve:video-workflow:723e4567-e89b-42d3-a456-426614174000') <> 1 then
  raise exception 'workflow approval retry did not return the original job and reservation';
 end if;
end
$workflow_quote_approval_replay$;

create temporary table test_context as
select job_id, budget_reservation_id as reservation_id
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-video-001','runway','gen4.5',repeat('a',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','gen4.5','requestHash',repeat('a',64),'prompt','test scene','durationSeconds',5),
 '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
);

do $router_invalid_operation$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-router-invalid-op','runway','model-router',repeat('f',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','model-router','requestHash',repeat('f',64),
     'operation','audio-to-video','durationSeconds',8,'outputFormat','mp4',
     'prompt','A cinematic product launch'),
   'f23e4567-e89b-42d3-a456-426614174000',4.5,'USD'
  );
  raise exception 'unsupported Runway Model Router operation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'unsupported Runway Model Router operation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_OPERATION_INVALID' then raise; end if;
 end;
end
$router_invalid_operation$;

do $router_duration_guard$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-router-duration','runway','model-router',repeat('f',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','model-router','requestHash',repeat('f',64),
     'operation','text-to-video','durationSeconds',31,'outputFormat','mp4',
     'prompt','A cinematic product launch'),
   'f23e4567-e89b-42d3-a456-426614174000',4.5,'USD'
  );
  raise exception 'overlong Runway Model Router operation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'overlong Runway Model Router operation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_DURATION_INVALID' then raise; end if;
 end;
end
$router_duration_guard$;

create temporary table runway_router_context as
select job_id, budget_reservation_id as reservation_id, job_status
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-runway-router-001','runway','model-router',repeat('f',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','model-router','requestHash',repeat('f',64),
   'operation','text-to-video','durationSeconds',8,'outputFormat','mp4',
   'prompt','A cinematic product launch','aspectRatio','16:9'),
 'f23e4567-e89b-42d3-a456-426614174000',4.5,'USD'
);

create temporary table google_context as
select job_id, budget_reservation_id as reservation_id, job_status
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-google-video-001','google','gemini-omni-1.1-flash',repeat('b',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','google','model','gemini-omni-1.1-flash','requestHash',repeat('b',64),
   'prompt','A cinematic sunrise','operation','generate','durationSeconds',5,
   'resolution','720p','aspectRatio','16:9','outputFormat','mp4'),
 'b23e4567-e89b-42d3-a456-426614174000',2.586464,'USD'
);
do $google_enqueue_assertion$
declare queued google_context; policy_row executive_visuals.video_generation_budget_policies;
begin
 select * into queued from google_context;
 select * into policy_row from executive_visuals.video_generation_budget_policies
 where id=current_setting('test.google_video_policy_id')::uuid;
 if queued.job_status <> 'queued' or policy_row.reserved_amount <> 2.586464 then
   raise exception 'Gemini Omni enqueue did not create the expected queued reservation';
 end if;
end
$google_enqueue_assertion$;

do $google_budget_floor$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-google-underpriced','google','gemini-omni-1.1-flash',repeat('c',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','google','model','gemini-omni-1.1-flash','requestHash',repeat('c',64),
     'prompt','A cinematic sunrise','durationSeconds',5,'resolution','720p','outputFormat','mp4'),
   'c23e4567-e89b-42d3-a456-426614174000',2.586463,'USD'
  );
  raise exception 'under-reserved Gemini Omni generation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'under-reserved Gemini Omni generation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE' then raise; end if;
 end;
end
$google_budget_floor$;

do $google_resolution_gate$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-google-1080p','google','gemini-omni-1.1-flash',repeat('d',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','google','model','gemini-omni-1.1-flash','requestHash',repeat('d',64),
     'prompt','A cinematic sunrise','durationSeconds',5,'resolution','1080p','outputFormat','mp4'),
   'd23e4567-e89b-42d3-a456-426614174000',3,'USD'
  );
  raise exception 'unpriced Gemini Omni resolution unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'unpriced Gemini Omni resolution unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_UNSUPPORTED_RESOLUTION' then raise; end if;
 end;
end
$google_resolution_gate$;

create temporary table replay_context as
select job_id, budget_reservation_id as reservation_id, idempotent_replay
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-video-001','runway','gen4.5',repeat('a',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','gen4.5','requestHash',repeat('a',64),'prompt','test scene','durationSeconds',5),
 '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
);
do $idempotency$
declare first_row test_context; replay_row replay_context;
begin
 select * into first_row from test_context;
 select * into replay_row from replay_context;
 if not replay_row.idempotent_replay or first_row.job_id <> replay_row.job_id
    or first_row.reservation_id <> replay_row.reservation_id then
   raise exception 'idempotent enqueue did not return the same job and reservation';
 end if;
end
$idempotency$;

do $price_floor$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-video-underpriced','runway','gen4.5',repeat('d',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','gen4.5','requestHash',repeat('d',64),
     'durationSeconds',5,'outputFormat','mp4'),
   '523e4567-e89b-42d3-a456-426614174000',0.5,'USD'
  );
  raise exception 'underpriced generation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'underpriced generation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE' then raise; end if;
 end;
end
$price_floor$;

do $unpriced_provider$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-video-unpriced','luma','ray-3.2',repeat('e',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','luma','model','ray-3.2','requestHash',repeat('e',64),
     'durationSeconds',5,'outputFormat','mp4'),
   '523e4567-e89b-42d3-a456-426614174000',1,'USD'
  );
  raise exception 'unpriced provider unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'unpriced provider unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED' then raise; end if;
 end;
end
$unpriced_provider$;

do $approval_replay$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-video-approval-replay','runway','gen4.5',repeat('a',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','gen4.5','requestHash',repeat('a',64),
     'durationSeconds',5,'outputFormat','mp4'),
   '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
  );
  raise exception 'consumed approval unexpectedly authorized another job';
 exception when others then
  if sqlerrm = 'consumed approval unexpectedly authorized another job' then raise; end if;
  if sqlerrm <> 'VIDEO_JOB_BUDGET_APPROVAL_INVALID' then raise; end if;
 end;
end
$approval_replay$;

update executive_visuals.jobs
set status='processing',lease_owner='video-worker-pg-test',
    lease_expires_at=clock_timestamp()+interval '5 minutes',
    lease_heartbeat_at=clock_timestamp(),attempt_count=1
where id=(select job_id from test_context);

select * from executive_visuals.prepare_video_generation_submission(
 (select job_id from test_context),
 '123e4567-e89b-42d3-a456-426614174000','runway','gen4.5',repeat('a',64)
);
select executive_visuals.begin_video_generation_submission((select job_id from test_context),'video-worker-pg-test');
select executive_visuals.record_video_generation_submission(
 (select job_id from test_context),'video-worker-pg-test','runway-task-pg-test','{"acceptedStatus":"queued"}'::jsonb
);

insert into executive_visuals.assets(
 id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path
) values (
 '723e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'generated-video-1.mp4','video/mp4',1024,repeat('a',64),
 'executive-visuals-media',
 '323e4567-e89b-42d3-a456-426614174000/723e4567-e89b-42d3-a456-426614174000/original.mp4'
);

select executive_visuals.finish_video_generation_job(
 (select job_id from test_context),'video-worker-pg-test','succeeded',
 jsonb_build_object('provider','runway','model','gen4.5',
   'providerTaskId','runway-task-pg-test',
   'costEvidenceReference','provider-receipt:runway-task-pg-test',
   'assetIds',jsonb_build_array('723e4567-e89b-42d3-a456-426614174000')),
 null,0.75
);

select policy_row.id,policy_row.reserved_amount,policy_row.spent_amount,
       reservation_row.state,reservation_row.actual_amount,
       job_row.status,job_row.lease_owner,submission_row.state,
       submission_row.provider_task_id,
       (select count(*) from executive_visuals.video_generation_usage_reservations where job_id=(select job_id from test_context)) as usage_count
from executive_visuals.video_generation_budget_policies policy_row
cross join executive_visuals.video_generation_budget_reservations reservation_row
cross join executive_visuals.jobs job_row
cross join executive_visuals.video_generation_submissions submission_row
where policy_row.id=current_setting('test.video_policy_id')::uuid
  and reservation_row.job_id=(select job_id from test_context)
  and job_row.id=(select job_id from test_context)
  and submission_row.job_id=(select job_id from test_context);

select 1 / case when exists (
  select 1
  from executive_visuals.video_generation_budget_policies policy_row
  join executive_visuals.video_generation_budget_reservations reservation_row
    on reservation_row.job_id=(select job_id from test_context)
  join executive_visuals.jobs job_row
    on job_row.id=(select job_id from test_context)
  join executive_visuals.video_generation_submissions submission_row
    on submission_row.job_id=(select job_id from test_context)
  where policy_row.id=current_setting('test.video_policy_id')::uuid
    and policy_row.reserved_amount=0 and policy_row.spent_amount=0.75
    and reservation_row.state='settled' and reservation_row.actual_amount=0.75
    and job_row.status='succeeded' and job_row.lease_owner is null
    and submission_row.state='succeeded'
    and submission_row.provider_task_id='runway-task-pg-test'
    and (select count(*) from executive_visuals.video_generation_usage_reservations where job_id=(select job_id from test_context))=1
) then 1 else 0 end as final_state_assertion;

do $provider_gate$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-unpriced-provider','luma','ray-3.2',repeat('d',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','luma','model','ray-3.2','requestHash',repeat('d',64)),
   '523e4567-e89b-42d3-a456-426614174000',0.5,'USD'
  );
  raise exception 'provider without verified pricing was accepted';
 exception when others then
  if sqlerrm = 'provider without verified pricing was accepted' then raise; end if;
  if sqlerrm <> 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED' then raise; end if;
 end;
end
$provider_gate$;

reset role;
select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);
set role authenticated;
do $budget_floor$
begin
 begin
  update executive_visuals.video_generation_budget_policies
  set spend_limit_amount=0.5,max_per_job_amount=0.5
  where id=current_setting('test.video_policy_id')::uuid;
  raise exception 'budget ceiling was lowered below committed spend';
 exception when others then
  if sqlerrm = 'budget ceiling was lowered below committed spend' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_LIMIT_BELOW_COMMITTED_SPEND' then raise; end if;
 end;
end
$budget_floor$;
reset role;
set role service_role;
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values (
 '923e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5',repeat('c',64),'USD',1,'overrun test',clock_timestamp()+interval '10 minutes'
);
reset role;
set role service_role;
create temporary table overrun_context as
select job_id, budget_reservation_id as reservation_id
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-video-overrun','runway','gen4.5',repeat('c',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','gen4.5','requestHash',repeat('c',64),'durationSeconds',2),
 '923e4567-e89b-42d3-a456-426614174000',0.5,'USD'
);
update executive_visuals.jobs
set status='processing',lease_owner='video-worker-overrun',
    lease_expires_at=clock_timestamp()+interval '5 minutes'
where id=(select job_id from overrun_context);
do $overrun_guard$
begin
 begin
  perform executive_visuals.finish_video_generation_job(
   (select job_id from overrun_context),'video-worker-overrun','succeeded','{}'::jsonb,null,0.75
  );
  raise exception 'over-reservation actual cost unexpectedly settled';
 exception when others then
  if sqlerrm = 'over-reservation actual cost unexpectedly settled' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_ACTUAL_EXCEEDS_RESERVATION' then raise; end if;
 end;
end
$overrun_guard$;
do $overrun_state$
declare policy_row executive_visuals.video_generation_budget_policies;
       reservation_row executive_visuals.video_generation_budget_reservations;
       target_job uuid;
       job_row executive_visuals.jobs;
begin
 select job_id into target_job from overrun_context;
 select * into policy_row from executive_visuals.video_generation_budget_policies
 where id=current_setting('test.video_policy_id')::uuid;
 select * into reservation_row from executive_visuals.video_generation_budget_reservations where job_id=target_job;
 select * into job_row from executive_visuals.jobs where id=target_job;
 if policy_row.reserved_amount <> 0.5 or policy_row.spent_amount <> 0.75 then
  raise exception 'failed overrun settlement changed budget counters';
 end if;
 if reservation_row.state <> 'reserved' or job_row.status <> 'processing' then
  raise exception 'failed overrun settlement partially changed job or reservation state';
 end if;
end
$overrun_state$;


-- Aleph 2 transformation approval is service-role-only and exact-request bound.
do $aleph2_rpc_acl$
begin
 if has_function_privilege('authenticated',
    'executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)','EXECUTE')
    or has_function_privilege('anon',
    'executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)','EXECUTE') then
   raise exception 'untrusted role can execute the Aleph 2 approval RPC';
 end if;
 if not has_function_privilege('service_role',
    'executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)','EXECUTE') then
   raise exception 'service_role cannot execute the Aleph 2 approval RPC';
 end if;
end
$aleph2_rpc_acl$;

select executive_visuals.create_video_generation_budget_approval(
 'a23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2',repeat('e',64),'USD',3.00,
 'Aleph 2 integration test',clock_timestamp()+interval '10 minutes'
);
create temporary table aleph2_context as
select job_id,job_status,budget_reservation_id
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-aleph2-video-001','runway','aleph2',repeat('e',64),
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','runway','model','aleph2','requestHash',repeat('e',64),
  'operation','video-to-video','sourceVideoAssetId','b23e4567-e89b-42d3-a456-426614174000',
  'prompt','Preserve the camera movement and replace the background.',
  'durationSeconds',8,'outputFormat','mp4','resolution','provider_default'
 ),
 'a23e4567-e89b-42d3-a456-426614174000',3.00,'USD'
);
do $aleph2_enqueue_assertion$
declare queued aleph2_context; policy_row executive_visuals.video_generation_budget_policies;
begin
 select * into queued from aleph2_context;
 select * into policy_row from executive_visuals.video_generation_budget_policies
 where id=current_setting('test.aleph2_video_policy_id')::uuid;
 if queued.job_status <> 'queued' or policy_row.reserved_amount <> 3.00 then
  raise exception 'Aleph 2 enqueue did not create the expected queued reservation';
 end if;
 if not exists(select 1 from executive_visuals.video_generation_budget_approvals
   where id='a23e4567-e89b-42d3-a456-426614174000' and consumed_at is not null
     and request_hash=repeat('e',64)) then
  raise exception 'Aleph 2 approval was not consumed against its exact request hash';
 end if;
end
$aleph2_enqueue_assertion$;

select executive_visuals.create_video_generation_budget_approval(
 'b23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2',repeat('f',64),'USD',2.23,
 'Aleph 2 under-reservation test',clock_timestamp()+interval '10 minutes'
);
do $aleph2_price_floor$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-aleph2-underpriced','runway','aleph2',repeat('f',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','aleph2','requestHash',repeat('f',64),
    'operation','video-to-video','sourceVideoAssetId','b23e4567-e89b-42d3-a456-426614174000',
    'prompt','Edit source','durationSeconds',8,'outputFormat','mp4'),
   'b23e4567-e89b-42d3-a456-426614174001',2.23,'USD'
  );
  raise exception 'underpriced Aleph 2 generation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'underpriced Aleph 2 generation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE' then raise; end if;
 end;
end
$aleph2_price_floor$;

select executive_visuals.create_video_generation_budget_approval(
 'c23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2',repeat('c',64),'USD',3.00,
 'Aleph 2 operation gate test',clock_timestamp()+interval '10 minutes'
);
do $aleph2_operation_gate$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-aleph2-wrong-operation','runway','aleph2',repeat('c',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','aleph2','requestHash',repeat('c',64),
    'operation','text-to-video','sourceVideoAssetId','b23e4567-e89b-42d3-a456-426614174000',
    'prompt','Edit source','durationSeconds',8,'outputFormat','mp4'),
   'c23e4567-e89b-42d3-a456-426614174001',3.00,'USD'
  );
  raise exception 'Aleph 2 non-edit operation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'Aleph 2 non-edit operation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_DURATION_OR_OPERATION_INVALID' then raise; end if;
 end;
end
$aleph2_operation_gate$;


select executive_visuals.create_video_generation_budget_approval(
 'd23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2',repeat('b',64),'USD',3.00,
 'Aleph 2 minimum duration test',clock_timestamp()+interval '10 minutes'
);
do $aleph2_minimum_duration$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-aleph2-one-second','runway','aleph2',repeat('b',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','aleph2','requestHash',repeat('b',64),
    'operation','video-to-video','sourceVideoAssetId','b23e4567-e89b-42d3-a456-426614174000',
    'prompt','Edit source','durationSeconds',1,'outputFormat','mp4'),
   'd23e4567-e89b-42d3-a456-426614174001',3.00,'USD'
  );
  raise exception 'one-second Aleph 2 generation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'one-second Aleph 2 generation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_DURATION_OR_OPERATION_INVALID' then raise; end if;
 end;
end
$aleph2_minimum_duration$;


-- Model Router workflow settlement: reconcile the reserved ceiling to verified
-- provider spend and preserve the budget ledger after durable completion.
do $workflow_router_job_lease$
declare queued record;
begin
 select * into queued from workflow_approval_result;
 update executive_visuals.jobs
 set status='processing',lease_owner='workflow-router-test-worker',
     lease_expires_at=clock_timestamp()+interval '5 minutes',
     lease_heartbeat_at=clock_timestamp()
 where id=queued.job_id and status='queued';
 if not found then raise exception 'workflow Model Router job could not be leased'; end if;
end
$workflow_router_job_lease$;

select * from executive_visuals.prepare_video_generation_submission(
 (select job_id from workflow_approval_result),
 '123e4567-e89b-42d3-a456-426614174000',
 'runway','model-router',repeat('e',64)
);
select executive_visuals.begin_video_generation_submission(
 (select job_id from workflow_approval_result),'workflow-router-test-worker'
);
select executive_visuals.record_video_generation_submission(
 (select job_id from workflow_approval_result),
 'workflow-router-test-worker','router-task-pg-integration',
 '{"route":"integration-test"}'::jsonb
);

insert into executive_visuals.assets(
 id,owner_id,project_id,original_name,media_type,byte_size,sha256,
 storage_bucket,object_path
) values (
 'f23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'workflow-router-output.mp4','video/mp4',1,repeat('a',64),
 'executive-visuals-media','workflow-router/integration-output.mp4'
);

select executive_visuals.finish_video_generation_job(
 (select job_id from workflow_approval_result),
 'workflow-router-test-worker','succeeded',
 jsonb_build_object(
  'assetIds',jsonb_build_array('f23e4567-e89b-42d3-a456-426614174001'),
  'provider','runway',
  'providerTaskId','router-task-pg-integration',
  'model','model-router',
  'costEvidenceReference','provider-receipt:router-task-pg-integration'
 ),null,2.25
);

do $workflow_router_settlement_assertion$
declare queued record; reservation executive_visuals.video_generation_budget_reservations;
       policy executive_visuals.video_generation_budget_policies;
       submission executive_visuals.video_generation_submissions;
       job_row executive_visuals.jobs;
       cost_row executive_visuals.video_generation_cost_ledger;
begin
 select * into queued from workflow_approval_result;
 select * into reservation from executive_visuals.video_generation_budget_reservations
  where job_id=queued.job_id;
 select * into policy from executive_visuals.video_generation_budget_policies
  where owner_id='123e4567-e89b-42d3-a456-426614174000'
   and project_id='323e4567-e89b-42d3-a456-426614174000'
   and provider='runway' and model='model-router';
 select * into submission from executive_visuals.video_generation_submissions
  where job_id=queued.job_id;
 select * into job_row from executive_visuals.jobs where id=queued.job_id;
 select * into cost_row from executive_visuals.video_generation_cost_ledger where job_id=queued.job_id;
 if reservation.state <> 'settled' or reservation.actual_amount <> 2.25
    or cost_row.job_id is null or cost_row.owner_id <> job_row.owner_id
    or cost_row.provider <> 'runway' or cost_row.model <> 'model-router'
    or cost_row.provider_task_id <> 'router-task-pg-integration'
    or cost_row.currency <> 'USD' or cost_row.reserved_amount <> 2.75
    or cost_row.actual_amount <> 2.25 or cost_row.unused_reservation <> 0.5
    or cost_row.evidence_reference <> 'provider-receipt:router-task-pg-integration'
    or policy.reserved_amount <> 4.5 or policy.spent_amount <> 2.25
    or submission.state <> 'succeeded' or job_row.status <> 'succeeded'
    or job_row.lease_owner is not null then
  raise exception 'Model Router settlement mismatch: reservation state %, actual %, policy reserved %, spent %, submission state %, job status %, lease %', reservation.state, reservation.actual_amount, policy.reserved_amount, policy.spent_amount, submission.state, job_row.status, job_row.lease_owner;
 end if;
end
$workflow_router_settlement_assertion$;

reset role;

do $workflow_router_cost_ledger_immutable$
begin
 begin
  update executive_visuals.video_generation_cost_ledger
  set evidence_reference='tampered'
  where job_id=(select job_id from workflow_approval_result);
  raise exception 'provider cost ledger unexpectedly allowed mutation';
 exception when others then
  if sqlerrm = 'provider cost ledger unexpectedly allowed mutation' then raise; end if;
  if sqlerrm <> 'VIDEO_COST_LEDGER_IS_APPEND_ONLY' then raise; end if;
 end;
end
$workflow_router_cost_ledger_immutable$;
select 'cloud video PostgreSQL integration checks passed' as result;


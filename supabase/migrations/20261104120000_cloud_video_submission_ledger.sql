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
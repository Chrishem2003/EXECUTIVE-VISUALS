-- Add per-attempt fencing tokens to the cloud job lease contract.
-- Existing jobs are preserved; old worker RPC entry points are disabled after v2 is installed.
alter table executive_visuals.jobs
  add column if not exists lease_token uuid;

alter table executive_visuals.jobs
  add constraint ev_jobs_processing_requires_lease_token
  check (status <> 'processing' or lease_token is not null) not valid;

create index if not exists ev_jobs_active_lease_token
  on executive_visuals.jobs(id, lease_token)
  where status='processing';

create or replace function executive_visuals.claim_next_job_v2(
  p_worker_id text,
  p_lease_seconds integer default 90,
  p_job_types text[] default null
)
returns setof executive_visuals.jobs
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare claimed executive_visuals.jobs;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then
    raise exception 'worker_id must contain between 1 and 128 characters';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
    raise exception 'lease_seconds must be between 15 and 900';
  end if;
  if p_job_types is not null and (
    cardinality(p_job_types)=0 or exists(
      select 1 from unnest(p_job_types) as requested(job_type)
      where requested.job_type is null or char_length(btrim(requested.job_type))=0
    )
  ) then raise exception 'job_types must be null or a non-empty array of non-empty values'; end if;

  with candidate as (
    select id from executive_visuals.jobs
    where status='queued'
      and (p_job_types is null or job_type=any(p_job_types))
      and (available_at is null or available_at<=clock_timestamp())
      and attempt_count<max_attempts
    order by created_at,id
    limit 1 for update skip locked
  )
  update executive_visuals.jobs j
  set status='processing',progress=5,attempt_count=j.attempt_count+1,
      started_at=coalesce(j.started_at,clock_timestamp()),updated_at=clock_timestamp(),
      lease_owner=p_worker_id,lease_token=gen_random_uuid(),
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      lease_heartbeat_at=clock_timestamp()
  from candidate where j.id=candidate.id
  returning j.* into claimed;

  if claimed.id is not null then return next claimed; end if;
  return;
end;
$$;

create or replace function executive_visuals.renew_job_lease_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_lease_seconds integer default 90
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare renewed integer;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_lease_token is null or p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
    raise exception 'invalid worker lease parameters';
  end if;
  update executive_visuals.jobs
  set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      lease_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
  where id=p_job_id and status='processing' and lease_owner=p_worker_id
    and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  get diagnostics renewed=row_count;
  return renewed=1;
end;
$$;

create or replace function executive_visuals.finish_job_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_status text,
  p_output jsonb default null,p_error jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare finished executive_visuals.jobs;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_lease_token is null then raise exception 'invalid worker lease identity'; end if;
  if p_status not in ('succeeded','partial','failed','cancelled') then raise exception 'invalid terminal job status'; end if;
  if (p_output is not null and jsonb_typeof(p_output)<>'object')
     or (p_error is not null and jsonb_typeof(p_error)<>'object') then
    raise exception 'job output and error must be JSON objects';
  end if;

  update executive_visuals.jobs
  set status=p_status,
      progress=case when p_status in ('succeeded','partial') then 100 else progress end,
      output=p_output,error=p_error,completed_at=clock_timestamp(),updated_at=clock_timestamp(),
      lease_owner=null,lease_token=null,lease_expires_at=null,lease_heartbeat_at=null
  where id=p_job_id and status='processing' and lease_owner=p_worker_id
    and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
  returning * into finished;

  if finished.id is null then return false; end if;
  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values(finished.id,finished.owner_id,'job.'||p_status,jsonb_build_object('status',p_status));
  return true;
end;
$$;

create or replace function executive_visuals.assert_job_lease_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid
)
returns boolean
language sql
security definer
set search_path = pg_catalog, executive_visuals
as $$
  select exists(
    select 1 from executive_visuals.jobs
    where id=p_job_id and status='processing' and lease_owner=p_worker_id
      and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
  );
$$;

-- A recovery transition invalidates the old execution epoch before retry.
create or replace function executive_visuals.recover_expired_jobs(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare expired executive_visuals.jobs; retryable boolean; delay_seconds integer;
  next_status text; details jsonb; recovered integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then raise exception 'limit must be between 1 and 1000'; end if;
  for expired in
    select * from executive_visuals.jobs
    where status='processing' and (lease_expires_at is null or lease_expires_at<=clock_timestamp())
    order by lease_expires_at nulls first,created_at
    limit p_limit for update skip locked
  loop
    retryable:=expired.attempt_count<expired.max_attempts;
    delay_seconds:=case when retryable then least(60,1*(2^greatest(0,expired.attempt_count-1))) else 0 end;
    next_status:=case when retryable then 'queued' else 'failed' end;
    details:=jsonb_build_object('code','WORKER_LEASE_EXPIRED',
      'message','The worker lease expired before the job completed.',
      'retryable',retryable,'retryDelaySeconds',delay_seconds);
    update executive_visuals.jobs
    set status=next_status,error=details,updated_at=clock_timestamp(),
      completed_at=case when retryable then null else clock_timestamp() end,
      available_at=case when retryable then clock_timestamp()+make_interval(secs=>delay_seconds) else null end,
      lease_owner=null,lease_token=null,lease_expires_at=null,lease_heartbeat_at=null
    where id=expired.id;
    insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
    values(expired.id,expired.owner_id,
      case when retryable then 'job.lease_expired_retry' else 'job.lease_expired_failed' end,details);
    recovered:=recovered+1;
  end loop;
  return recovered;
end;
$$;

-- Remove the legacy worker write surface: all current worker writes must present the attempt token.
do $revoke_legacy_worker_rpc$
begin
  if to_regprocedure('executive_visuals.claim_next_job(text,integer,text[])') is not null then
    execute 'revoke all on function executive_visuals.claim_next_job(text,integer,text[]) from public,anon,authenticated,service_role';
  end if;
  if to_regprocedure('executive_visuals.renew_job_lease(uuid,text,integer)') is not null then
    execute 'revoke all on function executive_visuals.renew_job_lease(uuid,text,integer) from public,anon,authenticated,service_role';
  end if;
  if to_regprocedure('executive_visuals.finish_job(uuid,text,text,jsonb,jsonb)') is not null then
    execute 'revoke all on function executive_visuals.finish_job(uuid,text,text,jsonb,jsonb) from public,anon,authenticated,service_role';
  end if;
end;
$revoke_legacy_worker_rpc$;

revoke all on function executive_visuals.claim_next_job_v2(text,integer,text[]) from public,anon,authenticated;
revoke all on function executive_visuals.renew_job_lease_v2(uuid,text,uuid,integer) from public,anon,authenticated;
revoke all on function executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.assert_job_lease_v2(uuid,text,uuid) from public,anon,authenticated;
grant execute on function executive_visuals.claim_next_job_v2(text,integer,text[]) to service_role;
grant execute on function executive_visuals.renew_job_lease_v2(uuid,text,uuid,integer) to service_role;
grant execute on function executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb) to service_role;
grant execute on function executive_visuals.assert_job_lease_v2(uuid,text,uuid) to service_role;
grant execute on function executive_visuals.recover_expired_jobs(integer) to service_role;

comment on column executive_visuals.jobs.lease_token is
  'Unique database-generated fencing token for one claim attempt; changes on every claim and is cleared on recovery or completion.';

-- Executive Visuals: isolated Neon PostgreSQL worker queue foundation.
-- Source-controlled migration only. Never apply to Neon or another database without
-- the separately approved staging provisioning and migration plan.
begin;
create schema if not exists executive_visuals;
create table if not exists executive_visuals.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid,
  job_type text not null check (char_length(job_type) between 1 and 128),
  status text not null default 'queued' check (status in ('queued','processing','reviewing','succeeded','partial','failed','cancelled','blocked','needs_input')),
  progress numeric(5,2) not null default 0 check (progress between 0 and 100),
  input jsonb not null check (jsonb_typeof(input)='object'),
  output jsonb check (output is null or jsonb_typeof(output)='object'),
  error jsonb check (error is null or jsonb_typeof(error)='object'),
  idempotency_key text,
  attempt_count integer not null default 0 check (attempt_count>=0),
  max_attempts integer not null default 2 check (max_attempts between 1 and 10),
  available_at timestamptz,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  lease_heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique(owner_id,idempotency_key),
  check (status <> 'processing' or (lease_owner is not null and lease_token is not null and lease_expires_at is not null))
);
create table if not exists executive_visuals.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references executive_visuals.jobs(id) on delete cascade,
  owner_id uuid not null,
  event_type text not null check (char_length(event_type) between 1 and 100),
  event_data jsonb not null default '{}'::jsonb check (jsonb_typeof(event_data)='object'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists ev_neon_jobs_queue on executive_visuals.jobs(available_at,created_at,id) where status='queued';
create index if not exists ev_neon_jobs_lease on executive_visuals.jobs(lease_expires_at,created_at) where status='processing';
create index if not exists ev_neon_jobs_owner on executive_visuals.jobs(owner_id,created_at desc);
create index if not exists ev_neon_job_events_job on executive_visuals.job_events(job_id,id);

create or replace function executive_visuals.claim_next_job_v2(p_worker_id text,p_lease_seconds integer default 90,p_job_types text[] default null)
returns setof executive_visuals.jobs language plpgsql security definer
set search_path=pg_catalog,executive_visuals as $$
declare claimed executive_visuals.jobs;
begin
 if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then raise exception 'worker_id invalid'; end if;
 if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then raise exception 'lease_seconds invalid'; end if;
 if p_job_types is not null and (cardinality(p_job_types)=0 or exists(select 1 from unnest(p_job_types) x where x is null or char_length(btrim(x))=0)) then raise exception 'job_types invalid'; end if;
 with candidate as (
  select id from executive_visuals.jobs where status='queued'
   and (p_job_types is null or job_type=any(p_job_types))
   and (available_at is null or available_at<=clock_timestamp())
   and attempt_count<max_attempts
  order by created_at,id limit 1 for update skip locked
 )
 update executive_visuals.jobs j set status='processing',progress=5,attempt_count=j.attempt_count+1,
  started_at=coalesce(j.started_at,clock_timestamp()),updated_at=clock_timestamp(),
  lease_owner=p_worker_id,lease_token=gen_random_uuid(),
  lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
  lease_heartbeat_at=clock_timestamp()
 from candidate where j.id=candidate.id returning j.* into claimed;
 if claimed.id is not null then return next claimed; end if;
 return;
end $$;

create or replace function executive_visuals.renew_job_lease_v2(p_job_id uuid,p_worker_id text,p_lease_token uuid,p_lease_seconds integer default 90)
returns boolean language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare changed integer;
begin
 if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 or p_lease_token is null or p_lease_seconds not between 15 and 900 then raise exception 'lease arguments invalid'; end if;
 update executive_visuals.jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),lease_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
 where id=p_job_id and status='processing' and lease_owner=p_worker_id and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
 get diagnostics changed=row_count; return changed=1;
end $$;

create or replace function executive_visuals.assert_job_lease_v2(p_job_id uuid,p_worker_id text,p_lease_token uuid)
returns boolean language sql security definer set search_path=pg_catalog,executive_visuals as $$
 select exists(select 1 from executive_visuals.jobs where id=p_job_id and status='processing' and lease_owner=p_worker_id and lease_token=p_lease_token and lease_expires_at>clock_timestamp());
$$;

create or replace function executive_visuals.recover_expired_jobs(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare expired executive_visuals.jobs; retryable boolean; delay_seconds integer; recovered integer:=0; details jsonb;
begin
 if p_limit is null or p_limit not between 1 and 1000 then raise exception 'limit invalid'; end if;
 for expired in select * from executive_visuals.jobs where status='processing' and (lease_expires_at is null or lease_expires_at<=clock_timestamp()) order by lease_expires_at nulls first,created_at limit p_limit for update skip locked loop
  retryable:=expired.attempt_count<expired.max_attempts;
  delay_seconds:=case when retryable then least(60,1*(2^greatest(0,expired.attempt_count-1))) else 0 end;
  details:=jsonb_build_object('code','WORKER_LEASE_EXPIRED','message','The worker lease expired before the job completed.','retryable',retryable,'retryDelaySeconds',delay_seconds);
  update executive_visuals.jobs set status=case when retryable then 'queued' else 'failed' end,error=details,updated_at=clock_timestamp(),completed_at=case when retryable then null else clock_timestamp() end,available_at=case when retryable then clock_timestamp()+make_interval(secs=>delay_seconds) else null end,lease_owner=null,lease_token=null,lease_expires_at=null,lease_heartbeat_at=null where id=expired.id;
  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data) values(expired.id,expired.owner_id,case when retryable then 'job.lease_expired_retry' else 'job.lease_expired_failed' end,details);
  recovered:=recovered+1;
 end loop;
 return recovered;
end $$;

create or replace function executive_visuals.finish_job_v2(p_job_id uuid,p_worker_id text,p_lease_token uuid,p_status text,p_output jsonb default null,p_error jsonb default null)
returns boolean language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare finished executive_visuals.jobs;
begin
 if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 or p_lease_token is null then raise exception 'lease identity invalid'; end if;
 if p_status not in ('succeeded','partial','failed','cancelled') then raise exception 'terminal status invalid'; end if;
 if (p_output is not null and jsonb_typeof(p_output)<>'object') or (p_error is not null and jsonb_typeof(p_error)<>'object') then raise exception 'output/error must be JSON objects'; end if;
 update executive_visuals.jobs set status=p_status,progress=case when p_status in ('succeeded','partial') then 100 else progress end,
  output=p_output,error=p_error,completed_at=clock_timestamp(),updated_at=clock_timestamp(),
  lease_owner=null,lease_token=null,lease_expires_at=null,lease_heartbeat_at=null
 where id=p_job_id and status='processing' and lease_owner=p_worker_id and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
 returning * into finished;
 if finished.id is null then return false; end if;
 insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data) values(finished.id,finished.owner_id,'job.'||p_status,jsonb_build_object('status',p_status));
 return true;
end $$;

revoke all on function executive_visuals.claim_next_job_v2(text,integer,text[]) from public;
revoke all on function executive_visuals.renew_job_lease_v2(uuid,text,uuid,integer) from public;
revoke all on function executive_visuals.assert_job_lease_v2(uuid,text,uuid) from public;
revoke all on function executive_visuals.recover_expired_jobs(integer) from public;
revoke all on function executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb) from public;
commit;

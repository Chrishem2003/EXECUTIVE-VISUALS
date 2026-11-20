-- Executive Visuals: Neon queue admission, retry deferral and quarantine.
-- Source-controlled only. Requires 0001_worker_queue.sql.
-- This migration has NOT been applied to a Neon branch.
begin;

create or replace function executive_visuals.enqueue_job_v1(
 p_owner_id uuid,p_project_id uuid,p_job_type text,p_input jsonb,
 p_idempotency_key text default null,p_max_attempts integer default 2
) returns table(job_id uuid,status text,replayed boolean)
language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare prior executive_visuals.jobs; created executive_visuals.jobs;
begin
 if p_owner_id is null or p_job_type is null or char_length(btrim(p_job_type)) not between 1 and 128
  or p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>1048576
  or (p_idempotency_key is not null and char_length(p_idempotency_key) not between 1 and 200)
  or p_max_attempts is null or p_max_attempts not between 1 and 10 then
  raise exception 'QUEUE_ENQUEUE_ARGUMENTS_INVALID';
 end if;

 if p_idempotency_key is not null then
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text||':'||p_idempotency_key,0));
  select * into prior from executive_visuals.jobs
   where owner_id=p_owner_id and idempotency_key=p_idempotency_key for update;
  if prior.id is not null then
   if prior.project_id is distinct from p_project_id or prior.job_type<>p_job_type or prior.input<>p_input then
    raise exception 'QUEUE_IDEMPOTENCY_CONFLICT';
   end if;
   return query select prior.id,prior.status,true;
   return;
  end if;
 end if;

 insert into executive_visuals.jobs(owner_id,project_id,job_type,input,idempotency_key,max_attempts)
 values(p_owner_id,p_project_id,p_job_type,p_input,p_idempotency_key,p_max_attempts)
 returning * into created;
 insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
 values(created.id,created.owner_id,'job.enqueued',jsonb_build_object('jobType',created.job_type,'projectId',created.project_id));
 return query select created.id,created.status,false;
end $$;

create or replace function executive_visuals.defer_job_v1(
 p_job_id uuid,p_worker_id text,p_lease_token uuid,p_delay_seconds integer,p_error jsonb default null
) returns boolean language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare changed integer; current_job executive_visuals.jobs;
begin
 if p_job_id is null or p_lease_token is null or p_worker_id is null
  or char_length(btrim(p_worker_id)) not between 1 and 128
  or p_delay_seconds is null or p_delay_seconds not between 1 and 86400
  or (p_error is not null and jsonb_typeof(p_error)<>'object') then
  raise exception 'QUEUE_DEFER_ARGUMENTS_INVALID';
 end if;
 update executive_visuals.jobs set status='queued',available_at=clock_timestamp()+make_interval(secs=>p_delay_seconds),
  error=p_error,updated_at=clock_timestamp(),lease_owner=null,lease_token=null,lease_expires_at=null,lease_heartbeat_at=null
 where id=p_job_id and status='processing' and lease_owner=p_worker_id and lease_token=p_lease_token
  and lease_expires_at>clock_timestamp()
 returning * into current_job;
 if current_job.id is null then return false; end if;
 insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
 values(current_job.id,current_job.owner_id,'job.deferred',jsonb_build_object('delaySeconds',p_delay_seconds,'error',coalesce(p_error,'{}'::jsonb)));
 return true;
end $$;

create or replace function executive_visuals.quarantine_job_v1(
 p_job_id uuid,p_worker_id text,p_lease_token uuid,p_error jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare changed integer; current_job executive_visuals.jobs;
begin
 if p_job_id is null or p_lease_token is null or p_worker_id is null
  or char_length(btrim(p_worker_id)) not between 1 and 128
  or p_error is null or jsonb_typeof(p_error)<>'object' or octet_length(p_error::text)>8192 then
  raise exception 'QUEUE_QUARANTINE_ARGUMENTS_INVALID';
 end if;
 update executive_visuals.jobs set status='blocked',available_at=null,error=p_error,updated_at=clock_timestamp(),
  lease_owner=null,lease_token=null,lease_expires_at=null,lease_heartbeat_at=null,completed_at=null
 where id=p_job_id and status='processing' and lease_owner=p_worker_id and lease_token=p_lease_token
  and lease_expires_at>clock_timestamp()
 returning * into current_job;
 if current_job.id is null then return false; end if;
 insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
 values(current_job.id,current_job.owner_id,'job.quarantined',p_error);
 return true;
end $$;

revoke all on function executive_visuals.enqueue_job_v1(uuid,uuid,text,jsonb,text,integer) from public;
revoke all on function executive_visuals.defer_job_v1(uuid,text,uuid,integer,jsonb) from public;
revoke all on function executive_visuals.quarantine_job_v1(uuid,text,uuid,jsonb) from public;
commit;

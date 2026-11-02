-- Durable cooperative cancellation for leased cloud jobs.
-- Existing jobs remain unchanged; cancellation is an explicit request observed by the lease owner.
alter table executive_visuals.jobs
  add column if not exists cancel_requested_at timestamptz;

create or replace function executive_visuals.request_job_cancellation(
  p_job_id uuid,
  p_owner_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  target executive_visuals.jobs;
begin
  if p_job_id is null or p_owner_id is null then
    raise exception 'job and owner identifiers are required';
  end if;
  select * into target
  from executive_visuals.jobs
  where id = p_job_id
  for update;
  if not found then return 'not_found'; end if;
  if target.owner_id <> p_owner_id and (
    target.project_id is null
    or not exists (
      select 1 from executive_visuals.projects p
      where p.id=target.project_id and p.owner_id=p_owner_id and p.archived_at is null
    ) and not exists (
      select 1 from executive_visuals.project_members m
      where m.project_id=target.project_id and m.member_id=p_owner_id and m.role='editor'
    )
  ) then return 'not_found'; end if;
  if target.status in ('draft','validated','awaiting_approval','queued','failed','blocked','needs_input','expired') then
    update executive_visuals.jobs
      set status='cancelled', cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),
          updated_at=clock_timestamp(), completed_at=clock_timestamp(),
          error=jsonb_build_object('code','JOB_CANCELLED','message','Job cancelled before execution.')
      where id=target.id;
    insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
      values(target.id,target.owner_id,'job.cancelled',jsonb_build_object('phase','before_execution'));
    return 'cancelled';
  end if;
  if target.status = 'processing' then
    if target.cancel_requested_at is null then
      update executive_visuals.jobs set cancel_requested_at=clock_timestamp(),updated_at=clock_timestamp()
        where id=target.id;
      insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
        values(target.id,target.owner_id,'job.cancellation_requested',jsonb_build_object('status',target.status));
    end if;
    return 'requested';
  end if;
  return 'not_cancellable';
end;
$$;

create or replace function executive_visuals.job_cancellation_requested(
  p_job_id uuid,
  p_worker_id text
)
returns boolean
language sql
security definer
set search_path = pg_catalog, executive_visuals
as $$
  select exists (
    select 1 from executive_visuals.jobs
    where id=p_job_id and status='processing'
      and lease_owner=p_worker_id and lease_expires_at>clock_timestamp()
      and cancel_requested_at is not null
  );
$$;

create or replace function executive_visuals.finish_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_output jsonb default null,
  p_error jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  changed integer;
  target executive_visuals.jobs;
begin
  if p_status not in ('succeeded','partial','failed','cancelled') then
    raise exception 'invalid terminal job status';
  end if;
  if p_output is not null and jsonb_typeof(p_output)<>'object' then raise exception 'job output must be an object'; end if;
  if p_error is not null and jsonb_typeof(p_error)<>'object' then raise exception 'job error must be an object'; end if;
  select * into target from executive_visuals.jobs
    where id=p_job_id and status='processing' and lease_owner=p_worker_id
      and lease_expires_at>clock_timestamp()
    for update;
  if not found then return false; end if;
  if target.cancel_requested_at is not null then
    p_status:='cancelled';
    p_output:=null;
    p_error:=jsonb_build_object('code','JOB_CANCELLED','message','Job was cooperatively cancelled by its owner.');
  end if;
  update executive_visuals.jobs
    set status=p_status,progress=case when p_status in ('succeeded','partial') then 100 else progress end,
        output=p_output,error=p_error,updated_at=clock_timestamp(),completed_at=clock_timestamp(),
        lease_owner=null,lease_expires_at=null,lease_heartbeat_at=null
    where id=p_job_id and status='processing' and lease_owner=p_worker_id;
  get diagnostics changed=row_count;
  if changed=1 then
    insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
      values(p_job_id,target.owner_id,'job.'||p_status,
        coalesce(p_error,'{}'::jsonb));
  end if;
  return changed=1;
end;
$$;

revoke all on function executive_visuals.request_job_cancellation(uuid,uuid) from public,anon,authenticated;
revoke all on function executive_visuals.job_cancellation_requested(uuid,text) from public,anon,authenticated;
grant execute on function executive_visuals.request_job_cancellation(uuid,uuid) to service_role;
grant execute on function executive_visuals.job_cancellation_requested(uuid,text) to service_role;

-- Queued jobs cancelled before claim must never be leased by a worker.
create or replace function executive_visuals.claim_next_job(
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
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then raise exception 'worker_id must contain between 1 and 128 characters'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then raise exception 'lease_seconds must be between 15 and 900'; end if;
  if p_job_types is not null and (cardinality(p_job_types)=0 or exists(select 1 from unnest(p_job_types) as requested(job_type) where requested.job_type is null or char_length(btrim(requested.job_type))=0)) then raise exception 'job_types must be null or a non-empty array of non-empty values'; end if;
  with candidate as (
    select id from executive_visuals.jobs
    where status='queued' and cancel_requested_at is null
      and (p_job_types is null or job_type=any(p_job_types))
      and (available_at is null or available_at<=clock_timestamp())
      and attempt_count<max_attempts
    order by created_at,id limit 1 for update skip locked
  )
  update executive_visuals.jobs j
    set status='processing',progress=5,attempt_count=j.attempt_count+1,
      started_at=coalesce(j.started_at,clock_timestamp()),updated_at=clock_timestamp(),
      lease_owner=p_worker_id,lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      lease_heartbeat_at=clock_timestamp()
  from candidate where j.id=candidate.id returning j.* into claimed;
  if claimed.id is not null then return next claimed; end if;
  return;
end;
$$;

revoke all on function executive_visuals.claim_next_job(text,integer,text[]) from public,anon,authenticated;
grant execute on function executive_visuals.claim_next_job(text,integer,text[]) to service_role;

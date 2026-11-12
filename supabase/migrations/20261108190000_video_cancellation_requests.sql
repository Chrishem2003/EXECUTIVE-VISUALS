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

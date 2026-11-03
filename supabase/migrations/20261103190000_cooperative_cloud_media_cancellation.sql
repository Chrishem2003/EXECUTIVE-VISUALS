-- Cooperative cancellation for running media jobs.
-- Requests are recorded under a row lock; only the current unexpired worker
-- lease can observe the request and perform the terminal cancellation.
alter table executive_visuals.jobs
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancel_requested_by uuid references auth.users(id) on delete set null;

create or replace function executive_visuals.request_media_job_cancellation(
  p_job_id uuid,
  p_project_id uuid,
  p_requested_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  current_job executive_visuals.jobs;
begin
  if p_job_id is null or p_project_id is null or p_requested_by is null then
    raise exception 'job, project and requesting user are required';
  end if;

  select * into current_job
  from executive_visuals.jobs
  where id = p_job_id
    and project_id = p_project_id
    and job_type like 'media.%'
  for update;

  if current_job.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if current_job.status <> 'processing'
     or current_job.lease_owner is null
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('status', 'not_cancellable', 'jobStatus', current_job.status);
  end if;
  if current_job.cancel_requested_at is not null then
    return jsonb_build_object('status', 'already_requested');
  end if;

  update executive_visuals.jobs
  set cancel_requested_at = clock_timestamp(),
      cancel_requested_by = p_requested_by,
      updated_at = clock_timestamp()
  where id = current_job.id
    and status = 'processing'
    and lease_owner = current_job.lease_owner
    and lease_expires_at > clock_timestamp();

  if not found then
    return jsonb_build_object('status', 'not_cancellable');
  end if;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    current_job.id,
    current_job.owner_id,
    'job.cancel_requested',
    jsonb_build_object('status', 'processing', 'requestedBy', p_requested_by)
  );

  return jsonb_build_object('status', 'requested');
end;
$$;

create or replace function executive_visuals.check_job_cancellation(
  p_job_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  current_job executive_visuals.jobs;
begin
  if p_job_id is null or p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then
    raise exception 'job and worker are required';
  end if;

  select * into current_job
  from executive_visuals.jobs
  where id = p_job_id
  for update;

  if current_job.id is null
     or current_job.status <> 'processing'
     or current_job.lease_owner <> p_worker_id
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('leaseValid', false, 'cancelRequested', false);
  end if;

  return jsonb_build_object(
    'leaseValid', true,
    'cancelRequested', current_job.cancel_requested_at is not null
  );
end;
$$;

revoke all on function executive_visuals.request_media_job_cancellation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function executive_visuals.check_job_cancellation(uuid, text) from public, anon, authenticated;
grant execute on function executive_visuals.request_media_job_cancellation(uuid, uuid, uuid) to service_role;
grant execute on function executive_visuals.check_job_cancellation(uuid, text) to service_role;

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

-- Terminal success and retry transitions must honor an accepted cancellation
-- request even if it races the worker's periodic cancellation poll.
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
  finished executive_visuals.jobs;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then
    raise exception 'worker_id must contain between 1 and 128 characters';
  end if;
  if p_status not in ('succeeded','partial','failed','cancelled') then
    raise exception 'invalid terminal job status';
  end if;
  if (p_output is not null and jsonb_typeof(p_output) <> 'object')
     or (p_error is not null and jsonb_typeof(p_error) <> 'object') then
    raise exception 'job output and error must be JSON objects';
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
  where id = p_job_id
    and status = 'processing'
    and lease_owner = p_worker_id
    and lease_expires_at > clock_timestamp()
    and (p_status = 'cancelled' or cancel_requested_at is null)
  returning * into finished;

  if finished.id is null then
    return false;
  end if;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    finished.id,
    finished.owner_id,
    'job.' || p_status,
    jsonb_build_object('status', p_status)
  );
  return true;
end;
$$;

create or replace function executive_visuals.retry_job(
  p_job_id uuid,
  p_worker_id text,
  p_error jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  current_job executive_visuals.jobs;
  retryable boolean;
  delay_seconds integer := 0;
  next_status text;
  details jsonb;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then
    raise exception 'worker_id must contain between 1 and 128 characters';
  end if;
  if p_error is null or jsonb_typeof(p_error) <> 'object' then
    raise exception 'job error must be a JSON object';
  end if;

  select * into current_job
  from executive_visuals.jobs
  where id = p_job_id
    and status = 'processing'
    and lease_owner = p_worker_id
    and lease_expires_at > clock_timestamp()
  for update;

  if current_job.id is null then
    return jsonb_build_object('accepted', false, 'status', 'lease_lost', 'retryable', false, 'delaySeconds', 0, 'attempt', 0, 'maxAttempts', 1);
  end if;

  if current_job.cancel_requested_at is not null then
    details := jsonb_build_object(
      'code', 'JOB_CANCELLED_BY_USER',
      'message', 'The job was cancelled by an authorized project editor.',
      'retryable', false
    );
    update executive_visuals.jobs
    set status = 'cancelled',
        error = details,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        available_at = null,
        lease_owner = null,
        lease_expires_at = null,
        lease_heartbeat_at = null
    where id = current_job.id;
    insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
    values (current_job.id, current_job.owner_id, 'job.cancelled', details);
    return jsonb_build_object(
      'accepted', true, 'status', 'cancelled', 'retryable', false,
      'delaySeconds', 0, 'attempt', current_job.attempt_count, 'maxAttempts', current_job.max_attempts
    );
  end if;

  retryable := p_error->'retryable' = 'true'::jsonb
    and current_job.attempt_count < current_job.max_attempts;
  delay_seconds := case when retryable
    then least(60, power(2, greatest(0, current_job.attempt_count - 1))::integer)
    else 0 end;
  next_status := case when retryable then 'queued' else 'failed' end;
  details := p_error || jsonb_build_object(
    'retryable', retryable,
    'retryDelaySeconds', delay_seconds,
    'attempt', current_job.attempt_count,
    'maxAttempts', current_job.max_attempts
  );

  update executive_visuals.jobs
  set status = next_status,
      error = details,
      updated_at = clock_timestamp(),
      completed_at = case when retryable then null else clock_timestamp() end,
      available_at = case when retryable then clock_timestamp() + make_interval(secs => delay_seconds) else null end,
      lease_owner = null,
      lease_expires_at = null,
      lease_heartbeat_at = null
  where id = current_job.id;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    current_job.id,
    current_job.owner_id,
    case when retryable then 'job.retry_scheduled' else 'job.failed' end,
    details
  );

  return jsonb_build_object(
    'accepted', true,
    'status', next_status,
    'retryable', retryable,
    'delaySeconds', delay_seconds,
    'attempt', current_job.attempt_count,
    'maxAttempts', current_job.max_attempts
  );
end;
$$;

revoke all on function executive_visuals.finish_job(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function executive_visuals.retry_job(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function executive_visuals.finish_job(uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function executive_visuals.retry_job(uuid, text, jsonb) to service_role;

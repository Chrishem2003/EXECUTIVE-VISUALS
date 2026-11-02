-- Retry transient cloud worker failures under the current unexpired lease only.
-- Permanent failures and exhausted attempts remain terminal; clients cannot call this RPC.
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

revoke all on function executive_visuals.retry_job(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function executive_visuals.retry_job(uuid, text, jsonb) to service_role;

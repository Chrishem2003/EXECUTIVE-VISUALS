-- Timeline workers must never recover expired jobs owned by other worker pools.
-- This adds a scoped RPC without changing the existing all-job recovery contract.
create or replace function executive_visuals.recover_expired_jobs_by_type(
  p_limit integer default 100,
  p_job_types text[] default null
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  expired executive_visuals.jobs;
  retryable boolean;
  delay_seconds integer;
  next_status text;
  details jsonb;
  recovered integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'limit must be between 1 and 1000';
  end if;
  if p_job_types is null or cardinality(p_job_types) = 0
    or exists (select 1 from unnest(p_job_types) as requested(job_type)
      where requested.job_type is null or char_length(btrim(requested.job_type)) = 0) then
    raise exception 'job_types must be a non-empty array of non-empty values';
  end if;

  for expired in
    select *
    from executive_visuals.jobs
    where status = 'processing'
      and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
      and job_type = any(p_job_types)
    order by lease_expires_at nulls first, created_at
    limit p_limit
    for update skip locked
  loop
    retryable := expired.attempt_count < expired.max_attempts;
    delay_seconds := case when retryable
      then least(60, 1 * (2 ^ greatest(0, expired.attempt_count - 1)))
      else 0 end;
    next_status := case when retryable then 'queued' else 'failed' end;
    details := jsonb_build_object(
      'code', 'WORKER_LEASE_EXPIRED',
      'message', 'The worker lease expired before the job completed.',
      'retryable', retryable,
      'retryDelaySeconds', delay_seconds
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
    where id = expired.id;

    insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
    values (
      expired.id,
      expired.owner_id,
      case when retryable then 'job.lease_expired_retry' else 'job.lease_expired_failed' end,
      details
    );
    recovered := recovered + 1;
  end loop;
  return recovered;
end;
$$;

revoke all on function executive_visuals.recover_expired_jobs_by_type(integer, text[]) from public, anon, authenticated;
grant execute on function executive_visuals.recover_expired_jobs_by_type(integer, text[]) to service_role;

-- Bounded, payload-free diagnostics for the trusted cloud operations plane.
-- This RPC deliberately excludes owner IDs, project IDs, inputs, outputs and errors.
create or replace function executive_visuals.list_job_diagnostics(
  p_limit integer default 100,
  p_queue_stale_after_seconds integer default 900,
  p_lease_stale_after_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  result jsonb;
  observed_at timestamptz := clock_timestamp();
begin
  if p_limit is null or p_limit not between 1 and 200
    or p_queue_stale_after_seconds is null or p_queue_stale_after_seconds not between 60 and 86400
    or p_lease_stale_after_seconds is null or p_lease_stale_after_seconds not between 30 and 3600 then
    raise exception 'invalid job diagnostics query bounds';
  end if;

  select coalesce(jsonb_agg(to_jsonb(diagnostic_row) order by diagnostic_row.updated_at desc),'[]'::jsonb)
  into result
  from (
    select
      id,
      job_type,
      status,
      progress,
      attempt_count,
      max_attempts,
      created_at,
      updated_at,
      available_at,
      started_at,
      lease_expires_at,
      lease_heartbeat_at,
      greatest(0,floor(extract(epoch from (observed_at-coalesce(available_at,created_at)))))::integer as queue_age_seconds,
      case when status='processing'
        then greatest(0,floor(extract(epoch from (observed_at-coalesce(lease_heartbeat_at,started_at,updated_at)))))::integer
        else null end as lease_age_seconds,
      jsonb_build_object(
        'queued_too_long',status='queued' and coalesce(available_at,created_at) < observed_at-make_interval(secs=>p_queue_stale_after_seconds),
        'lease_expired',status='processing' and lease_expires_at is not null and lease_expires_at <= observed_at,
        'heartbeat_stale',status='processing' and coalesce(lease_heartbeat_at,started_at,updated_at) < observed_at-make_interval(secs=>p_lease_stale_after_seconds),
        'attempts_exhausted',attempt_count>=max_attempts
      ) as diagnostic_flags
    from executive_visuals.jobs
    where status in ('queued','processing','failed')
    order by updated_at desc
    limit p_limit
  ) as diagnostic_row;

  return result;
end;
$$;

revoke all on function executive_visuals.list_job_diagnostics(integer,integer,integer) from public, anon, authenticated;
grant execute on function executive_visuals.list_job_diagnostics(integer,integer,integer) to service_role;

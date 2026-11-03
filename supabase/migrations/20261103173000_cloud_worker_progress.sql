-- Persist monotonic progress only while the reporting worker still owns
-- an unexpired processing lease. The row lock serializes progress with finish,
-- retry, recovery and lease renewal.
create or replace function executive_visuals.report_job_progress(
  p_job_id uuid,
  p_worker_id text,
  p_progress numeric
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  current_job executive_visuals.jobs;
  next_progress numeric(5,2);
begin
  if p_job_id is null or p_worker_id is null or char_length(p_worker_id) not between 1 and 128
     or p_progress is null or p_progress < 0 or p_progress > 100 then
    raise exception 'job, worker and progress (0-100) are required';
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
    return false;
  end if;

  next_progress := greatest(current_job.progress, p_progress)::numeric(5,2);
  if next_progress = current_job.progress then
    return true;
  end if;

  update executive_visuals.jobs
  set progress = next_progress, updated_at = clock_timestamp()
  where id = p_job_id;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    p_job_id,
    current_job.owner_id,
    'job.progress',
    jsonb_build_object('progress', next_progress, 'workerId', p_worker_id)
  );

  return true;
end;
$$;

revoke all on function executive_visuals.report_job_progress(uuid, text, numeric) from public, anon, authenticated;
grant execute on function executive_visuals.report_job_progress(uuid, text, numeric) to service_role;

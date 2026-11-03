-- Cancel only jobs that are still queued. A worker claim and this update
-- serialize on the same jobs row, so a running lease is never interrupted.
create or replace function executive_visuals.cancel_queued_media_job(
  p_job_id uuid,
  p_project_id uuid,
  p_cancelled_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  current_job executive_visuals.jobs;
begin
  if p_job_id is null or p_project_id is null or p_cancelled_by is null then
    raise exception 'job, project and cancelling user are required';
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

  if current_job.status <> 'queued' then
    return jsonb_build_object('status', 'not_cancellable', 'jobStatus', current_job.status);
  end if;

  update executive_visuals.jobs
  set status = 'cancelled',
      error = jsonb_build_object(
        'code', 'JOB_CANCELLED_BEFORE_START',
        'message', 'The job was cancelled before a worker claimed it.',
        'cancelledBy', p_cancelled_by
      ),
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      available_at = null
  where id = current_job.id
    and status = 'queued';

  if not found then
    return jsonb_build_object('status', 'not_cancellable');
  end if;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    current_job.id,
    current_job.owner_id,
    'job.cancelled',
    jsonb_build_object(
      'status', 'cancelled',
      'cancelledBy', p_cancelled_by,
      'reason', 'cancelled_before_start'
    )
  );

  return jsonb_build_object('status', 'cancelled');
end;
$$;

revoke all on function executive_visuals.cancel_queued_media_job(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function executive_visuals.cancel_queued_media_job(uuid, uuid, uuid) to service_role;

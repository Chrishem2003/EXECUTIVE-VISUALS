-- Authenticated cloud-video cancellation requests.
-- Source-controlled only; apply only to a dedicated disposable/staging project after review.
-- A queued job can be canceled atomically only before provider submission begins.
-- A processing/submitted task receives a cancellation request; the worker asks the
-- provider to cancel, then holds the job/budget for reconciliation because Runway
-- cancellation is best-effort and does not prove execution stopped or a refund occurred.

alter table executive_visuals.jobs
  add column if not exists cancellation_requested_at timestamptz;

create index if not exists ev_video_jobs_cancel_requested
  on executive_visuals.jobs(cancellation_requested_at, status)
  where job_type = 'video.generate' and cancellation_requested_at is not null;

-- Prevent a provider submission transition when cancellation was already committed.
create or replace function executive_visuals.begin_video_generation_submission(
  p_job_id uuid, p_worker_id text
) returns boolean
language plpgsql security invoker
set search_path = pg_catalog, executive_visuals
as $video_begin$
declare changed integer;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then
    raise exception 'VIDEO_SUBMISSION_WORKER_INVALID';
  end if;
  update executive_visuals.video_generation_submissions s
  set state='submitting', submission_started_at=clock_timestamp(),
      updated_at=clock_timestamp(), last_error_code=null
  from executive_visuals.jobs j
  where s.job_id=p_job_id and j.id=s.job_id and j.job_type='video.generate'
    and j.status='processing' and j.lease_owner=p_worker_id
    and j.lease_expires_at > clock_timestamp()
    and j.cancellation_requested_at is null
    and s.state='prepared';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$video_begin$;

create or replace function executive_visuals.request_video_generation_cancellation(
  p_job_id uuid,
  p_owner_id uuid
)
returns table(job_id uuid, job_status text, cancellation_requested boolean, submission_state text)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_cancel_request$
declare
  current_job executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
  reservation executive_visuals.video_generation_budget_reservations;
  policy executive_visuals.video_generation_budget_policies;
  changed integer;
begin
  if p_job_id is null or p_owner_id is null then
    raise exception 'VIDEO_CANCELLATION_ARGUMENTS_INVALID';
  end if;

  select * into current_job
  from executive_visuals.jobs j
  where j.id = p_job_id and j.owner_id = p_owner_id and j.job_type = 'video.generate'
  for update;

  if current_job.id is null then
    return;
  end if;

  select * into submission
  from executive_visuals.video_generation_submissions s
  where s.job_id = p_job_id and s.owner_id = p_owner_id
  for update;

  if current_job.status in ('succeeded','partial','failed','cancelled','blocked','expired') then
    return query select current_job.id, current_job.status, false, submission.state;
    return;
  end if;

  -- A queued job with no provider POST started can be canceled and its budget
  -- reservation released in this same transaction.
  if current_job.status = 'queued'
     and (submission.id is null or submission.state = 'prepared') then
    if submission.id is not null then
      update executive_visuals.video_generation_submissions
      set state = 'cancelled', updated_at = clock_timestamp(),
          metadata = metadata || jsonb_build_object('cancellation','cancelled_before_provider_submission')
      where id = submission.id and state = 'prepared';
      submission.state := 'cancelled';
    end if;

    select * into reservation
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = p_job_id
    for update;

    if reservation.id is null or reservation.state <> 'reserved' then
      raise exception 'VIDEO_CANCELLATION_BUDGET_RESERVATION_INVALID';
    end if;

    select * into policy
    from executive_visuals.video_generation_budget_policies b
    where b.id = reservation.policy_id
    for update;

    if policy.id is null or policy.reserved_amount < reservation.reserved_amount then
      raise exception 'VIDEO_CANCELLATION_BUDGET_INVARIANT_FAILED';
    end if;

    update executive_visuals.video_generation_budget_policies
    set reserved_amount = reserved_amount - reservation.reserved_amount,
        updated_at = clock_timestamp()
    where id = policy.id;

    update executive_visuals.video_generation_budget_reservations
    set state = 'released', actual_amount = null, updated_at = clock_timestamp()
    where id = reservation.id and state = 'reserved';

    update executive_visuals.jobs
    set status = 'cancelled', cancellation_requested_at = clock_timestamp(),
        error = jsonb_build_object('code','VIDEO_CANCELLED_BEFORE_SUBMISSION'),
        completed_at = clock_timestamp(), updated_at = clock_timestamp(),
        available_at = null, lease_owner = null, lease_expires_at = null, lease_heartbeat_at = null
    where id = p_job_id and status = 'queued';

    insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
    values (p_job_id,p_owner_id,'job.cancelled',
      jsonb_build_object('status','cancelled','reason','cancelled_before_provider_submission',
        'budgetReservationId',reservation.id,'reservedAmount',reservation.reserved_amount,'currency',reservation.currency));

    insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
    values (p_owner_id,current_job.project_id,'video.cancelled_before_submission',
      'job',p_job_id::text,jsonb_build_object('budgetReservationId',reservation.id,
        'reservedAmount',reservation.reserved_amount,'currency',reservation.currency));

    return query select p_job_id, 'cancelled'::text, true, coalesce(submission.state,'cancelled'::text);
    return;
  end if;

  if current_job.status in ('queued','processing') then
    update executive_visuals.jobs
    set cancellation_requested_at = coalesce(cancellation_requested_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where id = p_job_id
    returning * into current_job;

    insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
    values (p_job_id,p_owner_id,'job.cancellation_requested',
      jsonb_build_object('status',current_job.status,'providerTaskKnown',submission.provider_task_id is not null));

    return query select current_job.id, current_job.status, true, submission.state;
    return;
  end if;

  return query select current_job.id, current_job.status, false, submission.state;
end;
$video_cancel_request$;

create or replace function executive_visuals.is_video_generation_cancellation_requested(
  p_job_id uuid,
  p_worker_id text
)
returns boolean
language sql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_cancel_check$
  select exists (
    select 1 from executive_visuals.jobs j
    where j.id = p_job_id and j.job_type = 'video.generate'
      and j.status = 'processing' and j.lease_owner = p_worker_id
      and j.lease_expires_at > clock_timestamp()
      and j.cancellation_requested_at is not null
  );
$video_cancel_check$;

revoke all on function executive_visuals.request_video_generation_cancellation(uuid,uuid)
  from public, anon, authenticated;
revoke all on function executive_visuals.is_video_generation_cancellation_requested(uuid,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.request_video_generation_cancellation(uuid,uuid)
  to service_role;
grant execute on function executive_visuals.is_video_generation_cancellation_requested(uuid,text)
  to service_role;

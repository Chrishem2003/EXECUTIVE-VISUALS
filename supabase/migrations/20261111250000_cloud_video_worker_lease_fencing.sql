-- Bind every cloud-video worker side effect to the database-issued claim token.
-- The wrapper locks the job row before delegating to the reviewed business RPC;
-- the lock is held through the entire transaction, closing check-then-write races.

create or replace function executive_visuals.assert_current_video_worker_lease_v1(
  p_job_id uuid,p_worker_id text,p_lease_token uuid
) returns boolean
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $assert_video_lease$
declare locked_job_id uuid;
begin
  if p_job_id is null or p_worker_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_worker_id)) not between 1 and 128
     or p_lease_token is null then
    return false;
  end if;
  select j.id into locked_job_id
  from executive_visuals.jobs j
  where j.id=p_job_id and j.job_type='video.generate'
    and j.status='processing' and j.lease_owner=p_worker_id
    and j.lease_token=p_lease_token
    and j.lease_expires_at>pg_catalog.clock_timestamp()
  for update;
  return locked_job_id is not null;
end;
$assert_video_lease$;
revoke all on function executive_visuals.assert_current_video_worker_lease_v1(uuid,text,uuid)
  from public,anon,authenticated,service_role;

create or replace function executive_visuals.clear_job_lease_token_on_transition_v1()
returns trigger language plpgsql
set search_path=pg_catalog,executive_visuals
as $clear_lease_token$
begin
  if old.status='processing' and new.status<>'processing' then
    new.lease_token:=null;
  end if;
  return new;
end;
$clear_lease_token$;
revoke all on function executive_visuals.clear_job_lease_token_on_transition_v1()
  from public,anon,authenticated,service_role;
drop trigger if exists ev_jobs_clear_lease_token_on_transition on executive_visuals.jobs;
create trigger ev_jobs_clear_lease_token_on_transition
before update of status on executive_visuals.jobs
for each row execute function executive_visuals.clear_job_lease_token_on_transition_v1();

create or replace function executive_visuals.prepare_video_generation_submission_v2(
  p_job_id uuid,p_owner_id uuid,p_worker_id text,p_lease_token uuid,
  p_provider text,p_model text,p_request_hash text
) returns setof executive_visuals.video_generation_submissions
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $prepare_video_submission_v2$
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then
    raise exception 'VIDEO_WORKER_LEASE_LOST' using errcode='42501';
  end if;
  return query select * from executive_visuals.prepare_video_generation_submission(
    p_job_id,p_owner_id,p_provider,p_model,p_request_hash
  );
end;
$prepare_video_submission_v2$;

create or replace function executive_visuals.begin_video_generation_submission_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid
) returns boolean language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $begin_video_submission_v2$
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then return false; end if;
  return executive_visuals.begin_video_generation_submission(p_job_id,p_worker_id);
end;
$begin_video_submission_v2$;

create or replace function executive_visuals.record_video_generation_submission_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_provider_task_id text,p_metadata jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $record_video_submission_v2$
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then return false; end if;
  return executive_visuals.record_video_generation_submission(p_job_id,p_worker_id,p_provider_task_id,p_metadata);
end;
$record_video_submission_v2$;

create or replace function executive_visuals.mark_video_generation_submission_unknown_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_error_code text
) returns boolean language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $mark_video_submission_unknown_v2$
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then return false; end if;
  return executive_visuals.mark_video_generation_submission_unknown(p_job_id,p_worker_id,p_error_code);
end;
$mark_video_submission_unknown_v2$;

create or replace function executive_visuals.finish_video_generation_submission_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_state text,p_metadata jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $finish_video_submission_v2$
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then return false; end if;
  return executive_visuals.finish_video_generation_submission(p_job_id,p_worker_id,p_state,p_metadata);
end;
$finish_video_submission_v2$;

create or replace function executive_visuals.finish_video_generation_job_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_status text,
  p_output jsonb default null,p_error jsonb default null,p_actual_amount numeric default null
) returns boolean language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $finish_video_job_v2$
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then return false; end if;
  return executive_visuals.finish_video_generation_job(p_job_id,p_worker_id,p_status,p_output,p_error,p_actual_amount);
end;
$finish_video_job_v2$;

create or replace function executive_visuals.defer_video_generation_job_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,
  p_delay_seconds integer default 30,p_reason_code text default 'VIDEO_PROVIDER_POLL_DEFERRED'
) returns boolean language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $defer_video_job_v2$
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then return false; end if;
  return executive_visuals.defer_video_generation_job(p_job_id,p_worker_id,p_delay_seconds,p_reason_code);
end;
$defer_video_job_v2$;

create or replace function executive_visuals.quarantine_video_generation_job_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,
  p_reason_code text default 'VIDEO_SUBMISSION_REQUIRES_RECONCILIATION'
) returns boolean language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $quarantine_video_job_v2$
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then return false; end if;
  return executive_visuals.quarantine_video_generation_job(p_job_id,p_worker_id,p_reason_code);
end;
$quarantine_video_job_v2$;

revoke all on function executive_visuals.prepare_video_generation_submission(uuid,uuid,text,text,text) from service_role;
revoke all on function executive_visuals.begin_video_generation_submission(uuid,text) from service_role;
revoke all on function executive_visuals.record_video_generation_submission(uuid,text,text,jsonb) from service_role;
revoke all on function executive_visuals.mark_video_generation_submission_unknown(uuid,text,text) from service_role;
revoke all on function executive_visuals.finish_video_generation_submission(uuid,text,text,jsonb) from service_role;
revoke all on function executive_visuals.finish_video_generation_job(uuid,text,text,jsonb,jsonb,numeric) from service_role;
revoke all on function executive_visuals.defer_video_generation_job(uuid,text,integer,text) from service_role;
revoke all on function executive_visuals.quarantine_video_generation_job(uuid,text,text) from service_role;

revoke all on function executive_visuals.prepare_video_generation_submission_v2(uuid,uuid,text,uuid,text,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.begin_video_generation_submission_v2(uuid,text,uuid) from public,anon,authenticated;
revoke all on function executive_visuals.record_video_generation_submission_v2(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.mark_video_generation_submission_unknown_v2(uuid,text,uuid,text) from public,anon,authenticated;
revoke all on function executive_visuals.finish_video_generation_submission_v2(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.finish_video_generation_job_v2(uuid,text,uuid,text,jsonb,jsonb,numeric) from public,anon,authenticated;
revoke all on function executive_visuals.defer_video_generation_job_v2(uuid,text,uuid,integer,text) from public,anon,authenticated;
revoke all on function executive_visuals.quarantine_video_generation_job_v2(uuid,text,uuid,text) from public,anon,authenticated;

grant execute on function executive_visuals.prepare_video_generation_submission_v2(uuid,uuid,text,uuid,text,text,text) to service_role;
grant execute on function executive_visuals.begin_video_generation_submission_v2(uuid,text,uuid) to service_role;
grant execute on function executive_visuals.record_video_generation_submission_v2(uuid,text,uuid,text,jsonb) to service_role;
grant execute on function executive_visuals.mark_video_generation_submission_unknown_v2(uuid,text,uuid,text) to service_role;
grant execute on function executive_visuals.finish_video_generation_submission_v2(uuid,text,uuid,text,jsonb) to service_role;
grant execute on function executive_visuals.finish_video_generation_job_v2(uuid,text,uuid,text,jsonb,jsonb,numeric) to service_role;
grant execute on function executive_visuals.defer_video_generation_job_v2(uuid,text,uuid,integer,text) to service_role;
grant execute on function executive_visuals.quarantine_video_generation_job_v2(uuid,text,uuid,text) to service_role;

comment on function executive_visuals.assert_current_video_worker_lease_v1(uuid,text,uuid) is
  'Locks and validates the current cloud-video worker attempt; only fenced wrapper RPCs are executable by service_role.';

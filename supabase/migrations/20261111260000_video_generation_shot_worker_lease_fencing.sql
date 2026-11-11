-- Fence the legacy approved-shot task ledger with the same database-issued
-- attempt token used by the shared cloud worker queue.
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
  where j.id=p_job_id
    and j.job_type in ('video.generate','video.generate.shot')
    and j.status='processing'
    and j.lease_owner=p_worker_id
    and j.lease_token=p_lease_token
    and j.lease_expires_at>pg_catalog.clock_timestamp()
  for update;
  return locked_job_id is not null;
end;
$assert_video_lease$;

create or replace function executive_visuals.reserve_video_generation_task_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,
  p_approval_id uuid,p_shot_index integer,p_owner_id uuid,p_project_id uuid,
  p_request_hash text,p_currency text,p_estimated_cost_micros bigint
) returns setof executive_visuals.video_generation_tasks
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $reserve_video_task_v2$
declare linked_job executive_visuals.jobs;
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then
    raise exception 'VIDEO_WORKER_LEASE_LOST' using errcode='42501';
  end if;
  select * into linked_job from executive_visuals.jobs where id=p_job_id;
  if linked_job.job_type<>'video.generate.shot'
     or linked_job.owner_id is distinct from p_owner_id
     or linked_job.project_id is distinct from p_project_id
     or linked_job.input->>'approvalId' is distinct from p_approval_id::text
     or nullif(linked_job.input->>'shotIndex','')::integer is distinct from p_shot_index then
    raise exception 'VIDEO_TASK_JOB_SCOPE_MISMATCH' using errcode='42501';
  end if;
  return query select * from executive_visuals.reserve_video_generation_task(
    p_approval_id,p_shot_index,p_owner_id,p_project_id,p_request_hash,p_currency,p_estimated_cost_micros
  );
end;
$reserve_video_task_v2$;

create or replace function executive_visuals.transition_video_generation_task_v2(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_task_id uuid,
  p_from_states text[],p_to_state text,
  p_provider_task_id text default null,p_provider text default null,p_model text default null,
  p_estimated_cost_credits numeric default null,p_provider_status text default null,
  p_error jsonb default null,p_output_asset_id uuid default null
) returns setof executive_visuals.video_generation_tasks
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $transition_video_task_v2$
declare linked_job executive_visuals.jobs; linked_task_id uuid;
begin
  if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then
    raise exception 'VIDEO_WORKER_LEASE_LOST' using errcode='42501';
  end if;
  select * into linked_job from executive_visuals.jobs where id=p_job_id;
  select t.id into linked_task_id
  from executive_visuals.video_generation_tasks t
  where t.id=p_task_id
    and t.owner_id=linked_job.owner_id
    and t.project_id=linked_job.project_id
    and t.approval_id::text=linked_job.input->>'approvalId'
    and t.shot_index=nullif(linked_job.input->>'shotIndex','')::integer
  for update;
  if linked_task_id is null then
    raise exception 'VIDEO_TASK_JOB_SCOPE_MISMATCH' using errcode='42501';
  end if;
  return query select * from executive_visuals.transition_video_generation_task(
    p_task_id,p_from_states,p_to_state,p_provider_task_id,p_provider,p_model,
    p_estimated_cost_credits,p_provider_status,p_error,p_output_asset_id
  );
end;
$transition_video_task_v2$;

revoke all on function executive_visuals.reserve_video_generation_task(uuid,integer,uuid,uuid,text,text,bigint) from service_role;
revoke all on function executive_visuals.transition_video_generation_task(uuid,text[],text,text,text,text,numeric,text,jsonb,uuid) from service_role;
revoke all on function executive_visuals.reserve_video_generation_task_v2(uuid,text,uuid,uuid,integer,uuid,uuid,text,text,bigint) from public,anon,authenticated;
revoke all on function executive_visuals.transition_video_generation_task_v2(uuid,text,uuid,uuid,text[],text,text,text,text,numeric,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function executive_visuals.reserve_video_generation_task_v2(uuid,text,uuid,uuid,integer,uuid,uuid,text,text,bigint) to service_role;
grant execute on function executive_visuals.transition_video_generation_task_v2(uuid,text,uuid,uuid,text[],text,text,text,text,numeric,text,jsonb,uuid) to service_role;

comment on function executive_visuals.transition_video_generation_task_v2(uuid,text,uuid,uuid,text[],text,text,text,text,numeric,text,jsonb,uuid) is
  'Fenced state transition for an approved video shot task; verifies and locks its exact leased job and task lineage.';

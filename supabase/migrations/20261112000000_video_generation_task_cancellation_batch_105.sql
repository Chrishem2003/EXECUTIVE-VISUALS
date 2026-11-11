-- Batch 105: durable provider cancellation and restart reconciliation.
-- This migration is additive; it does not execute or cancel any existing provider task.
alter table executive_visuals.video_generation_tasks
  drop constraint if exists video_generation_tasks_state_check;

alter table executive_visuals.video_generation_tasks
  add constraint video_generation_tasks_state_check
  check (state in ('reserved','submitting','submission_unknown','submitted','processing','cancel_requested','succeeded','failed','cancelled'));

create or replace function executive_visuals.transition_video_generation_task(
  p_task_id uuid,p_from_states text[],p_to_state text,
  p_provider_task_id text default null,p_provider text default null,p_model text default null,
  p_estimated_cost_credits numeric default null,p_provider_status text default null,
  p_error jsonb default null,p_output_asset_id uuid default null
)
returns setof executive_visuals.video_generation_tasks
language plpgsql security definer
set search_path = pg_catalog, executive_visuals
as $$
declare changed executive_visuals.video_generation_tasks;
begin
  if p_to_state not in ('submitting','submission_unknown','submitted','processing','cancel_requested','succeeded','failed','cancelled')
     or p_from_states is null or cardinality(p_from_states)=0
     or exists(select 1 from unnest(p_from_states) s where s not in ('reserved','submitting','submission_unknown','submitted','processing','cancel_requested','succeeded','failed','cancelled')) then
    raise exception 'VIDEO_TASK_TRANSITION_INVALID';
  end if;
  if p_to_state='submitted' and (p_provider_task_id is null or p_provider_task_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
    raise exception 'VIDEO_PROVIDER_TASK_ID_INVALID';
  end if;
  if p_to_state='succeeded' and p_output_asset_id is null then
    raise exception 'VIDEO_TASK_OUTPUT_ASSET_REQUIRED';
  end if;
  if p_to_state='cancel_requested' and p_provider_status is null then
    raise exception 'VIDEO_TASK_CANCEL_STATUS_REQUIRED';
  end if;
  update executive_visuals.video_generation_tasks
    set state=p_to_state,
        provider_task_id=coalesce(p_provider_task_id,provider_task_id),
        provider=coalesce(p_provider,provider),
        model=coalesce(p_model,model),
        estimated_cost_credits=coalesce(p_estimated_cost_credits,estimated_cost_credits),
        provider_status=coalesce(p_provider_status,provider_status),
        error=case when p_to_state='failed' then coalesce(p_error,'{}'::jsonb) else null end,
        output_asset_id=coalesce(p_output_asset_id,output_asset_id),
        submitted_at=case when p_to_state='submitted' then coalesce(submitted_at,clock_timestamp()) else submitted_at end,
        completed_at=case when p_to_state in ('succeeded','failed','cancelled') then clock_timestamp() else completed_at end,
        updated_at=clock_timestamp()
    where id=p_task_id and state=any(p_from_states)
    returning * into changed;
  if not found then
    select * into changed from executive_visuals.video_generation_tasks where id=p_task_id;
    if not found then raise exception 'VIDEO_TASK_NOT_FOUND'; end if;
    raise exception 'VIDEO_TASK_STATE_CONFLICT';
  end if;
  if p_to_state='succeeded' and not exists(
    select 1 from executive_visuals.video_generation_tasks t
    where t.approval_id=changed.approval_id and t.state<>'succeeded'
  ) then
    update executive_visuals.video_generation_approvals
      set status='succeeded',updated_at=clock_timestamp()
      where id=changed.approval_id;
  elsif p_to_state='failed' then
    update executive_visuals.video_generation_approvals
      set status='failed',updated_at=clock_timestamp()
      where id=changed.approval_id;
  elsif p_to_state='cancelled' and not exists(
    select 1 from executive_visuals.video_generation_tasks t
    where t.approval_id=changed.approval_id
      and t.state not in ('succeeded','failed','cancelled')
  ) then
    update executive_visuals.video_generation_approvals
      set status='withdrawn',updated_at=clock_timestamp()
      where id=changed.approval_id;
  end if;
  return next changed;
end;
$$;

revoke all on function executive_visuals.transition_video_generation_task(uuid,text[],text,text,text,text,numeric,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function executive_visuals.transition_video_generation_task(uuid,text[],text,text,text,text,numeric,text,jsonb,uuid) to service_role;

-- Authenticated users cancel only their own cloud video jobs through the server API.
create or replace function executive_visuals.cancel_video_generation_job(
  p_job_id uuid,p_owner_id uuid
)
returns setof executive_visuals.jobs
language plpgsql security definer
set search_path = pg_catalog, executive_visuals
as $
declare existing executive_visuals.jobs; changed executive_visuals.jobs; approval_key uuid; shot_key integer;
begin
  if p_job_id is null or p_owner_id is null then
    raise exception 'VIDEO_JOB_CANCEL_INVALID';
  end if;
  select * into existing
    from executive_visuals.jobs
    where id=p_job_id and owner_id=p_owner_id and job_type='video.generate.shot'
    for update;
  if not found then return; end if;

  if existing.status in ('queued','processing') then
    update executive_visuals.jobs
      set status='cancelled',
          error=jsonb_build_object('code','JOB_CANCELLED','message','Cancellation was requested by the job owner.'),
          completed_at=clock_timestamp(),
          updated_at=clock_timestamp(),
          lease_owner=null,
          lease_expires_at=null,
          lease_heartbeat_at=null
      where id=existing.id and owner_id=p_owner_id and status in ('queued','processing')
      returning * into changed;
    if found then
      existing:=changed;
      insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
        values(existing.id,p_owner_id,'job.cancelled',jsonb_build_object('source','owner_request'));
    end if;
  end if;

  begin
    approval_key:=nullif(existing.input->>'approvalId','')::uuid;
    shot_key:=nullif(existing.input->>'shotIndex','')::integer;
  exception when invalid_text_representation then
    approval_key:=null; shot_key:=null;
  end;
  if existing.status='cancelled' and approval_key is not null then
    -- Queue cancellation must also wake the durable provider-task reconciler.
    -- Keep ambiguous submissions pending; only the worker can confirm their outcome.
    update executive_visuals.video_generation_tasks t
      set state='cancel_requested',
          provider_status='CANCEL_REQUESTED',
          updated_at=clock_timestamp()
      where t.approval_id=approval_key and t.owner_id=p_owner_id and t.shot_index=shot_key
        and t.state in ('reserved','submitting','submission_unknown','submitted','processing');

    update executive_visuals.video_generation_approvals a
      set status='withdrawn',updated_at=clock_timestamp()
      where a.id=approval_key and a.owner_id=p_owner_id
        and a.status in ('approved_pending_submission','processing')
        and not exists(
          select 1 from executive_visuals.jobs j
          where j.owner_id=p_owner_id and j.job_type='video.generate.shot'
            and j.input->>'approvalId'=approval_key::text
            and j.status not in ('succeeded','partial','failed','cancelled','blocked','expired')
        )
        and not exists(
          select 1 from executive_visuals.video_generation_tasks t
          where t.approval_id=approval_key and t.state not in ('succeeded','failed','cancelled')
        );
  end if;
  return next existing;
end;
$;

revoke all on function executive_visuals.cancel_video_generation_job(uuid,uuid) from public,anon,authenticated;
grant execute on function executive_visuals.cancel_video_generation_job(uuid,uuid) to service_role;

comment on column executive_visuals.video_generation_tasks.state is
  'Durable one-shot state; cancel_requested remains non-terminal until provider termination is confirmed, cancelled is terminal.';

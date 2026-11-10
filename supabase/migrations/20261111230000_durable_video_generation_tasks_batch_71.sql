-- Durable, budget-gated cloud video generation.
-- Additive only. Apply to an isolated Executive Visuals Supabase project/branch
-- after reviewing the migration and running the database policy tests.
create table if not exists executive_visuals.video_generation_approvals (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 180),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  snapshot_json jsonb not null check (
    jsonb_typeof(snapshot_json)='object'
    and jsonb_typeof(snapshot_json->'shots')='array'
    and jsonb_array_length(snapshot_json->'shots') between 1 and 100
  ),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  quoted_amount_micros bigint not null check (quoted_amount_micros >= 0),
  budget_ceiling_micros bigint not null check (budget_ceiling_micros >= quoted_amount_micros),
  status text not null default 'approved_pending_submission'
    check (status in ('approved_pending_submission','processing','succeeded','failed','withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,idempotency_key),
  unique(id,owner_id,project_id)
);

create table if not exists executive_visuals.video_generation_tasks (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null,
  owner_id uuid not null,
  project_id uuid not null,
  shot_index integer not null check (shot_index between 0 and 99),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  estimated_cost_micros bigint not null check (estimated_cost_micros >= 0),
  provider text not null default 'runway' check (provider in ('runway')),
  model text,
  state text not null default 'reserved'
    check (state in ('reserved','submitting','submission_unknown','submitted','processing','succeeded','failed')),
  provider_task_id text,
  estimated_cost_credits numeric(18,6),
  provider_status text,
  output_asset_id uuid references executive_visuals.assets(id) on delete set null,
  error jsonb check (error is null or jsonb_typeof(error)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  constraint ev_video_task_approval_scope_fk
    foreign key(approval_id,owner_id,project_id)
    references executive_visuals.video_generation_approvals(id,owner_id,project_id) on delete cascade,
  constraint ev_video_task_one_shot unique(approval_id,shot_index)
);

create unique index if not exists ev_video_task_provider_identity
  on executive_visuals.video_generation_tasks(provider,provider_task_id)
  where provider_task_id is not null;
create index if not exists ev_video_task_owner_recent
  on executive_visuals.video_generation_tasks(owner_id,created_at desc);
create index if not exists ev_video_task_approval_state
  on executive_visuals.video_generation_tasks(approval_id,state,shot_index);

alter table executive_visuals.video_generation_approvals enable row level security;
alter table executive_visuals.video_generation_tasks enable row level security;
revoke all on executive_visuals.video_generation_approvals from public,anon,authenticated;
revoke all on executive_visuals.video_generation_tasks from public,anon,authenticated;
grant select,insert,update on executive_visuals.video_generation_approvals to service_role;
grant select,insert,update on executive_visuals.video_generation_tasks to service_role;

create or replace function executive_visuals.register_video_generation_approval(
  p_id uuid,p_owner_id uuid,p_project_id uuid,p_idempotency_key text,
  p_request_hash text,p_snapshot_json jsonb,p_currency text,
  p_quoted_amount_micros bigint,p_budget_ceiling_micros bigint
)
returns setof executive_visuals.video_generation_approvals
language plpgsql security definer
set search_path = pg_catalog, executive_visuals
as $$
declare saved executive_visuals.video_generation_approvals;
begin
  if p_id is null or p_owner_id is null or p_project_id is null
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 180
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_snapshot_json is null or jsonb_typeof(p_snapshot_json)<>'object'
     or jsonb_typeof(p_snapshot_json->'shots')<>'array'
     or jsonb_array_length(p_snapshot_json->'shots') not between 1 and 100
     or p_currency is null or p_currency !~ '^[A-Z]{3}$'
     or p_quoted_amount_micros is null or p_quoted_amount_micros<0
     or p_budget_ceiling_micros is null or p_budget_ceiling_micros<p_quoted_amount_micros then
    raise exception 'VIDEO_APPROVAL_INVALID';
  end if;
  if not exists(select 1 from executive_visuals.projects p
    where p.id=p_project_id and p.owner_id=p_owner_id and p.archived_at is null) then
    raise exception 'VIDEO_APPROVAL_PROJECT_SCOPE_INVALID';
  end if;
  insert into executive_visuals.video_generation_approvals
    (id,owner_id,project_id,idempotency_key,request_hash,snapshot_json,currency,quoted_amount_micros,budget_ceiling_micros)
  values(p_id,p_owner_id,p_project_id,p_idempotency_key,p_request_hash,p_snapshot_json,p_currency,p_quoted_amount_micros,p_budget_ceiling_micros)
  on conflict(owner_id,idempotency_key) do nothing;
  select * into saved from executive_visuals.video_generation_approvals
    where owner_id=p_owner_id and idempotency_key=p_idempotency_key for update;
  if saved.request_hash<>p_request_hash or saved.project_id<>p_project_id
     or saved.currency<>p_currency or saved.quoted_amount_micros<>p_quoted_amount_micros
     or saved.budget_ceiling_micros<>p_budget_ceiling_micros then
    raise exception 'VIDEO_APPROVAL_IDEMPOTENCY_CONFLICT';
  end if;
  return next saved;
end;
$$;

create or replace function executive_visuals.enqueue_approved_video_generation(
  p_approval_id uuid,p_owner_id uuid
)
returns table(job_id uuid,shot_index integer,job_status text)
language plpgsql security definer
set search_path = pg_catalog, executive_visuals
as $$
declare approval executive_visuals.video_generation_approvals;
        shot_count integer;
        idx integer;
        created_job executive_visuals.jobs;
begin
  select * into approval from executive_visuals.video_generation_approvals
   where id=p_approval_id and owner_id=p_owner_id for update;
  if not found then raise exception 'VIDEO_APPROVAL_NOT_FOUND'; end if;
  if approval.status not in ('approved_pending_submission','processing') then
    raise exception 'VIDEO_APPROVAL_NOT_EXECUTABLE';
  end if;
  shot_count:=jsonb_array_length(approval.snapshot_json->'shots');
  for idx in 0..shot_count-1 loop
    insert into executive_visuals.jobs(owner_id,project_id,job_type,status,input,idempotency_key,max_attempts,estimated_cost)
    values(approval.owner_id,approval.project_id,'video.generate.shot','queued',
      jsonb_build_object('approvalId',approval.id,'shotIndex',idx),
      'video-generation:'||approval.id::text||':'||idx,3,
      jsonb_build_object('currency',approval.currency,
        'amountMicros',(approval.snapshot_json->'shots'->idx->>'estimatedCostMicros')::bigint))
    on conflict(owner_id,idempotency_key) do nothing;
    select * into created_job from executive_visuals.jobs
      where owner_id=approval.owner_id
        and idempotency_key='video-generation:'||approval.id::text||':'||idx;
    if created_job.id is null or created_job.project_id<>approval.project_id
       or created_job.job_type<>'video.generate.shot'
       or created_job.input->>'approvalId'<>approval.id::text
       or (created_job.input->>'shotIndex')::integer<>idx then
      raise exception 'VIDEO_JOB_IDEMPOTENCY_CONFLICT';
    end if;
    job_id:=created_job.id;shot_index:=idx;job_status:=created_job.status;
    return next;
  end loop;
  update executive_visuals.video_generation_approvals
    set status='processing',updated_at=clock_timestamp()
    where id=approval.id and status='approved_pending_submission';
end;
$$;

create or replace function executive_visuals.reserve_video_generation_task(
  p_approval_id uuid,p_shot_index integer,p_owner_id uuid,p_project_id uuid,
  p_request_hash text,p_currency text,p_estimated_cost_micros bigint
)
returns setof executive_visuals.video_generation_tasks
language plpgsql security definer
set search_path = pg_catalog, executive_visuals
as $$
declare approval executive_visuals.video_generation_approvals;
        shot jsonb;
        existing_task executive_visuals.video_generation_tasks;
        reserved_total bigint;
begin
  if p_shot_index is null or p_shot_index not between 0 and 99
     or p_estimated_cost_micros is null or p_estimated_cost_micros<0 then
    raise exception 'VIDEO_TASK_INVALID_RESERVATION';
  end if;
  select * into approval from executive_visuals.video_generation_approvals
    where id=p_approval_id and owner_id=p_owner_id and project_id=p_project_id
    for update;
  if not found or approval.status not in ('approved_pending_submission','processing') then
    raise exception 'VIDEO_APPROVAL_NOT_EXECUTABLE';
  end if;
  if approval.request_hash<>p_request_hash or approval.currency<>p_currency then
    raise exception 'VIDEO_APPROVAL_SNAPSHOT_MISMATCH';
  end if;
  if p_shot_index>=jsonb_array_length(approval.snapshot_json->'shots') then
    raise exception 'VIDEO_APPROVAL_SHOT_NOT_FOUND';
  end if;
  shot:=approval.snapshot_json->'shots'->p_shot_index;
  if coalesce(shot->>'estimatedCostMicros','') !~ '^[0-9]+$'
     or (shot->>'estimatedCostMicros')::bigint<>p_estimated_cost_micros then
    raise exception 'VIDEO_APPROVAL_SHOT_PRICE_MISMATCH';
  end if;
  select * into existing_task from executive_visuals.video_generation_tasks
    where approval_id=p_approval_id and shot_index=p_shot_index for update;
  if found then
    if existing_task.request_hash<>p_request_hash
       or existing_task.estimated_cost_micros<>p_estimated_cost_micros
       or existing_task.owner_id<>p_owner_id or existing_task.project_id<>p_project_id then
      raise exception 'VIDEO_TASK_IDEMPOTENCY_CONFLICT';
    end if;
    return next existing_task;return;
  end if;
  select coalesce(sum(estimated_cost_micros),0) into reserved_total
    from executive_visuals.video_generation_tasks where approval_id=p_approval_id;
  if reserved_total+p_estimated_cost_micros>approval.budget_ceiling_micros then
    raise exception 'VIDEO_APPROVAL_BUDGET_EXCEEDED';
  end if;
  insert into executive_visuals.video_generation_tasks
    (approval_id,owner_id,project_id,shot_index,request_hash,currency,estimated_cost_micros,model)
  values(p_approval_id,p_owner_id,p_project_id,p_shot_index,p_request_hash,p_currency,p_estimated_cost_micros,shot->>'model')
  returning * into existing_task;
  return next existing_task;
end;
$$;

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
  if p_to_state not in ('submitting','submission_unknown','submitted','processing','succeeded','failed')
     or p_from_states is null or cardinality(p_from_states)=0
     or exists(select 1 from unnest(p_from_states) s where s not in ('reserved','submitting','submission_unknown','submitted','processing','succeeded','failed')) then
    raise exception 'VIDEO_TASK_TRANSITION_INVALID';
  end if;
  if p_to_state='submitted' and (p_provider_task_id is null or p_provider_task_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
    raise exception 'VIDEO_PROVIDER_TASK_ID_INVALID';
  end if;
  if p_to_state='succeeded' and p_output_asset_id is null then
    raise exception 'VIDEO_TASK_OUTPUT_ASSET_REQUIRED';
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
        completed_at=case when p_to_state in ('succeeded','failed') then clock_timestamp() else completed_at end,
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
  end if;
  return next changed;
end;
$$;

revoke all on function executive_visuals.register_video_generation_approval(uuid,uuid,uuid,text,text,jsonb,text,bigint,bigint) from public,anon,authenticated;
revoke all on function executive_visuals.enqueue_approved_video_generation(uuid,uuid) from public,anon,authenticated;
revoke all on function executive_visuals.reserve_video_generation_task(uuid,integer,uuid,uuid,text,text,bigint) from public,anon,authenticated;
revoke all on function executive_visuals.transition_video_generation_task(uuid,text[],text,text,text,text,numeric,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function executive_visuals.register_video_generation_approval(uuid,uuid,uuid,text,text,jsonb,text,bigint,bigint) to service_role;
grant execute on function executive_visuals.enqueue_approved_video_generation(uuid,uuid) to service_role;
grant execute on function executive_visuals.reserve_video_generation_task(uuid,integer,uuid,uuid,text,text,bigint) to service_role;
grant execute on function executive_visuals.transition_video_generation_task(uuid,text[],text,text,text,text,numeric,text,jsonb,uuid) to service_role;

comment on table executive_visuals.video_generation_approvals is
  'Server-only immutable approved quote and shot snapshot for cloud video generation.';
comment on table executive_visuals.video_generation_tasks is
  'Server-only one-row-per-approved-shot task ledger. Provider task identity survives worker restarts and prevents duplicate POSTs.';

-- Batch 32: persistent financial close execution and multi-level approvals.
grant usage on schema executive_visuals to service_role;

alter table executive_visuals.financial_audit_events
 drop constraint if exists financial_audit_events_event_type_check;
alter table executive_visuals.financial_audit_events
 add constraint financial_audit_events_event_type_check check(event_type in(
  'close_period.created','close_period.submitted','close_period.locked','close_period.reopened',
  'close_task.assigned','close_task.completed','close_task.waived',
  'close_approval.assigned','close_approval.recorded',
  'reconciliation.reviewed','evidence.attached','evidence.retention_changed'
 ));

create table if not exists executive_visuals.financial_close_periods(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 period_start date not null,
 period_end date not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 status text not null default 'open' check(status in('open','in_review','locked')),
 created_by uuid not null references auth.users(id) on delete restrict,
 locked_by uuid references auth.users(id) on delete restrict,
 locked_at timestamptz,
 reopened_at timestamptz,
 reopen_reason text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(period_end>=period_start),
 check((status='locked')=(locked_at is not null and locked_by is not null)),
 unique(owner_id,period_start,currency)
);
create index if not exists financial_close_periods_owner_status_idx
 on executive_visuals.financial_close_periods(owner_id,status,period_start desc);

create table if not exists executive_visuals.financial_close_tasks(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 period_id uuid not null references executive_visuals.financial_close_periods(id) on delete restrict,
 task_key text not null check(task_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
 title text not null check(length(title) between 2 and 180),
 description text,
 required boolean not null default true,
 assignee_id uuid not null references auth.users(id) on delete restrict,
 status text not null default 'pending' check(status in('pending','completed','waived')),
 due_at timestamptz,
 evidence_refs text[] not null default '{}',
 completed_by uuid references auth.users(id) on delete restrict,
 completed_at timestamptz,
 waiver_reason text,
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(period_id,task_key),
 check((status='completed')=(completed_at is not null and completed_by is not null)),
 check((status='waived')=(waiver_reason is not null))
);
create index if not exists financial_close_tasks_owner_period_idx
 on executive_visuals.financial_close_tasks(owner_id,period_id,status);

create table if not exists executive_visuals.financial_close_approvals(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 period_id uuid not null references executive_visuals.financial_close_periods(id) on delete restrict,
 stage_key text not null check(stage_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
 reviewer_id uuid not null references auth.users(id) on delete restrict,
 status text not null default 'pending' check(status in('pending','approved','rejected')),
 decision_note text,
 decided_at timestamptz,
 assigned_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(period_id,stage_key),
 check((status='pending')=(decided_at is null))
);
create index if not exists financial_close_approvals_owner_period_idx
 on executive_visuals.financial_close_approvals(owner_id,period_id,status);

alter table executive_visuals.financial_close_periods enable row level security;
alter table executive_visuals.financial_close_tasks enable row level security;
alter table executive_visuals.financial_close_approvals enable row level security;
revoke all on executive_visuals.financial_close_periods,executive_visuals.financial_close_tasks,executive_visuals.financial_close_approvals from public,anon,authenticated,service_role;

create or replace function executive_visuals.execute_financial_close_command(
 p_owner_id uuid,p_actor_id uuid,p_command text,p_payload jsonb,
 p_event_envelope jsonb,p_canonical_event text,p_event_hash text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,public
as $$
declare
 v_audit jsonb;
 v_period executive_visuals.financial_close_periods%rowtype;
 v_task executive_visuals.financial_close_tasks%rowtype;
 v_approval executive_visuals.financial_close_approvals%rowtype;
 v_period_id uuid;
 v_task_id uuid;
 v_reviewer uuid;
 v_stage text;
 v_row jsonb;
 v_count integer;
 v_distinct integer;
 v_decision text;
 v_reason text;
 v_expected_event text;
begin
 if p_owner_id is null or p_actor_id is null or jsonb_typeof(p_payload)<>'object' then
  raise exception using errcode='22023',message='financial_close_command_invalid';
 end if;
 v_expected_event:=case p_command
  when 'create_period' then 'close_period.created'
  when 'assign_task' then 'close_task.assigned'
  when 'complete_task' then 'close_task.completed'
  when 'waive_task' then 'close_task.waived'
  when 'submit_for_approval' then 'close_period.submitted'
  when 'record_approval' then 'close_approval.recorded'
  when 'reassign_approval' then 'close_approval.assigned'
  when 'lock_period' then 'close_period.locked'
  when 'reopen_period' then 'close_period.reopened'
  else null end;
 if v_expected_event is null or p_event_envelope->>'eventType' is distinct from v_expected_event
  or p_event_envelope->>'ownerId' is distinct from p_owner_id::text
  or p_event_envelope->>'actorId' is distinct from p_actor_id::text
  or p_event_envelope->'payload'<>p_payload then
  raise exception using errcode='22023',message='financial_close_command_event_mismatch';
 end if;

 -- The audit append and the domain mutation share this transaction. Any later
 -- validation failure rolls back the audit row as well as the close-state change.
 v_audit:=executive_visuals.append_financial_audit_event(
  p_owner_id,p_actor_id,p_event_envelope->>'idempotencyKey',
  p_event_envelope,p_canonical_event,p_event_hash
 );
 if coalesce((v_audit->>'duplicate')::boolean,false) then
  return jsonb_build_object('duplicate',true,'audit',v_audit);
 end if;

 if p_command='create_period' then
  if (p_payload->>'periodStart') is null or (p_payload->>'periodEnd') is null
   or p_payload->>'currency' is null or (p_payload->>'currency') !~ '^[A-Z]{3}$'
   or jsonb_typeof(p_payload->'approvalStages')<>'array'
   or jsonb_array_length(p_payload->'approvalStages')<2 then
   raise exception using errcode='22023',message='financial_close_period_requirements_invalid';
  end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'approvalStages') s
   where nullif(s->>'stageKey','') is null or nullif(s->>'reviewerId','') is null) then
   raise exception using errcode='22023',message='financial_close_approval_stages_invalid';
  end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'approvalStages') s
   where (s->>'reviewerId')::uuid=p_actor_id) then
   raise exception using errcode='22023',message='financial_close_self_approval_forbidden';
  end if;
  select count(*),count(distinct (s->>'reviewerId')::uuid) into v_count,v_distinct
   from jsonb_array_elements(p_payload->'approvalStages') s;
  if v_count<2 or v_distinct<2 or v_count<>jsonb_array_length(p_payload->'approvalStages') then
   raise exception using errcode='22023',message='financial_close_approvers_must_be_distinct';
  end if;
  insert into executive_visuals.financial_close_periods(owner_id,period_start,period_end,currency,created_by)
  values(p_owner_id,(p_payload->>'periodStart')::date,(p_payload->>'periodEnd')::date,p_payload->>'currency',p_actor_id)
  returning * into v_period;
  for v_row in select value from jsonb_array_elements(p_payload->'approvalStages') loop
   insert into executive_visuals.financial_close_approvals(owner_id,period_id,stage_key,reviewer_id,assigned_by)
   values(p_owner_id,v_period.id,v_row->>'stageKey',(v_row->>'reviewerId')::uuid,p_actor_id);
  end loop;
  return jsonb_build_object('duplicate',false,'period',to_jsonb(v_period),'audit',v_audit);
 end if;

 v_period_id:=nullif(p_payload->>'periodId','')::uuid;
 if v_period_id is null then raise exception using errcode='22023',message='financial_close_period_id_required'; end if;
 select * into v_period from executive_visuals.financial_close_periods
  where id=v_period_id and owner_id=p_owner_id for update;
 if not found then raise exception using errcode='P0002',message='financial_close_period_not_found'; end if;

 if p_command='assign_task' then
  if v_period.status<>'open' or nullif(p_payload->>'assigneeId','') is null
   or nullif(p_payload->>'taskKey','') is null or nullif(p_payload->>'title','') is null then
   raise exception using errcode='22023',message='financial_close_task_assignment_invalid';
  end if;
  insert into executive_visuals.financial_close_tasks(owner_id,period_id,task_key,title,description,required,assignee_id,due_at,created_by)
  values(p_owner_id,v_period_id,p_payload->>'taskKey',p_payload->>'title',p_payload->>'description',
   coalesce((p_payload->>'required')::boolean,true),(p_payload->>'assigneeId')::uuid,
   nullif(p_payload->>'dueAt','')::timestamptz,p_actor_id)
  returning * into v_task;
  return jsonb_build_object('duplicate',false,'task',to_jsonb(v_task),'audit',v_audit);
 elsif p_command in('complete_task','waive_task') then
  v_task_id:=nullif(p_payload->>'taskId','')::uuid;
  select * into v_task from executive_visuals.financial_close_tasks
   where id=v_task_id and owner_id=p_owner_id and period_id=v_period_id for update;
  if not found or v_period.status<>'open' or v_task.status<>'pending' then
   raise exception using errcode='22023',message='financial_close_task_transition_invalid';
  end if;
  if p_command='complete_task' then
   if jsonb_typeof(p_payload->'evidenceRefs')<>'array' or jsonb_array_length(p_payload->'evidenceRefs')<1 then
    raise exception using errcode='22023',message='financial_close_task_evidence_required';
   end if;
   update executive_visuals.financial_close_tasks set status='completed',
    evidence_refs=array(select jsonb_array_elements_text(p_payload->'evidenceRefs')),
    completed_by=p_actor_id,completed_at=now(),updated_at=now() where id=v_task_id returning * into v_task;
  else
   v_reason:=nullif(btrim(p_payload->>'reason'),'');
   if v_reason is null or length(v_reason)<8 then raise exception using errcode='22023',message='financial_close_waiver_reason_required'; end if;
   update executive_visuals.financial_close_tasks set status='waived',waiver_reason=v_reason,updated_at=now()
    where id=v_task_id returning * into v_task;
  end if;
  return jsonb_build_object('duplicate',false,'task',to_jsonb(v_task),'audit',v_audit);
 elsif p_command='submit_for_approval' then
  if v_period.status<>'open' then raise exception using errcode='22023',message='financial_close_submission_state_invalid'; end if;
  if exists(select 1 from executive_visuals.financial_close_tasks
   where period_id=v_period_id and owner_id=p_owner_id and required and status not in('completed','waived')) then
   raise exception using errcode='22023',message='financial_close_required_tasks_incomplete';
  end if;
  select count(*),count(distinct reviewer_id) into v_count,v_distinct
   from executive_visuals.financial_close_approvals where period_id=v_period_id and owner_id=p_owner_id;
  if v_count<2 or v_distinct<2 then raise exception using errcode='22023',message='financial_close_two_approvers_required'; end if;
  update executive_visuals.financial_close_periods set status='in_review',updated_at=now()
   where id=v_period_id returning * into v_period;
  return jsonb_build_object('duplicate',false,'period',to_jsonb(v_period),'audit',v_audit);
 elsif p_command='reassign_approval' then
  if v_period.status<>'open' or nullif(p_payload->>'stageKey','') is null
   or nullif(p_payload->>'reviewerId','') is null then
   raise exception using errcode='22023',message='financial_close_reassignment_invalid';
  end if;
  v_stage:=p_payload->>'stageKey';
  v_reviewer:=(p_payload->>'reviewerId')::uuid;
  select * into v_approval from executive_visuals.financial_close_approvals
   where owner_id=p_owner_id and period_id=v_period_id and stage_key=v_stage for update;
  if not found or v_approval.status<>'pending' or v_reviewer=v_period.created_by
   or exists(select 1 from executive_visuals.financial_close_approvals
    where period_id=v_period_id and owner_id=p_owner_id and stage_key<>v_stage and reviewer_id=v_reviewer) then
   raise exception using errcode='22023',message='financial_close_reassignment_conflict';
  end if;
  update executive_visuals.financial_close_approvals set reviewer_id=v_reviewer,assigned_by=p_actor_id
   where id=v_approval.id returning * into v_approval;
  return jsonb_build_object('duplicate',false,'approval',to_jsonb(v_approval),'audit',v_audit);
 elsif p_command='record_approval' then
  if v_period.status<>'in_review' then raise exception using errcode='22023',message='financial_close_approval_state_invalid'; end if;
  v_stage:=p_payload->>'stageKey';
  v_decision:=p_payload->>'decision';
  if v_decision is null or v_decision not in('approved','rejected') then raise exception using errcode='22023',message='financial_close_decision_invalid'; end if;
  select * into v_approval from executive_visuals.financial_close_approvals
   where owner_id=p_owner_id and period_id=v_period_id and stage_key=v_stage for update;
  if not found or v_approval.reviewer_id<>p_actor_id or v_approval.status<>'pending'
   or p_actor_id=v_period.created_by then
   raise exception using errcode='42501',message='financial_close_reviewer_not_authorized';
  end if;
  update executive_visuals.financial_close_approvals set status=v_decision,
   decision_note=nullif(btrim(p_payload->>'note'),''),decided_at=now()
   where id=v_approval.id returning * into v_approval;
  return jsonb_build_object('duplicate',false,'approval',to_jsonb(v_approval),'audit',v_audit);
 elsif p_command='lock_period' then
  if v_period.status<>'in_review' then raise exception using errcode='22023',message='financial_close_lock_state_invalid'; end if;
  if exists(select 1 from executive_visuals.financial_close_tasks
   where period_id=v_period_id and owner_id=p_owner_id and required and status not in('completed','waived')) then
   raise exception using errcode='22023',message='financial_close_required_tasks_incomplete';
  end if;
  if exists(select 1 from executive_visuals.financial_close_approvals
   where period_id=v_period_id and owner_id=p_owner_id and status<>'approved')
   or (select count(distinct reviewer_id) from executive_visuals.financial_close_approvals
    where period_id=v_period_id and owner_id=p_owner_id)<2 then
   raise exception using errcode='22023',message='financial_close_approvals_incomplete';
  end if;
  update executive_visuals.financial_close_periods set status='locked',locked_by=p_actor_id,locked_at=now(),updated_at=now()
   where id=v_period_id returning * into v_period;
  return jsonb_build_object('duplicate',false,'period',to_jsonb(v_period),'audit',v_audit);
 elsif p_command='reopen_period' then
  v_reason:=nullif(btrim(p_payload->>'reason'),'');
  if v_period.status not in('locked','in_review') or v_reason is null or length(v_reason)<8 then
   raise exception using errcode='22023',message='financial_close_reopen_reason_required';
  end if;
  update executive_visuals.financial_close_periods set status='open',locked_by=null,locked_at=null,
   reopened_at=now(),reopen_reason=v_reason,updated_at=now() where id=v_period_id returning * into v_period;
  update executive_visuals.financial_close_approvals set status='pending',decision_note=null,decided_at=null
   where period_id=v_period_id and owner_id=p_owner_id;
  return jsonb_build_object('duplicate',false,'period',to_jsonb(v_period),'audit',v_audit);
 end if;
 raise exception using errcode='22023',message='financial_close_command_unhandled';
end $$;
revoke all on function executive_visuals.execute_financial_close_command(uuid,uuid,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.execute_financial_close_command(uuid,uuid,text,jsonb,jsonb,text,text) to service_role;

create or replace function executive_visuals.get_financial_close_overview(p_owner_id uuid)
returns jsonb language sql stable security definer
set search_path=pg_catalog,executive_visuals
as $$
 select jsonb_build_object(
  'periods',coalesce((select jsonb_agg(to_jsonb(p) order by p.period_start desc)
   from executive_visuals.financial_close_periods p where p.owner_id=p_owner_id),'[]'::jsonb),
  'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at)
   from executive_visuals.financial_close_tasks t where t.owner_id=p_owner_id),'[]'::jsonb),
  'approvals',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at)
   from executive_visuals.financial_close_approvals a where a.owner_id=p_owner_id),'[]'::jsonb)
 )
$$;
revoke all on function executive_visuals.get_financial_close_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.get_financial_close_overview(uuid) to service_role;

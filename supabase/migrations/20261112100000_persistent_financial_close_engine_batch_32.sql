-- Batch 32: persistent financial close execution with atomic audit events.
grant usage on schema executive_visuals to service_role;

alter table executive_visuals.financial_audit_events
 drop constraint if exists financial_audit_events_event_type_check;
alter table executive_visuals.financial_audit_events
 add constraint financial_audit_events_event_type_check check(event_type in(
  'close_period.created','close_task.assigned','close_task.started',
  'close_task.submitted','close_task.approved','close_task.rejected',
  'close_task.completed','close_task.waived','close_period.submitted',
  'close_period.approved','close_period.locked','reconciliation.reviewed',
  'close_approval.recorded','close_period.reopened','evidence.attached',
  'evidence.retention_changed'
 ));

create table if not exists executive_visuals.financial_close_periods(
 owner_id uuid not null references auth.users(id) on delete restrict,
 period_month date not null check(extract(day from period_month)=1),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 label text not null,
 period_end date,
 status text not null default 'open' check(status in('open','pending_approval','approved','locked','reopened')),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 submitted_by uuid references auth.users(id) on delete restrict,
 submitted_at timestamptz,
 approved_by uuid references auth.users(id) on delete restrict,
 approved_at timestamptz,
 locked_by uuid references auth.users(id) on delete restrict,
 locked_at timestamptz,
 reopened_by uuid references auth.users(id) on delete restrict,
 reopened_at timestamptz,
 reopen_reason text,
 version bigint not null default 1 check(version>0),
 updated_at timestamptz not null default now(),
 primary key(owner_id,period_month),
 check(submitted_by is null or submitted_by<>created_by),
 check(approved_by is null or approved_by<>submitted_by)
);
create table if not exists executive_visuals.financial_close_tasks(
 owner_id uuid not null,
 period_month date not null,
 task_id uuid not null,
 title text not null check(length(title) between 1 and 180),
 description text not null default '',
 assigned_to uuid not null references auth.users(id) on delete restrict,
 approver_ids uuid[] not null check(cardinality(approver_ids) between 1 and 5),
 due_at timestamptz,
 status text not null default 'assigned' check(status in('assigned','in_progress','submitted','approved','rejected','waived')),
 dependencies uuid[] not null default '{}',
 evidence_refs jsonb not null default '[]'::jsonb check(jsonb_typeof(evidence_refs)='array'),
 completion_note text not null default '',
 waiver_reason text,
 approval_cycle integer not null default 1 check(approval_cycle>0),
 prepared_at timestamptz,
 prepared_by uuid references auth.users(id) on delete restrict,
 approved_at timestamptz,
 approved_by uuid references auth.users(id) on delete restrict,
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check(version>0),
 primary key(owner_id,period_month,task_id),
 foreign key(owner_id,period_month) references executive_visuals.financial_close_periods(owner_id,period_month) on delete restrict,
 check(not (assigned_to=any(approver_ids))),
 check(not (task_id=any(dependencies)))
);
create index if not exists financial_close_tasks_owner_period_status_idx
 on executive_visuals.financial_close_tasks(owner_id,period_month,status);
create index if not exists financial_close_tasks_assignee_due_idx
 on executive_visuals.financial_close_tasks(assigned_to,due_at,status);

create table if not exists executive_visuals.financial_close_task_approvals(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null,
 period_month date not null,
 task_id uuid not null,
 approval_cycle integer not null,
 approval_level integer not null check(approval_level between 1 and 5),
 reviewer_id uuid not null references auth.users(id) on delete restrict,
 decision text not null check(decision in('approved','rejected')),
 comment text not null default '',
 decided_at timestamptz not null default now(),
 unique(owner_id,period_month,task_id,approval_cycle,approval_level),
 foreign key(owner_id,period_month,task_id)
  references executive_visuals.financial_close_tasks(owner_id,period_month,task_id) on delete restrict
);
create index if not exists financial_close_approvals_task_idx
 on executive_visuals.financial_close_task_approvals(owner_id,period_month,task_id,approval_cycle,approval_level);

alter table executive_visuals.financial_close_periods enable row level security;
alter table executive_visuals.financial_close_tasks enable row level security;
alter table executive_visuals.financial_close_task_approvals enable row level security;
revoke all on executive_visuals.financial_close_periods from public,anon,authenticated,service_role;
revoke all on executive_visuals.financial_close_tasks from public,anon,authenticated,service_role;
revoke all on executive_visuals.financial_close_task_approvals from public,anon,authenticated,service_role;

create or replace function executive_visuals.manage_financial_close(
 p_owner_id uuid,p_actor_id uuid,p_action text,p_period_month date,p_payload jsonb,
 p_idempotency_key text,p_event_envelope jsonb,p_canonical_event text,p_event_hash text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,public
as $$
declare
 v_audit jsonb;
 v_period executive_visuals.financial_close_periods%rowtype;
 v_task executive_visuals.financial_close_tasks%rowtype;
 v_task_id uuid;
 v_assignee uuid;
 v_approvers uuid[];
 v_dependencies uuid[];
 v_evidence jsonb;
 v_reason text;
 v_level integer;
 v_count integer;
 v_approved integer;
 v_now timestamptz:=now();
begin
 if p_owner_id is null or p_actor_id is null or p_period_month is null
  or extract(day from p_period_month)<>1 or p_action is null
  or jsonb_typeof(p_payload)<>'object' then
  raise exception using errcode='22023',message='financial_close_command_invalid';
 end if;
 if p_payload->>'action'<>p_action or p_payload->>'period'<>to_char(p_period_month,'YYYY-MM') then
  raise exception using errcode='22023',message='financial_close_command_scope_mismatch';
 end if;

 -- The audit append and the state transition share this transaction. Any failed
 -- transition rolls back the audit row; retries return before applying state twice.
 v_audit:=executive_visuals.append_financial_audit_event(
  p_owner_id,p_actor_id,p_idempotency_key,p_event_envelope,p_canonical_event,p_event_hash
 );
 if coalesce((v_audit->>'duplicate')::boolean,false) then
  return jsonb_build_object('duplicate',true,'audit',v_audit);
 end if;

 if p_action='period.open' then
  insert into executive_visuals.financial_close_periods(
   owner_id,period_month,currency,label,period_end,created_by
  ) values(
   p_owner_id,p_period_month,upper(p_payload->>'currency'),
   p_payload->>'label',nullif(p_payload->>'periodEnd','')::timestamptz::date,p_actor_id
  );
 elsif p_action='task.create' then
  select * into v_period from executive_visuals.financial_close_periods
   where owner_id=p_owner_id and period_month=p_period_month for update;
  if not found or v_period.status not in('open','reopened') then
   raise exception using errcode='55000',message='financial_close_period_not_editable';
  end if;
  v_task_id:=(p_payload->>'taskId')::uuid;
  v_assignee:=(p_payload->>'assignedTo')::uuid;
  select array_agg(value::uuid) into v_approvers
   from jsonb_array_elements_text(p_payload->'approverIds');
  select coalesce(array_agg(value::uuid),'{}'::uuid[]) into v_dependencies
   from jsonb_array_elements_text(coalesce(p_payload->'dependencies','[]'::jsonb));
  if v_assignee=any(v_approvers) then raise exception using errcode='22023',message='financial_close_self_approval'; end if;
  if exists(select 1 from unnest(v_approvers) a left join auth.users u on u.id=a where u.id is null) then raise exception using errcode='22023',message='financial_close_approver_not_found'; end if;
  if cardinality(v_dependencies)>0 and exists(
   select 1 from unnest(v_dependencies) d(id)
   left join executive_visuals.financial_close_tasks t
    on t.owner_id=p_owner_id and t.period_month=p_period_month and t.task_id=d.id
   where t.task_id is null
  ) then raise exception using errcode='22023',message='financial_close_dependency_missing'; end if;
  insert into executive_visuals.financial_close_tasks(
   owner_id,period_month,task_id,title,description,assigned_to,approver_ids,due_at,dependencies,created_by
  ) values(
   p_owner_id,p_period_month,v_task_id,p_payload->>'title',coalesce(p_payload->>'description',''),
   v_assignee,v_approvers,nullif(p_payload->>'dueAt','')::timestamptz,v_dependencies,p_actor_id
  );
 elsif p_action='task.assign' then
  v_task_id:=(p_payload->>'taskId')::uuid;
  v_assignee:=(p_payload->>'assignedTo')::uuid;
  select array_agg(value::uuid) into v_approvers from jsonb_array_elements_text(p_payload->'approverIds');
  if v_assignee=any(v_approvers) then raise exception using errcode='22023',message='financial_close_self_approval'; end if;
  if exists(select 1 from unnest(v_approvers) a left join auth.users u on u.id=a where u.id is null) then raise exception using errcode='22023',message='financial_close_approver_not_found'; end if;
  update executive_visuals.financial_close_tasks t set assigned_to=v_assignee,approver_ids=v_approvers,
   status='assigned',approval_cycle=approval_cycle+1,prepared_at=null,prepared_by=null,
   approved_at=null,approved_by=null,waiver_reason=null,updated_at=v_now,version=version+1
   from executive_visuals.financial_close_periods p
   where t.owner_id=p_owner_id and t.period_month=p_period_month and t.task_id=v_task_id
    and p.owner_id=t.owner_id and p.period_month=t.period_month and p.status in('open','reopened')
    and t.status in('assigned','in_progress','rejected','approved','waived')
   returning t.* into v_task;
  if not found then raise exception using errcode='55000',message='financial_close_task_not_assignable'; end if;
 elsif p_action='task.start' then
  v_task_id:=(p_payload->>'taskId')::uuid;
  select t.* into v_task from executive_visuals.financial_close_tasks t
   where t.owner_id=p_owner_id and t.period_month=p_period_month and t.task_id=v_task_id for update;
  if v_task.task_id is null or v_task.status not in('assigned','in_progress') then
   raise exception using errcode='55000',message='financial_close_task_not_startable';
  end if;
  if v_task.assigned_to<>p_actor_id then raise exception using errcode='42501',message='financial_close_assignee_required'; end if;
  if exists(select 1 from unnest(v_task.dependencies) d(id)
   join executive_visuals.financial_close_tasks dep
    on dep.owner_id=p_owner_id and dep.period_month=p_period_month and dep.task_id=d.id
   where dep.status not in('approved','waived')) then
   raise exception using errcode='55000',message='financial_close_dependencies_incomplete';
  end if;
  update executive_visuals.financial_close_tasks set status='in_progress',updated_at=v_now,version=version+1
   where owner_id=p_owner_id and period_month=p_period_month and task_id=v_task_id;
 elsif p_action='task.submit' then
  v_task_id:=(p_payload->>'taskId')::uuid;
  select t.* into v_task from executive_visuals.financial_close_tasks t
   where t.owner_id=p_owner_id and t.period_month=p_period_month and t.task_id=v_task_id for update;
  if v_task.task_id is null or v_task.status not in('in_progress','rejected') then
   raise exception using errcode='55000',message='financial_close_task_not_submittable';
  end if;
  if v_task.assigned_to<>p_actor_id then raise exception using errcode='42501',message='financial_close_assignee_required'; end if;
  v_evidence:=p_payload->'evidenceRefs';
  if jsonb_typeof(v_evidence)<>'array' or jsonb_array_length(v_evidence)=0 then
   raise exception using errcode='22023',message='financial_close_evidence_required';
  end if;
  if exists(select 1 from unnest(v_task.dependencies) d(id)
   join executive_visuals.financial_close_tasks dep
    on dep.owner_id=p_owner_id and dep.period_month=p_period_month and dep.task_id=d.id
   where dep.status not in('approved','waived')) then
   raise exception using errcode='55000',message='financial_close_dependencies_incomplete';
  end if;
  update executive_visuals.financial_close_tasks set status='submitted',evidence_refs=v_evidence,
   completion_note=coalesce(p_payload->>'completionNote',''),prepared_by=p_actor_id,prepared_at=v_now,
   updated_at=v_now,version=version+1
   where owner_id=p_owner_id and period_month=p_period_month and task_id=v_task_id;
 elsif p_action='task.approve' then
  v_task_id:=(p_payload->>'taskId')::uuid;
  select t.* into v_task from executive_visuals.financial_close_tasks t
   where t.owner_id=p_owner_id and t.period_month=p_period_month and t.task_id=v_task_id for update;
  if v_task.task_id is null or v_task.status<>'submitted' then raise exception using errcode='55000',message='financial_close_task_not_awaiting_approval'; end if;
  if p_actor_id=v_task.assigned_to then raise exception using errcode='42501',message='financial_close_self_approval'; end if;
  select count(*) into v_count from executive_visuals.financial_close_task_approvals
   where owner_id=p_owner_id and period_month=p_period_month and task_id=v_task_id
    and approval_cycle=v_task.approval_cycle;
  v_level:=v_count+1;
  if v_level>cardinality(v_task.approver_ids) or v_task.approver_ids[v_level]<>p_actor_id then
   raise exception using errcode='42501',message='financial_close_approver_order_required';
  end if;
  insert into executive_visuals.financial_close_task_approvals(
   owner_id,period_month,task_id,approval_cycle,approval_level,reviewer_id,decision,comment
  ) values(p_owner_id,p_period_month,v_task_id,v_task.approval_cycle,v_level,p_actor_id,'approved',coalesce(p_payload->>'comment',''));
  if v_level=cardinality(v_task.approver_ids) then
   update executive_visuals.financial_close_tasks set status='approved',approved_by=p_actor_id,approved_at=v_now,updated_at=v_now,version=version+1
    where owner_id=p_owner_id and period_month=p_period_month and task_id=v_task_id;
  end if;
 elsif p_action='task.reject' then
  v_task_id:=(p_payload->>'taskId')::uuid;v_reason:=p_payload->>'reason';
  select * into v_task from executive_visuals.financial_close_tasks
   where owner_id=p_owner_id and period_month=p_period_month and task_id=v_task_id for update;
  if not found or v_task.status<>'submitted' then raise exception using errcode='55000',message='financial_close_task_not_awaiting_approval'; end if;
  if p_actor_id=v_task.assigned_to or not (p_actor_id=any(v_task.approver_ids)) then
   raise exception using errcode='42501',message='financial_close_approver_required';
  end if;
  select count(*) into v_count from executive_visuals.financial_close_task_approvals
   where owner_id=p_owner_id and period_month=p_period_month and task_id=v_task_id and approval_cycle=v_task.approval_cycle;
  v_level:=v_count+1;
  if v_level>cardinality(v_task.approver_ids) or v_task.approver_ids[v_level]<>p_actor_id then
   raise exception using errcode='42501',message='financial_close_approver_order_required';
  end if;
  insert into executive_visuals.financial_close_task_approvals(
   owner_id,period_month,task_id,approval_cycle,approval_level,reviewer_id,decision,comment
  ) values(p_owner_id,p_period_month,v_task_id,v_task.approval_cycle,v_level,p_actor_id,'rejected',v_reason);
  update executive_visuals.financial_close_tasks set status='rejected',approval_cycle=approval_cycle+1,updated_at=v_now,version=version+1
   where owner_id=p_owner_id and period_month=p_period_month and task_id=v_task_id;
 elsif p_action='task.waive' then
  v_task_id:=(p_payload->>'taskId')::uuid;v_reason:=p_payload->>'reason';
  update executive_visuals.financial_close_tasks t set status='waived',waiver_reason=v_reason,
   updated_at=v_now,version=version+1
   from executive_visuals.financial_close_periods p
   where t.owner_id=p_owner_id and t.period_month=p_period_month and t.task_id=v_task_id
    and p.owner_id=t.owner_id and p.period_month=t.period_month and p.status in('open','reopened')
    and t.status not in('approved','waived');
  if not found then raise exception using errcode='55000',message='financial_close_task_not_waivable'; end if;
 elsif p_action='period.submit' then
  select * into v_period from executive_visuals.financial_close_periods
   where owner_id=p_owner_id and period_month=p_period_month for update;
  if not found or v_period.status not in('open','reopened') then raise exception using errcode='55000',message='financial_close_period_not_submittable'; end if;
  select count(*) into v_count from executive_visuals.financial_close_tasks
   where owner_id=p_owner_id and period_month=p_period_month;
  select count(*) into v_approved from executive_visuals.financial_close_tasks
   where owner_id=p_owner_id and period_month=p_period_month and status in('approved','waived');
  if v_count=0 or v_count<>v_approved then raise exception using errcode='55000',message='financial_close_tasks_incomplete'; end if;
  update executive_visuals.financial_close_periods set status='pending_approval',submitted_by=p_actor_id,submitted_at=v_now,
   approved_by=null,approved_at=null,updated_at=v_now,version=version+1
   where owner_id=p_owner_id and period_month=p_period_month;
 elsif p_action='period.approve' then
  update executive_visuals.financial_close_periods set status='approved',approved_by=p_actor_id,approved_at=v_now,
   updated_at=v_now,version=version+1
   where owner_id=p_owner_id and period_month=p_period_month and status='pending_approval' and submitted_by<>p_actor_id
   returning * into v_period;
  if not found then raise exception using errcode='42501',message='financial_close_independent_period_approval_required'; end if;
 elsif p_action='period.lock' then
  update executive_visuals.financial_close_periods set status='locked',locked_by=p_actor_id,locked_at=v_now,
   updated_at=v_now,version=version+1
   where owner_id=p_owner_id and period_month=p_period_month and status='approved'
   returning * into v_period;
  if not found then raise exception using errcode='55000',message='financial_close_period_not_lockable'; end if;
 elsif p_action='period.reopen' then
  v_reason:=p_payload->>'reason';
  update executive_visuals.financial_close_periods set status='reopened',reopened_by=p_actor_id,reopened_at=v_now,
   reopen_reason=v_reason,updated_at=v_now,version=version+1
   where owner_id=p_owner_id and period_month=p_period_month and status='locked'
   returning * into v_period;
  if not found then raise exception using errcode='55000',message='financial_close_period_not_reopenable'; end if;
 else
  raise exception using errcode='22023',message='financial_close_action_unsupported';
 end if;
 select * into v_period from executive_visuals.financial_close_periods
  where owner_id=p_owner_id and period_month=p_period_month;
 return jsonb_build_object('duplicate',false,'audit',v_audit,'period',to_jsonb(v_period),
  'task',case when v_task_id is null then null else (select to_jsonb(t) from executive_visuals.financial_close_tasks t where t.owner_id=p_owner_id and t.period_month=p_period_month and t.task_id=v_task_id) end);
end $$;
revoke all on function executive_visuals.manage_financial_close(uuid,uuid,text,date,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.manage_financial_close(uuid,uuid,text,date,jsonb,text,jsonb,text,text) to service_role;

create or replace function executive_visuals.financial_close_overview(p_owner_id uuid,p_period_month date default null)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare v_result jsonb;
begin
 select jsonb_build_object(
  'periods',coalesce((
   select jsonb_agg(jsonb_build_object(
    'period',to_char(p.period_month,'YYYY-MM'),'currency',p.currency,'label',p.label,
    'periodEnd',p.period_end,'status',p.status,'createdBy',p.created_by,'createdAt',p.created_at,
    'submittedBy',p.submitted_by,'submittedAt',p.submitted_at,'approvedBy',p.approved_by,'approvedAt',p.approved_at,
    'lockedBy',p.locked_by,'lockedAt',p.locked_at,'reopenedBy',p.reopened_by,'reopenedAt',p.reopened_at,
    'reopenReason',p.reopen_reason,'version',p.version,
    'tasks',coalesce((select jsonb_agg(jsonb_build_object(
     'taskId',t.task_id,'title',t.title,'description',t.description,'assignedTo',t.assigned_to,
     'approverIds',to_jsonb(t.approver_ids),'dueAt',t.due_at,'status',t.status,
     'dependencies',to_jsonb(t.dependencies),'evidenceRefs',t.evidence_refs,'completionNote',t.completion_note,
     'waiverReason',t.waiver_reason,'approvalCycle',t.approval_cycle,'preparedBy',t.prepared_by,'preparedAt',t.prepared_at,
     'approvedBy',t.approved_by,'approvedAt',t.approved_at,'version',t.version,
     'approvals',coalesce((select jsonb_agg(to_jsonb(a) order by a.approval_cycle,a.approval_level)
      from executive_visuals.financial_close_task_approvals a
      where a.owner_id=t.owner_id and a.period_month=t.period_month and a.task_id=t.task_id),'[]'::jsonb)
    ) order by t.due_at nulls last,t.created_at)
    from executive_visuals.financial_close_tasks t
    where t.owner_id=p.owner_id and t.period_month=p.period_month),'[]'::jsonb)
   ) order by p.period_month desc)
   from executive_visuals.financial_close_periods p
   where p.owner_id=p_owner_id and (p_period_month is null or p.period_month=p_period_month)
  ),'[]'::jsonb)
 ) into v_result;
 return coalesce(v_result,'{"periods":[]}'::jsonb);
end $$;
revoke all on function executive_visuals.financial_close_overview(uuid,date) from public,anon,authenticated;
grant execute on function executive_visuals.financial_close_overview(uuid,date) to service_role;

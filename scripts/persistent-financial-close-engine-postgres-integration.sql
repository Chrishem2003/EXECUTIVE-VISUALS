-- Batch 32 persistent financial close engine integration checks.
reset role;
insert into auth.users(id) values
 ('55555555-5555-4555-8555-555555555555'),
 ('66666666-6666-4666-8666-666666666666'),
 ('77777777-7777-4777-8777-777777777777'),
 ('88888888-8888-4888-8888-888888888888')
on conflict(id) do nothing;
set role service_role;

create or replace function pg_temp.canonical_jsonb(v jsonb) returns text
language plpgsql immutable as $$
declare result text;
begin
 case jsonb_typeof(v)
  when 'object' then
   select '{'||coalesce(string_agg(to_json(e.key)::text||':'||pg_temp.canonical_jsonb(e.value),',' order by e.key),'')||'}'
    into result from jsonb_each(v) e;
   return result;
  when 'array' then
   select '['||coalesce(string_agg(pg_temp.canonical_jsonb(a.value),',' order by a.ordinality),'')||']'
    into result from jsonb_array_elements(v) with ordinality a(value,ordinality);
   return result;
  else return v::text;
 end case;
end $$;

create or replace function pg_temp.close_action(
 p_owner uuid,p_actor uuid,p_action text,p_period date,p_payload jsonb,p_key text
) returns jsonb language plpgsql as $$
declare
 v_head jsonb;
 v_event jsonb;
 v_payload jsonb;
 v_canonical text;
 v_hash text;
 v_type text;
begin
 v_type:=case p_action
  when 'period.open' then 'close_period.created'
  when 'task.create' then 'close_task.assigned'
  when 'task.assign' then 'close_task.assigned'
  when 'task.start' then 'close_task.started'
  when 'task.submit' then 'close_task.submitted'
  when 'task.approve' then 'close_task.approved'
  when 'task.reject' then 'close_task.rejected'
  when 'task.waive' then 'close_task.waived'
  when 'period.submit' then 'close_period.submitted'
  when 'period.approve' then 'close_period.approved'
  when 'period.lock' then 'close_period.locked'
  when 'period.reopen' then 'close_period.reopened'
  else raise exception 'unsupported close test action';
 end;
 v_payload:=jsonb_build_object('action',p_action,'period',to_char(p_period,'YYYY-MM'))||coalesce(p_payload,'{}'::jsonb);
 v_head:=executive_visuals.get_financial_audit_head(p_owner);
 v_event:=jsonb_build_object(
  'canonicalizationVersion',1,'hashAlgorithm','SHA-256','eventId',gen_random_uuid(),
  'sequence',(v_head->>'sequence')::bigint+1,'ownerId',p_owner,'actorId',p_actor,
  'eventType',v_type,'occurredAt','2026-11-12T12:00:00.000Z',
  'payload',v_payload,'idempotencyKey',p_key,'previousHash',v_head->>'headHash'
 );
 v_canonical:=pg_temp.canonical_jsonb(v_event);
 v_hash:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
 return executive_visuals.manage_financial_close(
  p_owner,p_actor,p_action,p_period,v_payload,p_key,v_event,v_canonical,v_hash
 );
end $$;

do $batch32$
declare
 v_owner constant uuid:='55555555-5555-4555-8555-555555555555';
 v_assignee constant uuid:='66666666-6666-4666-8666-666666666666';
 v_reviewer_a constant uuid:='77777777-7777-4777-8777-777777777777';
 v_reviewer_b constant uuid:='88888888-8888-4888-8888-888888888888';
 v_task constant uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 v_rework_task constant uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 v_period constant date:='2026-10-01';
 v_result jsonb;
 v_head_before jsonb;
 v_head_after jsonb;
 v_overview jsonb;
 v_count integer;
begin
 v_result:=pg_temp.close_action(v_owner,v_owner,'period.open',v_period,
  jsonb_build_object('currency','UGX','label','October close'),'batch32-period-open');
 if v_result->>'duplicate'<>'false' or v_result#>>'{period,status}'<>'open' then
  raise exception 'Period did not open: %',v_result;
 end if;
 v_result:=pg_temp.close_action(v_owner,v_owner,'period.open',v_period,
  jsonb_build_object('currency','UGX','label','October close'),'batch32-period-open');
 if v_result->>'duplicate'<>'true' then raise exception 'Period open retry was not idempotent: %',v_result; end if;

 v_result:=pg_temp.close_action(v_owner,v_owner,'task.create',v_period,
  jsonb_build_object('taskId',v_task,'title','Bank reconciliation','description','Match bank statement to ledger',
   'assignedTo',v_assignee,'approverIds',jsonb_build_array(v_reviewer_a,v_reviewer_b),
   'dueAt','2026-11-05T17:00:00.000Z','dependencies','[]'::jsonb),'batch32-task-create');
 if v_result#>>'{task,status}'<>'assigned' then raise exception 'Task was not created: %',v_result; end if;
 perform pg_temp.close_action(v_owner,v_owner,'task.create',v_period,
  jsonb_build_object('taskId',v_rework_task,'title','Revenue reconciliation','description','Tie revenue schedule to source records',
   'assignedTo',v_assignee,'approverIds',jsonb_build_array(v_reviewer_a,v_reviewer_b),
   'dueAt','2026-11-05T17:00:00.000Z','dependencies','[]'::jsonb),'batch32-task-create-rework');

 v_head_before:=executive_visuals.get_financial_audit_head(v_owner);
 begin
  perform pg_temp.close_action(v_owner,v_owner,'period.submit',v_period,'{}'::jsonb,'batch32-invalid-submit');
  raise exception 'Incomplete close period unexpectedly submitted';
 exception when others then
  if sqlerrm='Incomplete close period unexpectedly submitted' then raise; end if;
 end;
 v_head_after:=executive_visuals.get_financial_audit_head(v_owner);
 if v_head_before->>'headHash'<>v_head_after->>'headHash' then
  raise exception 'Failed close transition left an orphan audit event';
 end if;

 perform pg_temp.close_action(v_assignee,v_assignee,'task.start',v_period,
  jsonb_build_object('taskId',v_task),'batch32-task-start');
 perform pg_temp.close_action(v_assignee,v_assignee,'task.submit',v_period,
  jsonb_build_object('taskId',v_task,'evidenceRefs',jsonb_build_array('vault://evidence/bank-statement-2026-10'),
   'completionNote','Reconciled with no unexplained variance'),'batch32-task-submit');
 v_result:=pg_temp.close_action(v_reviewer_a,v_reviewer_a,'task.approve',v_period,
  jsonb_build_object('taskId',v_task,'comment','First independent review'),'batch32-task-approve-a');
 if v_result#>>'{task,status}'<>'submitted' then raise exception 'Multi-level task approval completed too early: %',v_result; end if;
 v_result:=pg_temp.close_action(v_reviewer_b,v_reviewer_b,'task.approve',v_period,
  jsonb_build_object('taskId',v_task,'comment','Second independent review'),'batch32-task-approve-b');
 if v_result#>>'{task,status}'<>'approved' then raise exception 'Task did not complete after all approvals: %',v_result; end if;

 perform pg_temp.close_action(v_assignee,v_assignee,'task.start',v_period,
  jsonb_build_object('taskId',v_rework_task),'batch32-rework-task-start');
 perform pg_temp.close_action(v_assignee,v_assignee,'task.submit',v_period,
  jsonb_build_object('taskId',v_rework_task,'evidenceRefs',jsonb_build_array('vault://evidence/revenue-schedule'),
   'completionNote','Initial schedule submitted'),'batch32-rework-task-submit-1');
 perform pg_temp.close_action(v_reviewer_a,v_reviewer_a,'task.reject',v_period,
  jsonb_build_object('taskId',v_rework_task,'reason','Missing source invoice support'),'batch32-rework-task-reject');
 perform pg_temp.close_action(v_assignee,v_assignee,'task.submit',v_period,
  jsonb_build_object('taskId',v_rework_task,'evidenceRefs',jsonb_build_array('vault://evidence/revenue-schedule','vault://evidence/source-invoices'),
   'completionNote','Additional invoice support attached'),'batch32-rework-task-submit-2');
 perform pg_temp.close_action(v_reviewer_a,v_reviewer_a,'task.approve',v_period,
  jsonb_build_object('taskId',v_rework_task,'comment','Rework accepted'),'batch32-rework-task-approve-a');
 v_result:=pg_temp.close_action(v_reviewer_b,v_reviewer_b,'task.approve',v_period,
  jsonb_build_object('taskId',v_rework_task,'comment','Second review accepted'),'batch32-rework-task-approve-b');
 if v_result#>>'{task,status}'<>'approved' or (v_result#>>'{task,approval_cycle}')::integer<>2 then
  raise exception 'Rejected task did not restart its ordered approval cycle: %',v_result;
 end if;

 v_result:=pg_temp.close_action(v_owner,v_owner,'period.submit',v_period,'{}'::jsonb,'batch32-period-submit');
 if v_result#>>'{period,status}'<>'pending_approval' then raise exception 'Period did not enter approval: %',v_result; end if;
 begin
  perform pg_temp.close_action(v_owner,v_owner,'period.approve',v_period,'{}'::jsonb,'batch32-self-approve');
  raise exception 'Period submitter unexpectedly approved own close';
 exception when others then
  if sqlerrm='Period submitter unexpectedly approved own close' then raise; end if;
 end;
 v_result:=pg_temp.close_action(v_reviewer_a,v_reviewer_a,'period.approve',v_period,'{}'::jsonb,'batch32-period-approve');
 if v_result#>>'{period,status}'<>'approved' then raise exception 'Period did not reach approved state: %',v_result; end if;
 v_result:=pg_temp.close_action(v_owner,v_owner,'period.lock',v_period,'{}'::jsonb,'batch32-period-lock');
 if v_result#>>'{period,status}'<>'locked' then raise exception 'Period did not lock: %',v_result; end if;
 v_result:=pg_temp.close_action(v_owner,v_owner,'period.reopen',v_period,
  jsonb_build_object('reason','Correcting a late bank statement'),'batch32-period-reopen');
 if v_result#>>'{period,status}'<>'reopened' then raise exception 'Period did not reopen: %',v_result; end if;

 v_result:=pg_temp.close_action(v_owner,v_owner,'task.assign',v_period,
  jsonb_build_object('taskId',v_task,'assignedTo',v_assignee,'approverIds',jsonb_build_array(v_reviewer_a)),
  'batch32-task-reassign-after-reopen');
 if v_result#>>'{task,status}'<>'assigned' then raise exception 'Reopened task could not be reassigned: %',v_result; end if;

 v_overview:=executive_visuals.financial_close_overview(v_owner,v_period);
 if jsonb_array_length(v_overview->'periods')<>1 then raise exception 'Close overview did not return the period'; end if;
 if v_overview#>>'{periods,0,status}'<>'reopened' then raise exception 'Close overview status mismatch: %',v_overview; end if;
 select count(*) into v_count from executive_visuals.financial_audit_events where owner_id=v_owner;
 if v_count<10 then raise exception 'Expected every close transition to create an audit event; found %',v_count; end if;
 v_head_after:=executive_visuals.get_financial_audit_head(v_owner);
 if (v_head_after->>'sequence')::bigint<>v_count then raise exception 'Audit sequence and event count diverged'; end if;
end $batch32$;
reset role;

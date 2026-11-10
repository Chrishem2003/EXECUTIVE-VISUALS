-- Batch 32 persistent close workflow integration tests.
reset role;
insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222'),
 ('33333333-3333-4333-8333-333333333333'),
 ('44444444-4444-4444-8444-444444444444'),
 ('55555555-5555-4555-8555-555555555555'),
 ('77777777-7777-4777-8777-777777777777')
on conflict(id) do nothing;

create or replace function pg_temp.canonical_financial_json(p_value jsonb)
returns text language plpgsql immutable as $canon$
declare v_result text;
begin
 case jsonb_typeof(p_value)
  when 'object' then
   select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||pg_temp.canonical_financial_json(value),',' order by key),'')||'}'
    into v_result from jsonb_each(p_value);
   return v_result;
  when 'array' then
   select '['||coalesce(string_agg(pg_temp.canonical_financial_json(value),',' order by ordinality),'')||']'
    into v_result from jsonb_array_elements(p_value) with ordinality as item(value,ordinality);
   return v_result;
  else return p_value::text;
 end case;
end $canon$;

create or replace function pg_temp.run_financial_close_command(
 p_owner uuid,p_actor uuid,p_command text,p_payload jsonb,p_key text
) returns jsonb language plpgsql as $$
declare
 v_head jsonb;
 v_event jsonb;
 v_canonical text;
 v_hash text;
 v_type text;
begin
 v_type:=case p_command
  when 'create_period' then 'close_period.created'
  when 'assign_task' then 'close_task.assigned'
  when 'complete_task' then 'close_task.completed'
  when 'waive_task' then 'close_task.waived'
  when 'submit_for_approval' then 'close_period.submitted'
  when 'record_approval' then 'close_approval.recorded'
  when 'reassign_approval' then 'close_approval.assigned'
  when 'lock_period' then 'close_period.locked'
  when 'reopen_period' then 'close_period.reopened'
 end;
 v_head:=executive_visuals.get_financial_audit_head(p_owner);
 v_event:=jsonb_build_object(
  'canonicalizationVersion',1,'hashAlgorithm','SHA-256','eventId',gen_random_uuid(),
  'sequence',(v_head->>'sequence')::bigint+1,'ownerId',p_owner,'actorId',p_actor,
  'eventType',v_type,'occurredAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'payload',p_payload,'idempotencyKey',p_key,'previousHash',v_head->>'headHash'
 );
 v_canonical:=pg_temp.canonical_financial_json(v_event);
 v_hash:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
 return executive_visuals.execute_financial_close_command(
  p_owner,p_actor,p_command,p_payload,v_event,v_canonical,v_hash
 );
end $$;

set role service_role;
do $batch32$
declare
 v_owner constant uuid:='77777777-7777-4777-8777-777777777777';
 v_creator constant uuid:='22222222-2222-4222-8222-222222222222';
 v_reviewer1 constant uuid:='33333333-3333-4333-8333-333333333333';
 v_reviewer2 constant uuid:='44444444-4444-4444-8444-444444444444';
 v_assignee constant uuid:='55555555-5555-4555-8555-555555555555';
 v_result jsonb;
 v_period_id uuid;
 v_task_id uuid;
 v_count integer;
begin
 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'create_period',
  jsonb_build_object('periodStart','2026-11-01','periodEnd','2026-11-30','currency','UGX',
   'approvalStages',jsonb_build_array(
    jsonb_build_object('stageKey','finance_manager','reviewerId',v_reviewer1),
    jsonb_build_object('stageKey','controller','reviewerId',v_reviewer2)
   )),'batch32-period-create-2026-11');
 if v_result->>'duplicate'<>'false' then raise exception 'Period create failed: %',v_result; end if;
 v_period_id:=(v_result->'period'->>'id')::uuid;

 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'assign_task',
  jsonb_build_object('periodId',v_period_id,'taskKey','bank_reconciliation','title','Bank reconciliation','assigneeId',v_assignee,'required',true),
  'batch32-task-assign-bank');
 v_task_id:=(v_result->'task'->>'id')::uuid;

 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'complete_task',
  jsonb_build_object('periodId',v_period_id,'taskId',v_task_id,'evidenceRefs',jsonb_build_array('private://evidence/bank-statement-2026-11')),
  'batch32-task-complete-bank');
 if v_result->'task'->>'status'<>'completed' then raise exception 'Task completion failed: %',v_result; end if;

 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'submit_for_approval',
  jsonb_build_object('periodId',v_period_id),'batch32-period-submit');
 if v_result->'period'->>'status'<>'in_review' then raise exception 'Period submission failed: %',v_result; end if;

 v_result:=pg_temp.run_financial_close_command(v_owner,v_reviewer1,'record_approval',
  jsonb_build_object('periodId',v_period_id,'stageKey','finance_manager','decision','approved'),
  'batch32-approval-finance-manager');
 v_result:=pg_temp.run_financial_close_command(v_owner,v_reviewer2,'record_approval',
  jsonb_build_object('periodId',v_period_id,'stageKey','controller','decision','approved'),
  'batch32-approval-controller');

 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'lock_period',
  jsonb_build_object('periodId',v_period_id),'batch32-period-lock');
 if v_result->'period'->>'status'<>'locked' then raise exception 'Period lock failed: %',v_result; end if;

 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'lock_period',
  jsonb_build_object('periodId',v_period_id),'batch32-period-lock');
 if v_result->>'duplicate'<>'true' then raise exception 'Idempotent lock retry was not a no-op: %',v_result; end if;

 select count(*) into v_count from executive_visuals.financial_audit_events where owner_id=v_owner;
 if v_count<>7 then raise exception 'Expected seven committed close audit events, found %',v_count; end if;

 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'reopen_period',
  jsonb_build_object('periodId',v_period_id,'reason','Controller requested a documented review correction'),
  'batch32-period-reopen');
 if v_result->'period'->>'status'<>'open' then raise exception 'Period reopen failed: %',v_result; end if;
 v_result:=executive_visuals.get_financial_close_overview(v_owner);
 if exists(select 1 from jsonb_array_elements(v_result->'approvals') as item(value)
  where value->>'period_id'=v_period_id::text and value->>'status'<>'pending') then
  raise exception 'Reopening did not reset approval decisions';
 end if;

 -- A failed domain mutation must roll back its preceding audit append.
 begin
  perform pg_temp.run_financial_close_command(v_owner,v_creator,'lock_period',
   jsonb_build_object('periodId',v_period_id),'batch32-invalid-lock-after-reopen');
  raise exception 'Lock after reopen unexpectedly succeeded without new approvals';
 exception when others then
  if sqlerrm='Lock after reopen unexpectedly succeeded without new approvals' then raise; end if;
 end;
 select count(*) into v_count from executive_visuals.financial_audit_events where owner_id=v_owner;
 if v_count<>8 then raise exception 'Failed close transition left an audit event behind; count=%',v_count; end if;

 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'reassign_approval',
  jsonb_build_object('periodId',v_period_id,'stageKey','finance_manager','reviewerId',v_assignee),
  'batch32-approval-reassign-manager');
 if v_result->'approval'->>'reviewer_id'<>v_assignee::text then raise exception 'Approval reassignment failed: %',v_result; end if;
 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'submit_for_approval',
  jsonb_build_object('periodId',v_period_id),'batch32-period-resubmit');
 v_result:=pg_temp.run_financial_close_command(v_owner,v_assignee,'record_approval',
  jsonb_build_object('periodId',v_period_id,'stageKey','finance_manager','decision','approved'),
  'batch32-approval-reassigned-manager');
 v_result:=pg_temp.run_financial_close_command(v_owner,v_reviewer2,'record_approval',
  jsonb_build_object('periodId',v_period_id,'stageKey','controller','decision','approved'),
  'batch32-approval-controller-second-round');
 v_result:=pg_temp.run_financial_close_command(v_owner,v_creator,'lock_period',
  jsonb_build_object('periodId',v_period_id),'batch32-period-lock-second-round');
 if v_result->'period'->>'status'<>'locked' then raise exception 'Relocked period after reviewer reassignment failed: %',v_result; end if;
 select count(*) into v_count from executive_visuals.financial_audit_events where owner_id=v_owner;
 if v_count<>13 then raise exception 'Expected thirteen close audit events after second approval round, found %',v_count; end if;
end
$batch32$;
reset role;

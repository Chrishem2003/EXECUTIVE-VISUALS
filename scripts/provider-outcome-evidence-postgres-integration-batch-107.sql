-- Batch 107: verify durable provider evidence persistence, task binding and idempotency.
begin;

do $batch107_user$
declare v_owner uuid:=gen_random_uuid();
begin
 insert into auth.users(id) values(v_owner);
 perform set_config('batch107.owner_id',v_owner::text,true);
end;
$batch107_user$;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $batch107_evidence$
declare
 v_owner uuid:=current_setting('batch107.owner_id')::uuid;
 v_project uuid:=gen_random_uuid();
 v_approval uuid:=gen_random_uuid();
 v_task uuid:=gen_random_uuid();
 v_task_bad uuid:=gen_random_uuid();
 v_evidence uuid;
 v_digest text:=repeat('a',64);
 v_result record;
begin
 insert into executive_visuals.projects(id,owner_id,name)
 values(v_project,v_owner,'Batch 107 provider evidence test');
 insert into executive_visuals.video_generation_approvals(
  id,owner_id,project_id,idempotency_key,request_hash,snapshot_json,currency,
  quoted_amount_micros,budget_ceiling_micros
 ) values(
  v_approval,v_owner,v_project,'batch107-approval-'||v_approval::text,repeat('b',64),
  jsonb_build_object('shots',jsonb_build_array(jsonb_build_object(
    'estimatedCostMicros','3000000','provider','runway','model','seedance-2.5',
    'estimatedCost',jsonb_build_object('currency','USD')
  ))),'USD',3000000,4000000
 );
 insert into executive_visuals.video_generation_tasks(
  id,approval_id,owner_id,project_id,shot_index,request_hash,currency,
  estimated_cost_micros,provider,model,state,provider_task_id
 ) values(
  v_task,v_approval,v_owner,v_project,0,repeat('b',64),'USD',3000000,
  'runway','seedance-2.5','succeeded','runway-task-batch107'
 );
 insert into executive_visuals.video_generation_tasks(
  id,approval_id,owner_id,project_id,shot_index,request_hash,currency,
  estimated_cost_micros,provider,model,state,provider_task_id
 ) values(
  v_task_bad,v_approval,v_owner,v_project,1,repeat('b',64),'USD',3000000,
  'runway','seedance-2.5','cancelled','runway-task-batch107-mismatch'
 );

 select * into v_result from executive_visuals.record_provider_outcome_evidence(
  v_task,'runway','runway-task-batch107','account-test','seedance-2.5','runway-dev',
  'provider-event-107','charged','succeeded','USD',3400000,5,0,true,
  'usage-export:row-107',clock_timestamp(),'HMAC-SHA256',v_digest,
  'runway-adapter','1.0.0'
 );
 if v_result.replayed or v_result.actual_cost_micros<>3400000
    or v_result.estimated_cost_micros<>3000000 or v_result.variance_micros<>400000 then
  raise exception 'BATCH107_COST_VARIANCE_OR_FIRST_WRITE_INVALID';
 end if;
 v_evidence:=v_result.evidence_row_id;

 select * into v_result from executive_visuals.record_provider_outcome_evidence(
  v_task,'runway','runway-task-batch107','account-test','seedance-2.5','runway-dev',
  'provider-event-107','charged','succeeded','USD',3400000,5,0,true,
  'usage-export:row-107',clock_timestamp(),'HMAC-SHA256',v_digest,
  'runway-adapter','1.0.0'
 );
 if not v_result.replayed or v_result.evidence_row_id<>v_evidence then
  raise exception 'BATCH107_EXACT_REPLAY_NOT_IDEMPOTENT';
 end if;

 begin
  perform * from executive_visuals.record_provider_outcome_evidence(
   v_task,'runway','runway-task-batch107','account-test','seedance-2.5','runway-dev',
   'provider-event-107','charged','succeeded','USD',3500000,5,0,true,
   'usage-export:row-107',clock_timestamp(),'HMAC-SHA256',repeat('c',64),
   'runway-adapter','1.0.0'
  );
  raise exception 'BATCH107_DIGEST_CONFLICT_WAS_ACCEPTED';
 exception when sqlstate '23505' then
  if sqlerrm<>'PROVIDER_OUTCOME_EVIDENCE_IDEMPOTENCY_CONFLICT' then raise; end if;
 end;

 begin
  perform * from executive_visuals.record_provider_outcome_evidence(
   v_task_bad,'runway','runway-task-batch107','account-test','seedance-2.5','runway-dev',
   'provider-event-wrong-task','charged','failed','USD',100000,1,0,true,
   'usage-export:wrong-task',clock_timestamp(),'HMAC-SHA256',repeat('d',64),
   'runway-adapter','1.0.0'
  );
  raise exception 'BATCH107_PROVIDER_TASK_MISMATCH_WAS_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'PROVIDER_OUTCOME_TASK_IDENTITY_OR_STATE_MISMATCH' then raise; end if;
 end;

 -- Table writes are not granted to the adapter role; the append-only trigger is
 -- an additional owner-level guard against privileged mutation.
 begin
  update executive_visuals.provider_outcome_evidence set route='tampered'
   where id=v_evidence;
  raise exception 'BATCH107_EVIDENCE_MUTATION_WAS_ACCEPTED';
 exception when sqlstate '42501' then
  null;
 end;

 begin
  perform * from executive_visuals.record_provider_outcome_evidence(
   v_task,'runway','runway-task-batch107','account-test','seedance-2.5','runway-dev',
   'provider-event-no-charge-invalid','no_charge','succeeded','USD',0,2,0,false,
   'usage-export:invalid-no-charge',clock_timestamp(),'HMAC-SHA256',repeat('e',64),
   'runway-adapter','1.0.0'
  );
  raise exception 'BATCH107_INVALID_NO_CHARGE_WAS_ACCEPTED';
 exception when sqlstate '22023' then
  if sqlerrm<>'PROVIDER_OUTCOME_AMOUNT_STATE_INVALID' then raise; end if;
 end;

 -- A verified no-charge provider outcome is recorded as cost evidence only.
 -- It does not change or release any customer reservation.
 select * into v_result from executive_visuals.record_provider_outcome_evidence(
  v_task_bad,'runway','runway-task-batch107-mismatch','account-test','seedance-2.5','runway-dev',
  'provider-event-no-charge','no_charge','cancelled','USD',0,0,0,false,
  'usage-export:no-charge',clock_timestamp(),'HMAC-SHA256',repeat('f',64),
  'runway-adapter','1.0.0'
 );
 if v_result.replayed or v_result.actual_cost_micros<>0 then
  raise exception 'BATCH107_NO_CHARGE_EVIDENCE_RECORD_FAILED';
 end if;

 -- An unresolved provider charge is durably recorded without inventing a cost.
 select * into v_result from executive_visuals.record_provider_outcome_evidence(
  v_task_bad,'runway','runway-task-batch107-mismatch','account-test','seedance-2.5','runway-dev',
  'provider-event-unknown','unknown','cancelled','USD',null,0,0,false,
  'provider-status:unknown',clock_timestamp(),'HMAC-SHA256',repeat('1',64),
  'runway-adapter','1.0.0'
 );
 if v_result.replayed or v_result.actual_cost_micros is not null
    or v_result.variance_micros is not null then
  raise exception 'BATCH107_UNKNOWN_OUTCOME_NOT_HELD_FOR_RECONCILIATION';
 end if;
 if exists(select 1 from executive_visuals.credit_reservations where metadata->>'provider_outcome_evidence_id'=v_evidence::text)
    then raise exception 'BATCH107_EVIDENCE_IMPROPERLY_MUTATED_CUSTOMER_CREDITS'; end if;
end;
$batch107_evidence$;

reset role;
rollback;
select 'DURABLE_PROVIDER_OUTCOME_EVIDENCE_BATCH_107_OK' as result;

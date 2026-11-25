-- Batch 109: verify no under-reserved settlement, no refund-ledger bypass and no overdraft.
begin;

do $batch109_users$
declare
 v_billing_owner uuid:=gen_random_uuid();
 v_pool_owner uuid:=gen_random_uuid();
 v_project uuid:=gen_random_uuid();
begin
 insert into auth.users(id) values(v_billing_owner),(v_pool_owner);
 perform set_config('batch109.billing_owner',v_billing_owner::text,true);
 perform set_config('batch109.pool_owner',v_pool_owner::text,true);
 perform set_config('batch109.project_id',v_project::text,true);
end;
$batch109_users$;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $batch109_billing$
declare
 v_owner uuid:=current_setting('batch109.billing_owner')::uuid;
 v_job uuid:=gen_random_uuid();
 v_reservation uuid:=gen_random_uuid();
 v_result record;
 v_evidence jsonb:=jsonb_build_object('provider','runway','evidenceType','provider_invoice','evidenceId','batch109-billing-invoice-1');
 v_balance bigint;
begin
 insert into executive_visuals.jobs(id,owner_id,job_type,status,input,idempotency_key,max_attempts)
 values(v_job,v_owner,'video.generate','cancelled','{}'::jsonb,'batch109-billing-job-'||v_job::text,2);
 insert into executive_visuals.billing_credit_accounts(owner_id) values(v_owner);
 insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,idempotency_key,description)
 values(v_owner,200,'grant','batch109-billing-grant-'||v_owner::text,'Batch 109 test grant');
 insert into executive_visuals.billing_credit_reservations(id,owner_id,job_id,idempotency_key,reserved_credits)
 values(v_reservation,v_owner,v_job,'batch109-billing-reservation-'||v_job::text,100);
 insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
 values(v_owner,-100,'generation_reserve',v_job,'batch109-billing-reserve-'||v_job::text,'Batch 109 test reserve');

 begin
  perform * from executive_visuals.settle_generation_credit_reservation(v_reservation,50,v_evidence);
  raise exception 'BATCH109_BILLING_UNDER_RESERVED_SETTLEMENT_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION' then raise; end if;
 end;
 if (select state from executive_visuals.billing_credit_reservations where id=v_reservation)<>'reserved' then
  raise exception 'BATCH109_BILLING_REFUND_ATTEMPT_CHANGED_RESERVATION';
 end if;
 begin
  update executive_visuals.billing_credit_reservations
   set actual_credits=50,state='settled',evidence=v_evidence,settled_at=clock_timestamp()
   where id=v_reservation;
  raise exception 'BATCH109_DIRECT_BILLING_RESERVATION_UPDATE_ACCEPTED';
 exception when sqlstate '42501' then
  null;
 end;
 select coalesce(sum(amount),0) into v_balance from executive_visuals.billing_credit_ledger where owner_id=v_owner;
 if v_balance<>100 then raise exception 'BATCH109_BILLING_BALANCE_CHANGED_AFTER_REFUND_BLOCK'; end if;

 begin
  perform * from executive_visuals.settle_generation_credit_reservation(v_reservation,250,v_evidence);
  raise exception 'BATCH109_BILLING_OVERDRAFT_SETTLEMENT_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'BILLING_INSUFFICIENT_CREDITS_FOR_SETTLEMENT' then raise; end if;
 end;

 select * into v_result from executive_visuals.settle_generation_credit_reservation(v_reservation,150,v_evidence);
 if v_result.replayed or v_result.balance<>50 or v_result.adjustment<>-50 then
  raise exception 'BATCH109_BILLING_FUNDED_OVERAGE_SETTLEMENT_INVALID';
 end if;
 select * into v_result from executive_visuals.settle_generation_credit_reservation(v_reservation,150,v_evidence);
 if not v_result.replayed or v_result.balance<>50 then
  raise exception 'BATCH109_BILLING_SETTLEMENT_REPLAY_INVALID';
 end if;

 begin
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
  values(v_owner,10,'generation_refund',v_job,'batch109-billing-direct-refund-'||v_job::text,'forbidden direct refund');
  raise exception 'BATCH109_DIRECT_BILLING_REFUND_LEDGER_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION' then raise; end if;
 end;

 begin
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
  values(v_owner,-100,'generation_settlement',v_job,'batch109-billing-direct-overdraft-'||v_job::text,'forbidden direct overdraft');
  raise exception 'BATCH109_DIRECT_BILLING_OVERDRAFT_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'BILLING_INSUFFICIENT_CREDITS_FOR_SETTLEMENT' then raise; end if;
 end;
end;
$batch109_billing$;

do $batch109_pool$
declare
 v_owner uuid:=current_setting('batch109.pool_owner')::uuid;
 v_project uuid:=current_setting('batch109.project_id')::uuid;
 v_member uuid:=gen_random_uuid();
 v_job uuid:=gen_random_uuid();
 v_reservation uuid:=gen_random_uuid();
 v_result record;
 v_evidence jsonb:=jsonb_build_object('provider','runway','evidenceType','provider_invoice','evidenceId','batch109-project-invoice-1');
 v_balance bigint;
begin
 insert into executive_visuals.projects(id,owner_id,name)
 values(v_project,v_owner,'Batch 109 settlement guard project');
 insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key,max_attempts)
 values(v_job,v_member,v_project,'video.generate','cancelled','{}'::jsonb,'batch109-project-job-'||v_job::text,2);
 insert into executive_visuals.project_credit_pools(project_id,owner_id,monthly_spend_limit_credits)
 values(v_project,v_owner,1000);
 insert into executive_visuals.project_credit_pool_ledger(project_id,owner_id,actor_id,amount,event_type,idempotency_key,description)
 values(v_project,v_owner,v_owner,200,'top_up','batch109-project-fund-'||v_project::text,'Batch 109 test funding');
 insert into executive_visuals.project_credit_pool_reservations(
  id,project_id,owner_id,actor_id,job_id,idempotency_key,reserved_credits
 ) values(v_reservation,v_project,v_member,v_member,v_job,'batch109-project-reservation-'||v_job::text,100);
 insert into executive_visuals.billing_credit_accounts(owner_id) values(v_member) on conflict(owner_id) do nothing;
 insert into executive_visuals.billing_credit_reservations(id,owner_id,job_id,idempotency_key,reserved_credits)
 values(v_reservation,v_member,v_job,'batch109-project-reservation-'||v_job::text,100);
 insert into executive_visuals.project_credit_pool_ledger(
  project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description
 ) values(
  v_project,v_owner,v_member,-100,'generation_reserve',v_job,
  'batch109-project-reserve-'||v_job::text,'Batch 109 test reserve'
 );

 begin
  perform * from executive_visuals.settle_project_credit_pool_reservation(v_reservation,50,v_evidence);
  raise exception 'BATCH109_PROJECT_UNDER_RESERVED_SETTLEMENT_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION' then raise; end if;
 end;
 if (select state from executive_visuals.project_credit_pool_reservations where id=v_reservation)<>'reserved'
    or (select state from executive_visuals.billing_credit_reservations where id=v_reservation)<>'reserved' then
  raise exception 'BATCH109_PROJECT_REFUND_ATTEMPT_CHANGED_RESERVATIONS';
 end if;
 begin
  update executive_visuals.project_credit_pool_reservations
   set actual_credits=50,state='settled',evidence=v_evidence,settled_at=clock_timestamp()
   where id=v_reservation;
  raise exception 'BATCH109_DIRECT_PROJECT_RESERVATION_UPDATE_ACCEPTED';
 exception when sqlstate '42501' then
  null;
 end;
 select coalesce(sum(amount),0) into v_balance from executive_visuals.project_credit_pool_ledger where project_id=v_project;
 if v_balance<>100 then raise exception 'BATCH109_PROJECT_BALANCE_CHANGED_AFTER_REFUND_BLOCK'; end if;

 begin
  perform * from executive_visuals.settle_project_credit_pool_reservation(v_reservation,250,v_evidence);
  raise exception 'BATCH109_PROJECT_OVERDRAFT_SETTLEMENT_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'BILLING_INSUFFICIENT_PROJECT_CREDITS_FOR_SETTLEMENT' then raise; end if;
 end;

 select * into v_result from executive_visuals.settle_project_credit_pool_reservation(v_reservation,150,v_evidence);
 if v_result.replayed or v_result.balance<>50 or v_result.adjustment<>-50 then
  raise exception 'BATCH109_PROJECT_FUNDED_OVERAGE_SETTLEMENT_INVALID';
 end if;
 if (select owner_id from executive_visuals.project_credit_pool_ledger
     where idempotency_key='project-credit-settlement:'||v_reservation::text)<>v_owner
    or (select actor_id from executive_visuals.project_credit_pool_ledger
     where idempotency_key='project-credit-settlement:'||v_reservation::text)<>v_member then
  raise exception 'BATCH109_PROJECT_SETTLEMENT_ACTOR_ATTRIBUTION_INVALID';
 end if;
 if (select used_this_month from executive_visuals.list_project_credit_pool_member_usage(v_owner,v_project)
     where member_id=v_member)<>150 then
  raise exception 'BATCH109_PROJECT_MEMBER_ACTUAL_USAGE_NOT_ATTRIBUTED';
 end if;
 select * into v_result from executive_visuals.settle_project_credit_pool_reservation(v_reservation,150,v_evidence);
 if not v_result.replayed or v_result.balance<>50 then
  raise exception 'BATCH109_PROJECT_SETTLEMENT_REPLAY_INVALID';
 end if;

 begin
  insert into executive_visuals.project_credit_pool_ledger(
   project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description
  ) values(v_project,v_owner,v_owner,10,'generation_refund',v_job,
   'batch109-project-direct-refund-'||v_job::text,'forbidden direct refund');
  raise exception 'BATCH109_DIRECT_PROJECT_REFUND_LEDGER_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION' then raise; end if;
 end;

 begin
  insert into executive_visuals.project_credit_pool_ledger(
   project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description
  ) values(v_project,v_owner,v_owner,-100,'generation_settlement',v_job,
   'batch109-project-direct-overdraft-'||v_job::text,'forbidden direct overdraft');
  raise exception 'BATCH109_DIRECT_PROJECT_OVERDRAFT_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'BILLING_INSUFFICIENT_PROJECT_CREDITS_FOR_SETTLEMENT' then raise; end if;
 end;
end;
$batch109_pool$;

reset role;
rollback;
select 'CUSTOMER_CREDIT_SETTLEMENT_REFUND_OVERDRAFT_GUARD_BATCH_109_OK' as result;

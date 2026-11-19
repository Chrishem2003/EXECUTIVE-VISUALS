-- Executive Visuals: pre-ingestion customer credit settlement for Neon video jobs.
-- Source-controlled only. Requires migrations 0001-0004.
-- Not applied to the connected Neon staging branch.
begin;

create or replace function executive_visuals.settle_video_generation_customer_credits_v1(
 p_job_id uuid,p_owner_id uuid,p_provider text,p_actual_credits bigint,p_evidence jsonb
) returns table(balance bigint,adjustment bigint,replayed boolean)
language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare j executive_visuals.jobs; submission executive_visuals.video_generation_submissions;
 credit_row executive_visuals.billing_credit_reservations; budget_row executive_visuals.video_generation_budget_reservations;
 account_status text; current_balance bigint; delta bigint; proof jsonb;
begin
 if p_job_id is null or p_owner_id is null or p_provider is null or char_length(btrim(p_provider)) not between 1 and 100
  or p_actual_credits is null or p_actual_credits<0 or p_actual_credits>1000000000
  or p_evidence is null or jsonb_typeof(p_evidence)<>'object' or octet_length(p_evidence::text)>8000
  or coalesce(p_evidence->>'provider','')<>p_provider
  or coalesce(p_evidence->>'evidenceType','') not in ('provider_task_receipt','provider_invoice','provider_usage_reconciliation')
  or coalesce(p_evidence->>'evidenceId','')='' or coalesce(p_evidence->>'evidenceReference','')='' then
  raise exception 'VIDEO_CUSTOMER_CREDIT_SETTLEMENT_ARGUMENTS_INVALID';
 end if;

 select * into j from executive_visuals.jobs
 where id=p_job_id and owner_id=p_owner_id and job_type='video.generate' and status='processing' for update;
 if j.id is null or coalesce(j.input->>'provider','')<>p_provider then
  raise exception 'VIDEO_CUSTOMER_CREDIT_SETTLEMENT_JOB_SCOPE_INVALID';
 end if;

 select * into submission from executive_visuals.video_generation_submissions
 where job_id=p_job_id and owner_id=p_owner_id for update;
 if submission.id is null or submission.provider<>p_provider or submission.provider_task_id<>p_evidence->>'evidenceId'
  or submission.state not in ('submitted','succeeded') then
  raise exception 'VIDEO_CUSTOMER_CREDIT_SETTLEMENT_PROVIDER_TASK_UNVERIFIED';
 end if;

 select * into budget_row from executive_visuals.video_generation_budget_reservations where job_id=p_job_id for update;
 select * into credit_row from executive_visuals.billing_credit_reservations where job_id=p_job_id and owner_id=p_owner_id for update;
 if budget_row.id is null or budget_row.provider<>p_provider or credit_row.id is null then
  raise exception 'VIDEO_CUSTOMER_CREDIT_SETTLEMENT_RESERVATION_MISSING';
 end if;
 if p_actual_credits>credit_row.reserved_credits then raise exception 'VIDEO_ACTUAL_CREDITS_EXCEED_RESERVATION'; end if;

 perform 1 from executive_visuals.billing_credit_accounts where owner_id=p_owner_id and status='active' for update;
 if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

 if credit_row.state='settled' then
  if credit_row.actual_credits<>p_actual_credits
   or credit_row.evidence->>'provider'<>p_provider
   or credit_row.evidence->>'evidenceType'<>p_evidence->>'evidenceType'
   or credit_row.evidence->>'evidenceId'<>p_evidence->>'evidenceId'
   or credit_row.evidence->>'evidenceReference'<>p_evidence->>'evidenceReference' then
   raise exception 'VIDEO_CUSTOMER_CREDIT_SETTLEMENT_CONFLICT';
  end if;
  select coalesce(sum(amount),0) into current_balance from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
  return query select current_balance,credit_row.reserved_credits-credit_row.actual_credits,true;
  return;
 end if;
 if credit_row.state<>'reserved' or budget_row.state<>'reserved' then
  raise exception 'VIDEO_CUSTOMER_CREDIT_SETTLEMENT_STATE_INVALID';
 end if;

 delta:=credit_row.reserved_credits-p_actual_credits;
 if delta<>0 then
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description,evidence)
  values(p_owner_id,delta,
   case when delta>0 then 'generation_refund' else 'generation_settlement' end,
   p_job_id,'credit-finalize:'||credit_row.id::text,
   'Provider verified customer-credit settlement',p_evidence);
 end if;
 update executive_visuals.billing_credit_reservations
 set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
 where id=credit_row.id;

 select coalesce(sum(amount),0) into current_balance from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
 return query select current_balance,delta,false;
end $$;

create or replace function executive_visuals.finalize_video_generation_financials_v1(
 p_job_id uuid,p_owner_id uuid,p_terminal_status text,p_actual_amount numeric,p_actual_credits bigint,p_evidence jsonb
) returns table(balance bigint,credit_adjustment bigint,replayed boolean)
language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare budget_row executive_visuals.video_generation_budget_reservations;
 credit_row executive_visuals.billing_credit_reservations; policy_row executive_visuals.video_generation_budget_policies;
 j executive_visuals.jobs; delta bigint; current_balance bigint; provider_task text; evidence_ref text; evidence_type text;
begin
 if p_job_id is null or p_owner_id is null or p_terminal_status not in ('succeeded','partial','failed','cancelled')
  or jsonb_typeof(coalesce(p_evidence,'{}'::jsonb))<>'object' then
  raise exception 'VIDEO_FINANCIAL_FINALIZATION_ARGUMENTS_INVALID';
 end if;
 select * into j from executive_visuals.jobs where id=p_job_id and owner_id=p_owner_id and job_type='video.generate' for update;
 if j.id is null then raise exception 'VIDEO_FINANCIAL_JOB_OWNER_MISMATCH'; end if;
 select * into budget_row from executive_visuals.video_generation_budget_reservations where job_id=p_job_id for update;
 select * into credit_row from executive_visuals.billing_credit_reservations where job_id=p_job_id for update;
 if budget_row.id is null and credit_row.id is null then return query select 0::bigint,0::bigint,false; return; end if;
 if budget_row.id is null or credit_row.id is null or budget_row.owner_id<>p_owner_id or credit_row.owner_id<>p_owner_id then
  raise exception 'VIDEO_FINANCIAL_RESERVATION_INCOMPLETE';
 end if;
 perform 1 from executive_visuals.billing_credit_accounts where owner_id=p_owner_id and status='active' for update;
 if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

 if budget_row.state in ('settled','released') then
  if budget_row.state<>credit_row.state then raise exception 'VIDEO_FINANCIAL_FINALIZATION_STATE_CONFLICT'; end if;
  if p_terminal_status in ('succeeded','partial') and
   (budget_row.actual_amount is distinct from p_actual_amount or credit_row.actual_credits is distinct from p_actual_credits) then
   raise exception 'VIDEO_FINANCIAL_FINALIZATION_REPLAY_CONFLICT';
  end if;
  select coalesce(sum(amount),0) into current_balance from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
  return query select current_balance,coalesce(credit_row.reserved_credits-credit_row.actual_credits,0),true;
  return;
 end if;
 if budget_row.state<>'reserved' then raise exception 'VIDEO_BUDGET_RESERVATION_NOT_ACTIVE'; end if;

 if p_terminal_status in ('succeeded','partial') then
  if p_actual_amount is null or p_actual_amount<0 or p_actual_amount>budget_row.reserved_amount
   or p_actual_credits is null or p_actual_credits<0 or p_actual_credits>credit_row.reserved_credits then
   raise exception 'VIDEO_ACTUAL_COST_EXCEEDS_RESERVATION';
  end if;
  provider_task:=coalesce(p_evidence->>'providerTaskId','');
  evidence_ref:=coalesce(p_evidence->>'evidenceReference','');
  evidence_type:=coalesce(p_evidence->>'evidenceType','');
  if coalesce(p_evidence->>'provider','')<>budget_row.provider or coalesce(p_evidence->>'model','')<>budget_row.model
   or provider_task='' or evidence_ref='' or evidence_type not in ('provider_task_receipt','provider_invoice','provider_usage_reconciliation') then
   raise exception 'VIDEO_COST_EVIDENCE_INVALID';
  end if;

  insert into executive_visuals.video_generation_cost_ledger(job_id,owner_id,project_id,provider,model,provider_task_id,currency,reserved_amount,actual_amount,evidence_reference,idempotency_key)
  values(p_job_id,p_owner_id,budget_row.project_id,budget_row.provider,budget_row.model,provider_task,budget_row.currency,budget_row.reserved_amount,p_actual_amount,evidence_ref,'video-generation-cost:'||p_job_id::text);

  if credit_row.state='reserved' then
   delta:=credit_row.reserved_credits-p_actual_credits;
   if delta<>0 then
    insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description,evidence)
    values(p_owner_id,delta,case when delta>0 then 'generation_refund' else 'generation_settlement' end,
     p_job_id,'credit-finalize:'||credit_row.id::text,'Provider verified customer-credit settlement',p_evidence);
   end if;
   update executive_visuals.billing_credit_reservations
    set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
    where id=credit_row.id;
  elsif credit_row.state='settled' then
   if credit_row.actual_credits is distinct from p_actual_credits
    or credit_row.evidence->>'provider'<>p_evidence->>'provider'
    or credit_row.evidence->>'evidenceType'<>p_evidence->>'evidenceType'
    or credit_row.evidence->>'evidenceId'<>p_evidence->>'evidenceId'
    or credit_row.evidence->>'evidenceReference'<>p_evidence->>'evidenceReference' then
    raise exception 'VIDEO_CUSTOMER_CREDIT_SETTLEMENT_CONFLICT';
   end if;
  else
   raise exception 'VIDEO_FINANCIAL_CREDIT_RESERVATION_STATE_INVALID';
  end if;

  update executive_visuals.video_generation_budget_reservations
   set actual_amount=p_actual_amount,state='settled',updated_at=clock_timestamp() where id=budget_row.id;
  update executive_visuals.video_generation_budget_policies
   set reserved_amount=reserved_amount-budget_row.reserved_amount,spent_amount=spent_amount+p_actual_amount,updated_at=clock_timestamp()
   where id=budget_row.policy_id;
 else
  if credit_row.state<>'reserved' then raise exception 'VIDEO_SETTLED_CREDITS_CANNOT_BE_RELEASED'; end if;
  if coalesce(p_evidence->>'provider','')<>budget_row.provider
   or coalesce(p_evidence->>'evidenceType','') not in ('verified_no_charge_cancellation','verified_no_submission')
   or coalesce(p_evidence->>'evidenceId','')='' or coalesce(p_evidence->>'evidenceReference','')='' then
   raise exception 'VIDEO_FAILURE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE';
  end if;
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description,evidence)
  values(p_owner_id,credit_row.reserved_credits,'generation_refund',p_job_id,'credit-release:'||credit_row.id::text,
   'Video generation reservation released after verified non-billable failure',p_evidence);
  update executive_visuals.billing_credit_reservations
   set state='released',actual_credits=0,evidence=p_evidence||jsonb_build_object('terminalStatus',p_terminal_status),settled_at=clock_timestamp()
   where id=credit_row.id;
  update executive_visuals.video_generation_budget_reservations
   set state='released',actual_amount=0,updated_at=clock_timestamp() where id=budget_row.id;
  update executive_visuals.video_generation_budget_policies
   set reserved_amount=reserved_amount-budget_row.reserved_amount,updated_at=clock_timestamp() where id=budget_row.policy_id;
  delta:=credit_row.reserved_credits;
 end if;

 select coalesce(sum(amount),0) into current_balance from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
 return query select current_balance,
  case when p_terminal_status in ('succeeded','partial') then credit_row.reserved_credits-p_actual_credits else delta end,false;
end $$;

revoke all on function executive_visuals.settle_video_generation_customer_credits_v1(uuid,uuid,text,bigint,jsonb) from public;
revoke all on function executive_visuals.finalize_video_generation_financials_v1(uuid,uuid,text,numeric,bigint,jsonb) from public;
commit;

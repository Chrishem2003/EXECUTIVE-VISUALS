-- Batch 109: prevent under-reserved customer settlement and wallet overdrafts.
-- Automatic refunds remain disabled until trusted provider + customer-price reconciliation exists.
-- Exact reserved-credit settlement and funded overages remain available.

create or replace function executive_visuals.guard_generation_credit_reservation_settlement()
returns trigger
language plpgsql
set search_path=pg_catalog
as $guard_generation_credit_reservation_settlement$
begin
 if tg_op='INSERT' then
  if new.state is distinct from 'reserved' or new.actual_credits is not null then
   raise exception 'BILLING_CREDIT_RESERVATION_MUST_START_RESERVED' using errcode='55000';
  end if;
  return new;
 end if;

 if old.state='settled' then
  if new.state is distinct from old.state
     or new.actual_credits is distinct from old.actual_credits
     or new.evidence is distinct from old.evidence
     or new.settled_at is distinct from old.settled_at then
   raise exception 'BILLING_CREDIT_SETTLEMENT_IMMUTABLE' using errcode='55000';
  end if;
  return new;
 end if;
 if old.state='released' then
  raise exception 'BILLING_CREDIT_RELEASE_IMMUTABLE' using errcode='55000';
 end if;
 if new.state='settled' and (
    new.actual_credits is null or new.actual_credits<old.reserved_credits
 ) then
  raise exception 'BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION' using errcode='55000';
 end if;
 if new.state='settled' and (
    new.settled_at is null or jsonb_typeof(new.evidence)<>'object'
    or coalesce(new.evidence->>'provider','')=''
    or coalesce(new.evidence->>'evidenceType','') not in
      ('provider_task_receipt','provider_invoice','provider_usage_reconciliation','verified_no_charge_cancellation')
    or coalesce(new.evidence->>'evidenceId','')=''
 ) then
  raise exception 'BILLING_CREDIT_SETTLEMENT_EVIDENCE_INVALID';
 end if;
 if new.state='reserved' and new.actual_credits is not null then
  raise exception 'BILLING_CREDIT_SETTLEMENT_STATE_INVALID' using errcode='55000';
 end if;
 return new;
end;
$guard_generation_credit_reservation_settlement$;
revoke all on function executive_visuals.guard_generation_credit_reservation_settlement()
 from public,anon,authenticated,service_role;

drop trigger if exists ev_billing_credit_reservations_settlement_guard
 on executive_visuals.billing_credit_reservations;
create trigger ev_billing_credit_reservations_settlement_guard
before insert or update on executive_visuals.billing_credit_reservations
for each row execute function executive_visuals.guard_generation_credit_reservation_settlement();

drop trigger if exists ev_project_credit_pool_reservations_settlement_guard
 on executive_visuals.project_credit_pool_reservations;
create trigger ev_project_credit_pool_reservations_settlement_guard
before insert or update on executive_visuals.project_credit_pool_reservations
for each row execute function executive_visuals.guard_generation_credit_reservation_settlement();

-- Reservation state/actual-credit writes must go through the guarded security-definer RPCs.
revoke update on executive_visuals.billing_credit_reservations from service_role;
revoke update on executive_visuals.project_credit_pool_reservations from service_role;

create or replace function executive_visuals.guard_generation_credit_ledger_insert()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $guard_generation_credit_ledger_insert$
declare current_balance bigint;
begin
 if new.event_type='generation_refund' and new.amount>0 then
  raise exception 'BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION' using errcode='55000';
 end if;

 if new.amount<0 then
  if tg_table_name='billing_credit_ledger' then
   perform 1 from executive_visuals.billing_credit_accounts
    where owner_id=new.owner_id for update;
   if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
   select coalesce(sum(amount),0) into current_balance
    from executive_visuals.billing_credit_ledger where owner_id=new.owner_id;
   if current_balance+new.amount<0 then
    raise exception 'BILLING_INSUFFICIENT_CREDITS_FOR_SETTLEMENT' using errcode='55000';
   end if;
  elsif tg_table_name='project_credit_pool_ledger' then
   perform 1 from executive_visuals.project_credit_pools
    where project_id=new.project_id for update;
   if not found then raise exception 'PROJECT_CREDIT_POOL_NOT_ACTIVE'; end if;
   select coalesce(sum(amount),0) into current_balance
    from executive_visuals.project_credit_pool_ledger where project_id=new.project_id;
   if current_balance+new.amount<0 then
    raise exception 'BILLING_INSUFFICIENT_PROJECT_CREDITS_FOR_SETTLEMENT' using errcode='55000';
   end if;
  end if;
 end if;
 return new;
end;
$guard_generation_credit_ledger_insert$;
revoke all on function executive_visuals.guard_generation_credit_ledger_insert()
 from public,anon,authenticated,service_role;

drop trigger if exists ev_billing_credit_ledger_settlement_guard
 on executive_visuals.billing_credit_ledger;
create trigger ev_billing_credit_ledger_settlement_guard
before insert on executive_visuals.billing_credit_ledger
for each row execute function executive_visuals.guard_generation_credit_ledger_insert();

drop trigger if exists ev_project_credit_pool_ledger_settlement_guard
 on executive_visuals.project_credit_pool_ledger;
create trigger ev_project_credit_pool_ledger_settlement_guard
before insert on executive_visuals.project_credit_pool_ledger
for each row execute function executive_visuals.guard_generation_credit_ledger_insert();

create or replace function executive_visuals.settle_generation_credit_reservation(
 p_reservation_id uuid,p_actual_credits bigint,p_evidence jsonb
)
returns table(balance bigint,adjustment bigint,replayed boolean)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $settle_generation_credit_reservation_batch_109$
declare
 reservation executive_visuals.billing_credit_reservations%rowtype;
 current_balance bigint;
 delta bigint;
 extra_credits bigint;
begin
 if p_reservation_id is null or p_actual_credits is null or p_actual_credits<0
    or p_actual_credits>1000000000 or p_evidence is null
    or jsonb_typeof(p_evidence)<>'object'
    or coalesce(p_evidence->>'provider','')=''
    or coalesce(p_evidence->>'evidenceType','') not in
      ('provider_task_receipt','provider_invoice','provider_usage_reconciliation','verified_no_charge_cancellation')
    or coalesce(p_evidence->>'evidenceId','')='' then
  raise exception 'BILLING_CREDIT_SETTLEMENT_EVIDENCE_INVALID';
 end if;

 select * into reservation from executive_visuals.billing_credit_reservations
  where id=p_reservation_id;
 if not found then raise exception 'BILLING_CREDIT_RESERVATION_NOT_FOUND'; end if;
 perform 1 from executive_visuals.billing_credit_accounts
  where owner_id=reservation.owner_id for update;
 if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
 select * into reservation from executive_visuals.billing_credit_reservations
  where id=p_reservation_id for update;

 if reservation.state='settled' then
  if reservation.actual_credits<>p_actual_credits or reservation.evidence<>p_evidence then
   raise exception 'BILLING_CREDIT_SETTLEMENT_CONFLICT';
  end if;
  select coalesce(sum(amount),0) into current_balance
   from executive_visuals.billing_credit_ledger where owner_id=reservation.owner_id;
  return query select current_balance,reservation.reserved_credits-p_actual_credits,true;
  return;
 end if;
 if reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_SETTLEABLE'; end if;
 if p_actual_credits<reservation.reserved_credits then
  raise exception 'BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION' using errcode='55000';
 end if;

 extra_credits:=p_actual_credits-reservation.reserved_credits;
 select coalesce(sum(amount),0) into current_balance
  from executive_visuals.billing_credit_ledger where owner_id=reservation.owner_id;
 if current_balance<extra_credits then
  raise exception 'BILLING_INSUFFICIENT_CREDITS_FOR_SETTLEMENT' using errcode='55000';
 end if;

 delta:=reservation.reserved_credits-p_actual_credits;
 if delta<0 then
  insert into executive_visuals.billing_credit_ledger(
   owner_id,amount,event_type,reference_id,idempotency_key,description,evidence
  ) values(
   reservation.owner_id,delta,'generation_settlement',reservation.job_id,
   'credit-settlement:'||reservation.id::text,
   'Conservative generation credit settlement',p_evidence
  );
 end if;
 update executive_visuals.billing_credit_reservations
  set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
  where id=reservation.id;
 update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
  where owner_id=reservation.owner_id;
 select coalesce(sum(amount),0) into current_balance
  from executive_visuals.billing_credit_ledger where owner_id=reservation.owner_id;
 return query select current_balance,delta,false;
end;
$settle_generation_credit_reservation_batch_109$;

create or replace function executive_visuals.settle_project_credit_pool_reservation(
 p_reservation_id uuid,p_actual_credits bigint,p_evidence jsonb
)
returns table(balance bigint,adjustment bigint,replayed boolean)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $settle_project_credit_pool_reservation_batch_109$
declare
 reservation executive_visuals.project_credit_pool_reservations%rowtype;
 current_balance bigint;
 delta bigint;
 extra_credits bigint;
begin
 if p_reservation_id is null or p_actual_credits is null or p_actual_credits<0
    or p_actual_credits>1000000000 or p_evidence is null
    or jsonb_typeof(p_evidence)<>'object'
    or coalesce(p_evidence->>'provider','')=''
    or coalesce(p_evidence->>'evidenceType','') not in
      ('provider_task_receipt','provider_invoice','provider_usage_reconciliation','verified_no_charge_cancellation')
    or coalesce(p_evidence->>'evidenceId','')='' then
  raise exception 'BILLING_CREDIT_SETTLEMENT_EVIDENCE_INVALID';
 end if;

 select * into reservation from executive_visuals.project_credit_pool_reservations
  where id=p_reservation_id;
 if not found then raise exception 'BILLING_CREDIT_RESERVATION_NOT_FOUND'; end if;
 perform 1 from executive_visuals.project_credit_pools
  where project_id=reservation.project_id for update;
 if not found then raise exception 'PROJECT_CREDIT_POOL_NOT_ACTIVE'; end if;
 select * into reservation from executive_visuals.project_credit_pool_reservations
  where id=p_reservation_id for update;

 if reservation.state='settled' then
  if reservation.actual_credits<>p_actual_credits or reservation.evidence<>p_evidence then
   raise exception 'BILLING_CREDIT_SETTLEMENT_CONFLICT';
  end if;
  select coalesce(sum(amount),0) into current_balance
   from executive_visuals.project_credit_pool_ledger where project_id=reservation.project_id;
  return query select current_balance,reservation.reserved_credits-p_actual_credits,true;
  return;
 end if;
 if reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_SETTLEABLE'; end if;
 if p_actual_credits<reservation.reserved_credits then
  raise exception 'BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION' using errcode='55000';
 end if;

 extra_credits:=p_actual_credits-reservation.reserved_credits;
 select coalesce(sum(amount),0) into current_balance
  from executive_visuals.project_credit_pool_ledger where project_id=reservation.project_id;
 if current_balance<extra_credits then
  raise exception 'BILLING_INSUFFICIENT_PROJECT_CREDITS_FOR_SETTLEMENT' using errcode='55000';
 end if;

 delta:=reservation.reserved_credits-p_actual_credits;
 if delta<0 then
  insert into executive_visuals.project_credit_pool_ledger(
   project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description,evidence
  ) values(
   reservation.project_id,reservation.owner_id,reservation.owner_id,delta,
   'generation_settlement',reservation.job_id,
   'project-credit-settlement:'||reservation.id::text,
   'Conservative project generation credit settlement',p_evidence
  );
 end if;
 update executive_visuals.project_credit_pool_reservations
  set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
  where id=reservation.id;
 update executive_visuals.billing_credit_reservations
  set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
  where id=reservation.id;
 select coalesce(sum(amount),0) into current_balance
  from executive_visuals.project_credit_pool_ledger where project_id=reservation.project_id;
 return query select current_balance,delta,false;
end;
$settle_project_credit_pool_reservation_batch_109$;

comment on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb) is
 'Conservative settlement: no automatic refunds below reserved credits; additional charges require funded balance.';
comment on function executive_visuals.settle_project_credit_pool_reservation(uuid,bigint,jsonb) is
 'Conservative project settlement: no automatic refunds below reserved credits; additional charges require funded pool balance.';

-- Batch 64: verify that customer-credit settlement cannot overdraw an
-- approved reservation. Run only against the disposable cloud-video PostgreSQL
-- harness after the Batch 64 migration has been applied.

begin;

do $batch64$
declare
  v_owner uuid := gen_random_uuid();
  v_reservation uuid := gen_random_uuid();
  v_blocked boolean := false;
  v_constraint text;
  v_balance bigint;
  v_adjustment bigint;
  v_replayed boolean;
  v_evidence jsonb := jsonb_build_object(
    'provider','runway',
    'evidenceType','provider_task_receipt',
    'evidenceId','batch64-provider-task-001'
  );
begin
  insert into auth.users(id) values(v_owner);
  insert into executive_visuals.billing_credit_accounts(owner_id) values(v_owner);
  insert into executive_visuals.billing_credit_reservations(
    id,owner_id,job_id,idempotency_key,reserved_credits
  ) values(
    v_reservation,v_owner,null,'batch64-reservation-'||v_reservation::text,100
  );
  insert into executive_visuals.billing_credit_ledger(
    owner_id,amount,event_type,reference_id,idempotency_key,description
  ) values(
    v_owner,-100,'generation_reserve',null,
    'credit-reserve:batch64:'||v_reservation::text,'Batch 64 test reservation'
  );

  begin
    perform *
    from executive_visuals.settle_generation_credit_reservation(
      v_reservation,101,v_evidence
    );
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint <> 'billing_credit_actual_within_reservation' then
      raise;
    end if;
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'Settlement above the approved reservation unexpectedly succeeded';
  end if;

  if not exists(
    select 1 from executive_visuals.billing_credit_reservations
    where id=v_reservation and state='reserved' and actual_credits is null
  ) then
    raise exception 'Rejected overrun changed the reservation state';
  end if;

  if exists(
    select 1 from executive_visuals.billing_credit_ledger
    where idempotency_key='credit-settlement:'||v_reservation::text
  ) then
    raise exception 'Rejected overrun wrote a settlement ledger entry';
  end if;

  select s.balance,s.adjustment,s.replayed
    into v_balance,v_adjustment,v_replayed
  from executive_visuals.settle_generation_credit_reservation(
    v_reservation,80,v_evidence
  ) s;

  if v_adjustment<>20 or v_replayed then
    raise exception 'Within-reservation settlement did not refund the unused 20 credits';
  end if;

  select s.balance,s.adjustment,s.replayed
    into v_balance,v_adjustment,v_replayed
  from executive_visuals.settle_generation_credit_reservation(
    v_reservation,80,v_evidence
  ) s;

  if not v_replayed or v_adjustment<>20 then
    raise exception 'Identical settlement replay was not idempotent';
  end if;
end
$batch64$;

rollback;

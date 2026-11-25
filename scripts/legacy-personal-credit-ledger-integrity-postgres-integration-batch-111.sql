-- Batch 111: verify legacy personal credit ledger integrity and reservation protections.
begin;

do $batch111_setup$
declare v_owner uuid:=gen_random_uuid();
begin
 insert into auth.users(id) values(v_owner);
 perform set_config('batch111.owner_id',v_owner::text,true);
end;
$batch111_setup$;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);

select * from executive_visuals.grant_generation_credits(
 current_setting('batch111.owner_id')::uuid,100,
 'batch111-personal-credit-grant','Batch 111 disposable test grant',
 '{"source":"batch111_ci_fixture"}'::jsonb
);

do $batch111_reserve$
declare
 v_owner uuid:=current_setting('batch111.owner_id')::uuid;
 v_result jsonb;
 v_reservation uuid;
 v_balance jsonb;
begin
 v_result:=executive_visuals.reserve_credit_units(
  v_owner,60,'batch111-personal-credit-reserve',
  'Batch 111 test reservation',null,'{"source":"batch111_ci_fixture"}'::jsonb
 );
 v_reservation:=(v_result->>'reservation_id')::uuid;
 perform set_config('batch111.reservation_id',v_reservation::text,true);
 v_balance:=executive_visuals.get_credit_balance(v_owner);
 if (v_balance->>'ledger_balance')::bigint<>100
    or (v_balance->>'reserved_credits')::bigint<>60
    or (v_balance->>'available_credits')::bigint<>40 then
  raise exception 'BATCH111_INITIAL_PERSONAL_BALANCE_INVALID';
 end if;
end;
$batch111_reserve$;

do $batch111_privileges$
declare v_owner uuid:=current_setting('batch111.owner_id')::uuid;
 v_reservation uuid:=current_setting('batch111.reservation_id')::uuid;
begin
 if has_table_privilege('service_role','executive_visuals.credit_ledger','INSERT')
    or has_table_privilege('service_role','executive_visuals.credit_ledger','UPDATE')
    or has_table_privilege('service_role','executive_visuals.credit_ledger','DELETE')
    or has_table_privilege('service_role','executive_visuals.credit_reservations','INSERT')
    or has_table_privilege('service_role','executive_visuals.credit_reservations','UPDATE')
    or has_table_privilege('service_role','executive_visuals.credit_reservations','DELETE') then
  raise exception 'BATCH111_SERVICE_ROLE_HAS_DIRECT_LEGACY_CREDIT_WRITE_PRIVILEGES';
 end if;
 begin
  update executive_visuals.credit_reservations set credit_units=1 where id=v_reservation;
  raise exception 'BATCH111_DIRECT_RESERVATION_MUTATION_ACCEPTED';
 exception when insufficient_privilege then null;
 end;
 begin
  insert into executive_visuals.credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,reason)
  values(v_owner,'manual_adjustment',1000,'batch111-forbidden-direct-credit-insert','Forbidden direct credit insert');
  raise exception 'BATCH111_DIRECT_LEDGER_INSERT_ACCEPTED';
 exception when insufficient_privilege then null;
 end;
end;
$batch111_privileges$;

reset role;

do $batch111_overdraft$
declare v_owner uuid:=current_setting('batch111.owner_id')::uuid;
begin
 begin
  insert into executive_visuals.credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,reason)
  values(v_owner,'manual_adjustment',-50,'batch111-overdraft-attempt','Attempt to consume reserved personal credits');
  raise exception 'BATCH111_RESERVED_CREDIT_OVERDRAFT_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'CREDIT_LEDGER_OVERDRAFT_BLOCKED' then raise; end if;
 end;
 if (select coalesce(sum(credit_delta),0) from executive_visuals.credit_ledger where owner_id=v_owner)<>100 then
  raise exception 'BATCH111_OVERDRAFT_ATTEMPT_CHANGED_LEDGER';
 end if;
end;
$batch111_overdraft$;

set role service_role;

do $batch111_settlement$
declare
 v_owner uuid:=current_setting('batch111.owner_id')::uuid;
 v_reservation uuid:=current_setting('batch111.reservation_id')::uuid;
 v_result jsonb;
 v_balance jsonb;
begin
 v_result:=executive_visuals.settle_credit_reservation(v_reservation);
 if v_result->>'status'<>'settled' or v_result->>'already_settled'<>'false' then
  raise exception 'BATCH111_PERSONAL_SETTLEMENT_INVALID';
 end if;
 v_result:=executive_visuals.settle_credit_reservation(v_reservation);
 if v_result->>'status'<>'settled' or v_result->>'already_settled'<>'true' then
  raise exception 'BATCH111_PERSONAL_SETTLEMENT_REPLAY_INVALID';
 end if;
 v_balance:=executive_visuals.get_credit_balance(v_owner);
 if (v_balance->>'ledger_balance')::bigint<>40
    or (v_balance->>'reserved_credits')::bigint<>0
    or (v_balance->>'available_credits')::bigint<>40 then
  raise exception 'BATCH111_PERSONAL_SETTLEMENT_BALANCE_INVALID';
 end if;
end;
$batch111_settlement$;

reset role;

do $batch111_post_settlement_overdraft$
declare v_owner uuid:=current_setting('batch111.owner_id')::uuid;
begin
 begin
  insert into executive_visuals.credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,reason)
  values(v_owner,'manual_adjustment',-41,'batch111-post-settlement-overdraft','Attempt to overdraw settled personal credits');
  raise exception 'BATCH111_POST_SETTLEMENT_OVERDRAFT_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'CREDIT_LEDGER_OVERDRAFT_BLOCKED' then raise; end if;
 end;
end;
$batch111_post_settlement_overdraft$;

set role service_role;

do $batch111_release$
declare
 v_owner uuid:=current_setting('batch111.owner_id')::uuid;
 v_result jsonb;
 v_reservation uuid;
begin
 v_result:=executive_visuals.reserve_credit_units(
  v_owner,10,'batch111-release-blocked-reservation',
  'Batch 111 release protection test',null,'{"source":"batch111_ci_fixture"}'::jsonb
 );
 v_reservation:=(v_result->>'reservation_id')::uuid;
 begin
  perform executive_visuals.release_credit_reservation(v_reservation,'Batch 111 release must remain blocked');
  raise exception 'BATCH111_UNVERIFIED_RELEASE_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE' then raise; end if;
 end;
 if (select status from executive_visuals.credit_reservations where id=v_reservation)<>'reserved' then
  raise exception 'BATCH111_RELEASE_ATTEMPT_CHANGED_RESERVATION';
 end if;
end;
$batch111_release$;

reset role;
rollback;
select 'LEGACY_PERSONAL_CREDIT_LEDGER_INTEGRITY_BATCH_111_OK' as result;

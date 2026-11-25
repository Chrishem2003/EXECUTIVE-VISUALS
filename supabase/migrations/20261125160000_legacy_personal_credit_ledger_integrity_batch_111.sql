-- Batch 111: harden the legacy personal credit ledger and reservation tables.
-- All ledger writes and reservation mutations must use the existing security-definer RPCs.
-- Existing Batch 105 release protection remains authoritative.

create or replace function executive_visuals.guard_legacy_credit_reservation_integrity()
returns trigger
language plpgsql
set search_path=pg_catalog
as $guard_legacy_credit_reservation_integrity$
begin
 if tg_op='INSERT' then
  if new.status is distinct from 'reserved'
     or new.settled_at is not null or new.released_at is not null then
   raise exception 'CREDIT_RESERVATION_MUST_START_RESERVED' using errcode='55000';
  end if;
  return new;
 end if;

 if new.owner_id is distinct from old.owner_id
    or new.job_id is distinct from old.job_id
    or new.credit_units is distinct from old.credit_units
    or new.idempotency_key is distinct from old.idempotency_key
    or new.reason is distinct from old.reason
    or new.created_at is distinct from old.created_at then
  raise exception 'CREDIT_RESERVATION_IDENTITY_IMMUTABLE' using errcode='55000';
 end if;

 if old.status in ('settled','released') then
  if new.status is distinct from old.status
     or new.metadata is distinct from old.metadata
     or new.settled_at is distinct from old.settled_at
     or new.released_at is distinct from old.released_at then
   raise exception 'CREDIT_RESERVATION_TERMINAL_STATE_IMMUTABLE' using errcode='55000';
  end if;
  return new;
 end if;

 if old.status<>'reserved' then
  raise exception 'CREDIT_RESERVATION_STATE_INVALID' using errcode='55000';
 end if;
 if new.status='reserved' then
  if new.settled_at is not null or new.released_at is not null then
   raise exception 'CREDIT_RESERVATION_TERMINAL_TIMESTAMP_INVALID' using errcode='55000';
  end if;
  return new;
 end if;
 if new.status='settled' then
  if new.settled_at is null or new.released_at is not null
     or new.metadata is distinct from old.metadata then
   raise exception 'CREDIT_RESERVATION_SETTLEMENT_INVALID' using errcode='55000';
  end if;
  return new;
 end if;
 if new.status='released' then
  if new.released_at is null or new.settled_at is not null then
   raise exception 'CREDIT_RESERVATION_RELEASE_INVALID' using errcode='55000';
  end if;
  return new;
 end if;
 raise exception 'CREDIT_RESERVATION_STATE_INVALID' using errcode='55000';
end;
$guard_legacy_credit_reservation_integrity$;
revoke all on function executive_visuals.guard_legacy_credit_reservation_integrity()
 from public,anon,authenticated,service_role;

drop trigger if exists ev_credit_reservations_integrity_guard
 on executive_visuals.credit_reservations;
create trigger ev_credit_reservations_integrity_guard
before insert or update on executive_visuals.credit_reservations
for each row execute function executive_visuals.guard_legacy_credit_reservation_integrity();

create or replace function executive_visuals.guard_legacy_credit_ledger_insert()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $guard_legacy_credit_ledger_insert$
declare
 ledger_balance bigint;
 reserved_balance bigint;
 settlement_reservation executive_visuals.credit_reservations%rowtype;
 reservation_text text;
begin
 if new.owner_id is null then
  raise exception 'CREDIT_LEDGER_OWNER_REQUIRED' using errcode='55000';
 end if;
 if new.credit_delta>=0 then
  return new;
 end if;

 perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,0));
 select coalesce(sum(credit_delta),0)::bigint into ledger_balance
  from executive_visuals.credit_ledger where owner_id=new.owner_id;
 select coalesce(sum(credit_units),0)::bigint into reserved_balance
  from executive_visuals.credit_reservations
  where owner_id=new.owner_id and status='reserved';

 if new.entry_type='settlement' then
  reservation_text:=new.metadata->>'reservation_id';
  if reservation_text is null or reservation_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
   raise exception 'CREDIT_SETTLEMENT_RESERVATION_EVIDENCE_REQUIRED' using errcode='55000';
  end if;
  select * into settlement_reservation
   from executive_visuals.credit_reservations
   where id=reservation_text::uuid for update;
  if not found or settlement_reservation.owner_id is distinct from new.owner_id
     or settlement_reservation.status is distinct from 'reserved'
     or settlement_reservation.job_id is distinct from new.job_id
     or new.credit_delta is distinct from -settlement_reservation.credit_units
     or new.idempotency_key is distinct from 'credit-settlement:'||settlement_reservation.id::text then
   raise exception 'CREDIT_SETTLEMENT_RESERVATION_MISMATCH' using errcode='55000';
  end if;
  reserved_balance:=reserved_balance-settlement_reservation.credit_units;
 end if;

 if ledger_balance+new.credit_delta<reserved_balance then
  raise exception 'CREDIT_LEDGER_OVERDRAFT_BLOCKED' using errcode='55000';
 end if;
 return new;
end;
$guard_legacy_credit_ledger_insert$;
revoke all on function executive_visuals.guard_legacy_credit_ledger_insert()
 from public,anon,authenticated,service_role;

drop trigger if exists ev_credit_ledger_prevent_overdraft
 on executive_visuals.credit_ledger;
create trigger ev_credit_ledger_prevent_overdraft
before insert on executive_visuals.credit_ledger
for each row execute function executive_visuals.guard_legacy_credit_ledger_insert();

create or replace function executive_visuals.reject_legacy_credit_ledger_mutation()
returns trigger
language plpgsql
set search_path=pg_catalog
as $reject_legacy_credit_ledger_mutation$
begin
 raise exception 'CREDIT_LEDGER_IS_APPEND_ONLY' using errcode='55000';
end;
$reject_legacy_credit_ledger_mutation$;
revoke all on function executive_visuals.reject_legacy_credit_ledger_mutation()
 from public,anon,authenticated,service_role;
drop trigger if exists ev_credit_ledger_immutable
 on executive_visuals.credit_ledger;
create trigger ev_credit_ledger_immutable
before update or delete on executive_visuals.credit_ledger
for each row execute function executive_visuals.reject_legacy_credit_ledger_mutation();

-- All mutations must pass through the existing security-definer reserve/grant/settle
-- RPCs. The function owners retain their rights; PostgREST service-role direct writes do not.
revoke insert,update,delete on executive_visuals.credit_reservations from service_role;
revoke insert,update,delete on executive_visuals.credit_ledger from service_role;
grant select on executive_visuals.credit_reservations to service_role;
grant select on executive_visuals.credit_ledger to service_role;

comment on table executive_visuals.credit_reservations is
 'Legacy personal credit holds. Direct service-role mutation is revoked; reserve, settle and release use guarded security-definer RPCs.';
comment on table executive_visuals.credit_ledger is
 'Append-only legacy personal credit ledger with reserved-balance overdraft protection.';

-- Batch 105: prevent any generic reservation path from releasing customer credits
-- while provider billing may still be unresolved.
-- This guard is intentionally fail-closed. It does not activate provider dispatch,
-- alter payment entitlements, or release any existing reservation.
--
-- A future release path must first persist trusted, provider-verifiable no-charge
-- evidence and then replace this guard in a separately reviewed migration.

create or replace function executive_visuals.reject_unverified_credit_reservation_release()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $reject_unverified_credit_reservation_release$
begin
  if tg_table_name = 'credit_reservations' then
    if new.status = 'released' then
      if tg_op = 'INSERT' or old.status is distinct from 'released' then
        raise exception using
          message = 'CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE',
          errcode = '55000';
      end if;
    end if;
  elsif tg_table_name = 'billing_credit_reservations' then
    if new.state = 'released' then
      if tg_op = 'INSERT' or old.state is distinct from 'released' then
        raise exception using
          message = 'BILLING_CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE',
          errcode = '55000';
      end if;
    end if;
  else
    raise exception 'CREDIT_RELEASE_GUARD_TABLE_UNSUPPORTED';
  end if;
  return new;
end;
$reject_unverified_credit_reservation_release$;

revoke all on function executive_visuals.reject_unverified_credit_reservation_release()
  from public, anon, authenticated, service_role;

drop trigger if exists ev_credit_reservations_require_no_charge_evidence
  on executive_visuals.credit_reservations;
create trigger ev_credit_reservations_require_no_charge_evidence
before insert or update of status on executive_visuals.credit_reservations
for each row
execute function executive_visuals.reject_unverified_credit_reservation_release();

drop trigger if exists ev_billing_credit_reservations_require_no_charge_evidence
  on executive_visuals.billing_credit_reservations;
create trigger ev_billing_credit_reservations_require_no_charge_evidence
before insert or update of state on executive_visuals.billing_credit_reservations
for each row
execute function executive_visuals.reject_unverified_credit_reservation_release();

comment on function executive_visuals.reject_unverified_credit_reservation_release() is
  'Fail-closed guard: blocks reservation release until a separately reviewed provider-verifiable no-charge evidence path exists.';

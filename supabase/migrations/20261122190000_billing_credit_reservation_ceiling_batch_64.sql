-- Batch 64: a provider's actual customer-credit charge may never exceed
-- the amount reserved at customer approval. Any overrun requires a fresh
-- customer approval and a new reservation; do not silently overdraw the wallet.

do $migration$
begin
  if exists (
    select 1
    from executive_visuals.billing_credit_reservations
    where actual_credits is not null
      and actual_credits > reserved_credits
  ) then
    raise exception using
      errcode = '23514',
      message = 'Existing generation credit settlements exceed their approved reservations; reconcile before applying Batch 64.';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'executive_visuals.billing_credit_reservations'::regclass
      and conname = 'billing_credit_actual_within_reservation'
  ) then
    alter table executive_visuals.billing_credit_reservations
      add constraint billing_credit_actual_within_reservation
      check (actual_credits is null or actual_credits <= reserved_credits)
      not valid;
  end if;
end
$migration$;

alter table executive_visuals.billing_credit_reservations
  validate constraint billing_credit_actual_within_reservation;

comment on constraint billing_credit_actual_within_reservation
  on executive_visuals.billing_credit_reservations is
  'Actual customer-credit settlement cannot exceed the approved reservation. Overruns require a new explicit customer approval.';

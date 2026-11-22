-- Batch 77: bridge verified subscription allowances into the generation-credit wallet.
-- Payment finalizers historically write the legacy credit_ledger. Generation jobs
-- consume billing_credit_ledger. This forward-only bridge makes those two paths
-- atomic without replaying historical grants or changing existing balances.
--
-- Existing subscription purchase/renewal finalizers remain the payment authority.
-- The bridge only runs for successful, verified subscription payment grants.

-- Batch 71 already mirrors every verified payment-linked credit_ledger grant
-- into billing_credit_ledger and registers its revenue source. Do not add a
-- second mirror trigger here: that would double-credit subscription customers.

-- The legacy Flutterwave manual-renewal finalizer advances the paid period but
-- did not create a matching credit_ledger purchase_grant. Ensure every verified
-- activation/renewal event has one. Existing Paddle/Pesapal/Flutterwave purchase
-- grants are detected and left untouched; the existing Batch 71 payment-ledger
-- trigger then bridges any newly inserted source grant to the generation wallet.
create or replace function executive_visuals.ensure_subscription_period_credit_grant()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $ensure_subscription_period_credit_grant$
declare
  payment_id uuid;
  payment_row executive_visuals.payment_transactions%rowtype;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  grant_row executive_visuals.credit_ledger%rowtype;
  grant_key text;
  period_start timestamptz;
  period_end timestamptz;
begin
  if new.event_type not in ('activated','renewed')
     or new.source not in ('flutterwave','paddle','pesapal') then
    return new;
  end if;

  begin
    payment_id:=nullif(new.event_data->>'payment_id','')::uuid;
  exception when invalid_text_representation then
    raise exception 'SUBSCRIPTION_PERIOD_PAYMENT_REFERENCE_INVALID' using errcode='22023';
  end;
  if payment_id is null then
    raise exception 'SUBSCRIPTION_PERIOD_PAYMENT_REFERENCE_MISSING' using errcode='23514';
  end if;

  select * into payment_row
    from executive_visuals.payment_transactions
   where id=payment_id and owner_id=new.owner_id
   for update;
  if not found
     or payment_row.status<>'successful'
     or payment_row.verified_at is null
     or payment_row.provider<>new.source
     or payment_row.metadata->>'subscription_id'<>new.subscription_id::text then
    raise exception 'SUBSCRIPTION_PERIOD_PAYMENT_NOT_VERIFIED' using errcode='23514';
  end if;

  if (new.event_type='activated' and payment_row.metadata->>'payment_purpose'<>'subscription_purchase')
     or (new.event_type='renewed' and payment_row.metadata->>'payment_purpose'<>'subscription_renewal') then
    raise exception 'SUBSCRIPTION_PERIOD_PAYMENT_PURPOSE_MISMATCH' using errcode='23514';
  end if;

  -- Legacy Flutterwave renewal sets renewal_applied; normalize the marker used
  -- by the shared subscription revenue-source validator after payment verification.
  if new.event_type='renewed'
     and coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) is not true
     and coalesce((payment_row.metadata->>'renewal_applied')::boolean,false) is true then
    update executive_visuals.payment_transactions
       set metadata=metadata||jsonb_build_object('subscription_applied',true),
           updated_at=clock_timestamp()
     where id=payment_row.id;
    payment_row.metadata:=payment_row.metadata||jsonb_build_object('subscription_applied',true);
  end if;

  if coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) is not true then
    raise exception 'SUBSCRIPTION_PERIOD_NOT_APPLIED' using errcode='23514';
  end if;

  select * into subscription_row
    from executive_visuals.customer_subscriptions
   where id=new.subscription_id and owner_id=new.owner_id;
  if not found then
    raise exception 'SUBSCRIPTION_PERIOD_OWNER_MISMATCH' using errcode='42501';
  end if;

  if subscription_row.included_credits<=0 then
    return new;
  end if;

  grant_key:=case when new.event_type='activated'
    then 'subscription-purchase:'||payment_row.id::text
    else 'subscription-renewal:'||payment_row.id::text end;

  select * into grant_row
    from executive_visuals.credit_ledger
   where owner_id=new.owner_id and payment_transaction_id=payment_row.id
     and entry_type='purchase_grant'
   order by created_at desc
   limit 1;

  if found then
    if grant_row.credit_delta<>subscription_row.included_credits
       or grant_row.idempotency_key<>grant_key then
      raise exception 'SUBSCRIPTION_PERIOD_CREDIT_GRANT_CONFLICT' using errcode='23514';
    end if;
    return new;
  end if;

  period_start:=nullif(new.event_data->>'period_start','')::timestamptz;
  period_end:=nullif(new.event_data->>'period_end','')::timestamptz;
  if period_start is null or period_end is null or period_end<=period_start then
    raise exception 'SUBSCRIPTION_PERIOD_DATES_INVALID' using errcode='22023';
  end if;

  insert into executive_visuals.credit_ledger(
    owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,
    reason,metadata
  ) values(
    new.owner_id,'purchase_grant',subscription_row.included_credits,grant_key,
    payment_row.id,
    case when new.event_type='activated'
      then 'Included credits for verified initial subscription purchase'
      else 'Included credits for verified subscription renewal' end,
    jsonb_build_object(
      'subscription_id',subscription_row.id,
      'plan_code',subscription_row.plan_code,
      'period_start',period_start,
      'period_end',period_end,
      'provider',payment_row.provider,
      'source_event_id',new.id,
      'batch','77'
    )
  );

  return new;
end;
$ensure_subscription_period_credit_grant$;

revoke all on function executive_visuals.ensure_subscription_period_credit_grant()
  from public,anon,authenticated,service_role;
drop trigger if exists ev_ensure_subscription_period_credit_grant
  on executive_visuals.subscription_events;
create trigger ev_ensure_subscription_period_credit_grant
  after insert on executive_visuals.subscription_events
  for each row execute function executive_visuals.ensure_subscription_period_credit_grant();

comment on function executive_visuals.ensure_subscription_period_credit_grant()
  is 'Batch 77: ensure verified provider subscription activation and renewal events issue one period allowance, including legacy Flutterwave manual renewals.';

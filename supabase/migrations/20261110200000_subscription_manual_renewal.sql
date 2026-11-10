-- Batch 9: explicit, customer-initiated subscription renewal via existing V4 checkout.
-- No stored payment credentials, automatic debit, or Flutterwave V3 Payment Plans.
-- Renewal periods extend only after server-side V4 transaction verification.

create or replace function executive_visuals.finalize_subscription_renewal(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path=executive_visuals,pg_temp
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  next_period_start timestamptz;
  next_period_end timestamptz;
begin
  if p_payment_id is null
     or nullif(btrim(p_provider_transaction_id),'') is null
     or p_verified_at is null
     or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb)) <> 'object'
     or lower(coalesce(p_provider_payload->>'status','')) <> 'succeeded' then
    raise exception 'Invalid verified subscription renewal input' using errcode='22023';
  end if;

  select * into payment_row
  from payment_transactions
  where id=p_payment_id
  for update;

  if not found then
    raise exception 'Renewal payment not found' using errcode='P0002';
  end if;

  if payment_row.metadata->>'payment_purpose' <> 'subscription_renewal'
     or nullif(payment_row.metadata->>'subscription_id','') is null
     or payment_row.currency <> 'UGX'
     or upper(coalesce(p_provider_payload->>'currency','')) <> payment_row.currency
     or coalesce(p_provider_payload->>'reference','') <> payment_row.tx_ref
     or coalesce((p_provider_payload->>'amount')::numeric,-1) <> payment_row.amount_minor::numeric
     or (payment_row.provider_transaction_id is not null and payment_row.provider_transaction_id <> p_provider_transaction_id) then
    raise exception 'Verified provider payment does not match renewal reservation' using errcode='23514';
  end if;

  if payment_row.status='successful'
     and coalesce((payment_row.metadata->>'renewal_applied')::boolean,false) then
    return jsonb_build_object('paymentId',payment_row.id,'status','successful','idempotentReplay',true);
  end if;
  if payment_row.status <> 'pending' then
    raise exception 'Renewal payment is not pending' using errcode='23514';
  end if;

  select * into subscription_row
  from customer_subscriptions
  where id=(payment_row.metadata->>'subscription_id')::uuid
    and owner_id=payment_row.owner_id
  for update;

  if not found then
    raise exception 'Subscription does not belong to renewal customer' using errcode='42501';
  end if;
  if subscription_row.status not in ('active','past_due')
     or subscription_row.billing_interval not in ('monthly','yearly')
     or subscription_row.currency <> payment_row.currency
     or subscription_row.amount_minor <> payment_row.amount_minor then
    raise exception 'Subscription is not eligible for this renewal payment' using errcode='23514';
  end if;

  next_period_start := greatest(coalesce(subscription_row.current_period_end,now()),now());
  next_period_end := case subscription_row.billing_interval
    when 'monthly' then next_period_start + interval '1 month'
    when 'yearly' then next_period_start + interval '1 year'
    else null
  end;
  if next_period_end is null or next_period_end<=next_period_start then
    raise exception 'Could not calculate subscription renewal period' using errcode='22023';
  end if;

  update payment_transactions
  set status='successful',
      provider_transaction_id=p_provider_transaction_id,
      paid_at=coalesce(paid_at,p_verified_at),
      verified_at=p_verified_at,
      metadata=metadata||jsonb_build_object(
        'renewal_applied',true,
        'renewal_verified_at',p_verified_at,
        'provider_verified_status','succeeded'
      ),
      updated_at=now()
  where id=payment_row.id;

  update customer_subscriptions
  set status='active',
      current_period_start=next_period_start,
      current_period_end=next_period_end,
      grace_until=null,
      updated_at=now()
  where id=subscription_row.id;

  insert into subscription_events(
    subscription_id,owner_id,event_type,source,reason,event_data
  ) values (
    subscription_row.id,subscription_row.owner_id,'renewed','flutterwave',
    'Customer-initiated mobile-money renewal verified by Flutterwave',
    jsonb_build_object(
      'payment_id',payment_row.id,
      'provider_transaction_id',p_provider_transaction_id,
      'amount_minor',payment_row.amount_minor,
      'currency',payment_row.currency,
      'period_start',next_period_start,
      'period_end',next_period_end
    )
  );

  return jsonb_build_object(
    'paymentId',payment_row.id,
    'subscriptionId',subscription_row.id,
    'status','active',
    'periodStart',next_period_start,
    'periodEnd',next_period_end,
    'idempotentReplay',false
  );
end;
$$;

revoke all on function executive_visuals.finalize_subscription_renewal(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.finalize_subscription_renewal(uuid,text,jsonb,timestamptz)
  to service_role;

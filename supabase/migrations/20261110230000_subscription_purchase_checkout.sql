-- Batch 11 extension: first paid subscription checkout and verified activation.
-- Checkout is customer-initiated; no stored credentials or automatic renewals.

create or replace function executive_visuals.finalize_subscription_purchase(
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
  period_end timestamptz;
begin
  if p_payment_id is null or nullif(btrim(p_provider_transaction_id),'') is null
     or p_verified_at is null or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb))<>'object'
     or lower(coalesce(p_provider_payload->>'status',''))<>'succeeded' then
    raise exception 'Invalid verified subscription purchase input' using errcode='22023';
  end if;
  select * into payment_row from payment_transactions where id=p_payment_id for update;
  if not found then raise exception 'Subscription purchase payment not found' using errcode='P0002'; end if;
  if payment_row.metadata->>'payment_purpose'<>'subscription_purchase'
     or nullif(payment_row.metadata->>'subscription_id','') is null
     or upper(coalesce(p_provider_payload->>'currency',''))<>payment_row.currency
     or coalesce(p_provider_payload->>'reference','')<>payment_row.tx_ref
     or coalesce((p_provider_payload->>'amount')::numeric,-1)<>payment_row.amount_minor::numeric
     or (payment_row.provider_transaction_id is not null and payment_row.provider_transaction_id<>p_provider_transaction_id) then
    raise exception 'Verified charge does not match subscription purchase reservation' using errcode='23514';
  end if;
  if payment_row.status='successful' and coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) then
    return jsonb_build_object('paymentId',payment_row.id,'status','successful','idempotentReplay',true);
  end if;
  if payment_row.status<>'pending' then raise exception 'Subscription purchase is not pending' using errcode='23514'; end if;

  select * into subscription_row from customer_subscriptions
    where id=(payment_row.metadata->>'subscription_id')::uuid and owner_id=payment_row.owner_id for update;
  if not found then raise exception 'Subscription does not belong to payment owner' using errcode='42501'; end if;
  if subscription_row.status<>'pending' or subscription_row.amount_minor<>payment_row.amount_minor
     or subscription_row.currency<>payment_row.currency or subscription_row.billing_interval not in ('monthly','yearly') then
    raise exception 'Pending subscription does not match the verified payment' using errcode='23514';
  end if;
  period_end:=case subscription_row.billing_interval
    when 'monthly' then p_verified_at+interval '1 month'
    when 'yearly' then p_verified_at+interval '1 year'
    else null end;
  if period_end is null or period_end<=p_verified_at then
    raise exception 'Could not calculate subscription period' using errcode='22023';
  end if;

  update payment_transactions set status='successful',provider_transaction_id=p_provider_transaction_id,
    paid_at=coalesce(paid_at,p_verified_at),verified_at=p_verified_at,
    metadata=metadata||jsonb_build_object('subscription_applied',true,'subscription_verified_at',p_verified_at),
    updated_at=now() where id=payment_row.id;
  update customer_subscriptions set status='active',provider='flutterwave',
    current_period_start=p_verified_at,current_period_end=period_end,updated_at=now()
    where id=subscription_row.id;
  insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
  values(subscription_row.id,subscription_row.owner_id,'activated','flutterwave',
    'Initial customer subscription activated after verified Flutterwave payment',
    jsonb_build_object('payment_id',payment_row.id,'provider_transaction_id',p_provider_transaction_id,
      'amount_minor',payment_row.amount_minor,'currency',payment_row.currency,
      'period_start',p_verified_at,'period_end',period_end));
  return jsonb_build_object('paymentId',payment_row.id,'subscriptionId',subscription_row.id,
    'status','active','periodStart',p_verified_at,'periodEnd',period_end,'idempotentReplay',false);
end;
$$;

create or replace function executive_visuals.expire_failed_subscription_purchase(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  subscription_id uuid;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
begin
  select * into payment_row from payment_transactions where id=p_payment_id for update;
  if not found then raise exception 'Payment not found' using errcode='P0002'; end if;
  if payment_row.metadata->>'payment_purpose'<>'subscription_purchase' then
    return jsonb_build_object('expired',false,'reason','not_initial_subscription_purchase');
  end if;
  begin
    subscription_id:=(payment_row.metadata->>'subscription_id')::uuid;
  exception when others then
    return jsonb_build_object('expired',false,'reason','invalid_subscription_reference');
  end;
  select * into subscription_row from customer_subscriptions
    where id=subscription_id and owner_id=payment_row.owner_id for update;
  if not found or subscription_row.status<>'pending' then
    return jsonb_build_object('expired',false,'reason','subscription_not_pending');
  end if;
  update customer_subscriptions set status='expired',updated_at=now() where id=subscription_row.id;
  insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
  values(subscription_row.id,subscription_row.owner_id,'payment_failed','system',
    'Initial subscription payment was verified as failed',
    jsonb_build_object('payment_id',payment_row.id,'failure_status',payment_row.status));
  return jsonb_build_object('expired',true,'subscriptionId',subscription_row.id);
end;
$$;

revoke all on function executive_visuals.finalize_subscription_purchase(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
revoke all on function executive_visuals.expire_failed_subscription_purchase(uuid)
  from public,anon,authenticated;
grant execute on function executive_visuals.finalize_subscription_purchase(uuid,text,jsonb,timestamptz)
  to service_role;
grant execute on function executive_visuals.expire_failed_subscription_purchase(uuid)
  to service_role;

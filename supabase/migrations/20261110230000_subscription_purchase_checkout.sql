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


create or replace function executive_visuals.reserve_subscription_purchase(
  p_owner_id uuid,
  p_plan_code text,
  p_customer_email text,
  p_mobile_money_network text,
  p_idempotency_key text,
  p_tx_ref text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  plan_row executive_visuals.subscription_plans%rowtype;
  existing_payment executive_visuals.payment_transactions%rowtype;
  subscription_id uuid;
  payment_id uuid;
begin
  if p_owner_id is null or p_plan_code !~ '^[a-z][a-z0-9_-]{1,63}$'
     or p_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or upper(coalesce(p_mobile_money_network,'')) not in ('MTN','AIRTEL')
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 180
     or p_tx_ref is null or char_length(p_tx_ref) not between 8 and 180 then
    raise exception 'Invalid subscription purchase reservation' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));

  select * into existing_payment from payment_transactions
  where owner_id=p_owner_id and metadata->>'idempotency_key'=p_idempotency_key
  limit 1 for update;
  if found then
    if existing_payment.metadata->>'payment_purpose'<>'subscription_purchase'
       or existing_payment.metadata->>'plan_code'<>p_plan_code
       or existing_payment.metadata->>'mobile_money_network'<>upper(p_mobile_money_network) then
      raise exception 'Idempotency key is already used for another payment' using errcode='23505';
    end if;
    return jsonb_build_object('paymentId',existing_payment.id,
      'subscriptionId',existing_payment.metadata->>'subscription_id',
      'txRef',existing_payment.tx_ref,'amountMinor',existing_payment.amount_minor,
      'currency',existing_payment.currency,'status',existing_payment.status,
      'idempotentReplay',true);
  end if;

  if exists(select 1 from customer_subscriptions
    where owner_id=p_owner_id and status in ('pending','trialing','active','past_due')) then
    raise exception 'Customer already has a current or pending subscription' using errcode='23505';
  end if;
  select * into plan_row from subscription_plans
  where plan_code=p_plan_code and status='active' and is_public=true
    and billing_interval in ('monthly','yearly') and currency='UGX' and amount_minor>0
  for share;
  if not found then raise exception 'Subscription plan is not available for Uganda mobile-money billing' using errcode='22023'; end if;

  insert into customer_subscriptions(
    owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
    included_credits,entitlements_snapshot,provider,customer_email,current_period_start
  ) values(
    p_owner_id,plan_row.id,plan_row.plan_code,plan_row.version,'pending',
    plan_row.billing_interval,plan_row.amount_minor,plan_row.currency,
    plan_row.included_credits,plan_row.entitlements,'flutterwave',lower(p_customer_email),now()
  ) returning id into subscription_id;

  insert into payment_transactions(
    owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,customer_email,description,metadata
  ) values(
    p_owner_id,'flutterwave',p_tx_ref,plan_row.amount_minor,plan_row.currency,'pending',
    'mobile_money',lower(p_customer_email),'Initial subscription purchase',
    jsonb_build_object('payment_purpose','subscription_purchase','subscription_id',subscription_id,
      'plan_code',plan_row.plan_code,'idempotency_key',p_idempotency_key,
      'mobile_money_network',upper(p_mobile_money_network),'billing_interval',plan_row.billing_interval)
  ) returning id into payment_id;

  return jsonb_build_object('paymentId',payment_id,'subscriptionId',subscription_id,
    'txRef',p_tx_ref,'amountMinor',plan_row.amount_minor,'currency',plan_row.currency,
    'status','pending','idempotentReplay',false);
end;
$$;

revoke all on function executive_visuals.reserve_subscription_purchase(uuid,text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function executive_visuals.reserve_subscription_purchase(uuid,text,text,text,text,text)
  to service_role;

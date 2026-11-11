-- Batch 95: prevent idempotency-key reuse across different customer emails.
-- Forward-only replacement; the original checkout migration remains immutable.

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
       or existing_payment.metadata->>'mobile_money_network'<>upper(p_mobile_money_network)
       or lower(coalesce(existing_payment.customer_email,''))<>lower(p_customer_email) then
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

-- Paddle primary + Pesapal secondary subscription billing.
-- Forward-only schema extension. Provider checkout remains disabled until secrets
-- are configured in an isolated staging environment and routes pass sandbox tests.

do $$
declare
  item record;
begin
  for item in
    select c.conname, c.conrelid::regclass as relation
    from pg_constraint c
    where c.contype='c'
      and c.conrelid in (
        'executive_visuals.payment_transactions'::regclass,
        'executive_visuals.payment_refunds'::regclass,
        'executive_visuals.chargeback_cases'::regclass,
        'executive_visuals.payment_webhook_events'::regclass,
        'executive_visuals.payment_reconciliation_runs'::regclass,
        'executive_visuals.customer_subscriptions'::regclass,
        'executive_visuals.subscription_events'::regclass
      )
      and pg_get_constraintdef(c.oid) ilike '%provider%'
  loop
    execute format('alter table %s drop constraint %I',item.relation,item.conname);
  end loop;
end;
$$;

alter table executive_visuals.payment_transactions
  add constraint payment_transactions_provider_check
  check (provider in ('flutterwave','paddle','pesapal'));
alter table executive_visuals.payment_refunds
  add constraint payment_refunds_provider_check
  check (provider in ('flutterwave','paddle','pesapal'));
alter table executive_visuals.chargeback_cases
  add constraint chargeback_cases_provider_check
  check (provider in ('flutterwave','paddle','pesapal'));
alter table executive_visuals.payment_webhook_events
  add constraint payment_webhook_events_provider_check
  check (provider in ('flutterwave','paddle','pesapal'));
alter table executive_visuals.payment_reconciliation_runs
  add constraint payment_reconciliation_runs_provider_check
  check (provider in ('flutterwave','paddle','pesapal'));
alter table executive_visuals.customer_subscriptions
  add constraint customer_subscriptions_provider_check
  check (provider is null or provider in ('flutterwave','paddle','pesapal'));
alter table executive_visuals.subscription_events
  drop constraint if exists subscription_events_source_check;
alter table executive_visuals.subscription_events
  add constraint subscription_events_source_check
  check (source in ('system','flutterwave','paddle','pesapal','admin'));

alter table executive_visuals.customer_subscriptions
  add column if not exists provider_customer_id text,
  add column if not exists provider_price_id text;

create table if not exists executive_visuals.subscription_plan_provider_prices (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references executive_visuals.subscription_plans(id) on delete restrict,
  provider text not null check (provider in ('paddle','pesapal')),
  provider_price_id text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(plan_id,provider),
  check (
    (provider='paddle' and provider_price_id is not null and provider_price_id ~ '^pri_[A-Za-z0-9]+
    or
    (provider='pesapal' and provider_price_id is null and currency='UGX')
  )
);
create unique index if not exists subscription_plan_provider_price_id_uq
  on executive_visuals.subscription_plan_provider_prices(provider,provider_price_id)
  where provider_price_id is not null;
create index if not exists subscription_plan_provider_prices_active_idx
  on executive_visuals.subscription_plan_provider_prices(provider,active,plan_id);

alter table executive_visuals.subscription_plan_provider_prices enable row level security;
revoke all on executive_visuals.subscription_plan_provider_prices from anon,authenticated;
grant all privileges on executive_visuals.subscription_plan_provider_prices to service_role;

create or replace function executive_visuals.reserve_subscription_purchase_for_provider(
  p_owner_id uuid,
  p_plan_code text,
  p_customer_email text,
  p_provider text,
  p_idempotency_key text,
  p_tx_ref text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  plan_row executive_visuals.subscription_plans%rowtype;
  price_row executive_visuals.subscription_plan_provider_prices%rowtype;
  existing_payment executive_visuals.payment_transactions%rowtype;
  subscription_id uuid;
  payment_id uuid;
begin
  if p_owner_id is null
     or p_plan_code !~ '^[a-z][a-z0-9_-]{1,63}$'
     or p_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or lower(coalesce(p_provider,'')) not in ('paddle','pesapal')
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 180
     or p_tx_ref is null or char_length(p_tx_ref) not between 8 and 180 then
    raise exception 'Invalid provider subscription purchase reservation' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));

  select * into existing_payment from payment_transactions
   where owner_id=p_owner_id and metadata->>'idempotency_key'=p_idempotency_key
   limit 1 for update;
  if found then
    if existing_payment.metadata->>'payment_purpose'<>'subscription_purchase'
       or existing_payment.metadata->>'plan_code'<>p_plan_code
       or existing_payment.provider<>lower(p_provider)
       or lower(coalesce(existing_payment.customer_email,''))<>lower(p_customer_email) then
      raise exception 'Idempotency key is already used for another payment' using errcode='23505';
    end if;
    return jsonb_build_object(
      'paymentId',existing_payment.id,
      'subscriptionId',existing_payment.metadata->>'subscription_id',
      'txRef',existing_payment.tx_ref,
      'amountMinor',existing_payment.amount_minor,
      'amountMajor',case when existing_payment.currency='UGX' then existing_payment.amount_minor::numeric
        else existing_payment.amount_minor::numeric/100 end,
      'currency',existing_payment.currency,
      'provider',existing_payment.provider,
      'providerPriceId',existing_payment.metadata->>'provider_price_id',
      'status',existing_payment.status,
      'idempotentReplay',true
    );
  end if;

  if exists(select 1 from customer_subscriptions
    where owner_id=p_owner_id and status in ('pending','trialing','active','past_due')) then
    raise exception 'Customer already has a current or pending subscription' using errcode='23505';
  end if;

  select * into plan_row from subscription_plans
   where plan_code=p_plan_code and status='active' and is_public=true
     and billing_interval in ('monthly','yearly')
   for share;
  if not found then
    raise exception 'Subscription plan is not available' using errcode='22023';
  end if;

  select * into price_row from subscription_plan_provider_prices
   where plan_id=plan_row.id and provider=lower(p_provider) and active=true
   for share;
  if not found then
    raise exception 'Subscription plan has no active price for this payment provider' using errcode='22023';
  end if;

  insert into customer_subscriptions(
    owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
    included_credits,entitlements_snapshot,provider,provider_price_id,customer_email,current_period_start
  ) values(
    p_owner_id,plan_row.id,plan_row.plan_code,plan_row.version,'pending',
    plan_row.billing_interval,price_row.amount_minor,price_row.currency,
    plan_row.included_credits,plan_row.entitlements,lower(p_provider),price_row.provider_price_id,
    lower(p_customer_email),now()
  ) returning id into subscription_id;

  insert into payment_transactions(
    owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,customer_email,description,metadata
  ) values(
    p_owner_id,lower(p_provider),p_tx_ref,price_row.amount_minor,price_row.currency,'pending',
    case when lower(p_provider)='paddle' then 'card' else 'hosted_checkout' end,
    lower(p_customer_email),'Initial subscription purchase',
    jsonb_build_object(
      'payment_purpose','subscription_purchase',
      'subscription_id',subscription_id,
      'plan_code',plan_row.plan_code,
      'idempotency_key',p_idempotency_key,
      'provider',lower(p_provider),
      'provider_price_id',price_row.provider_price_id,
      'billing_interval',plan_row.billing_interval
    )
  ) returning id into payment_id;

  return jsonb_build_object(
    'paymentId',payment_id,'subscriptionId',subscription_id,'txRef',p_tx_ref,
    'amountMinor',price_row.amount_minor,
    'amountMajor',case when price_row.currency='UGX' then price_row.amount_minor::numeric
      else price_row.amount_minor::numeric/100 end,
    'currency',price_row.currency,'provider',lower(p_provider),
    'providerPriceId',price_row.provider_price_id,
    'status','pending','idempotentReplay',false
  );
end;
$$;

create or replace function executive_visuals.finalize_subscription_purchase_for_provider(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  period_end timestamptz;
  provider_name text;
  amount_minor bigint;
  currency_code text;
  reference text;
  provider_subscription_id text;
  provider_customer_id text;
begin
  if p_payment_id is null or nullif(btrim(p_provider_transaction_id),'') is null
     or p_verified_at is null or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb))<>'object'
     or lower(coalesce(p_provider_payload->>'status',''))<>'succeeded' then
    raise exception 'Invalid verified provider subscription purchase input' using errcode='22023';
  end if;

  select * into payment_row from payment_transactions where id=p_payment_id for update;
  if not found then raise exception 'Subscription purchase payment not found' using errcode='P0002'; end if;
  provider_name:=payment_row.provider;
  if provider_name not in ('paddle','pesapal')
     or payment_row.metadata->>'payment_purpose'<>'subscription_purchase'
     or nullif(payment_row.metadata->>'subscription_id','') is null then
    raise exception 'Payment is not a supported provider subscription purchase' using errcode='23514';
  end if;

  begin
    amount_minor:=(p_provider_payload->>'amount_minor')::bigint;
  exception when others then
    raise exception 'Verified provider amount is invalid' using errcode='22023';
  end;
  currency_code:=upper(coalesce(p_provider_payload->>'currency',''));
  reference:=coalesce(p_provider_payload->>'reference','');
  provider_subscription_id:=nullif(p_provider_payload->>'provider_subscription_id','');
  provider_customer_id:=nullif(p_provider_payload->>'provider_customer_id','');

  if amount_minor<>payment_row.amount_minor or currency_code<>payment_row.currency
     or reference<>payment_row.tx_ref
     or (payment_row.provider_transaction_id is not null and payment_row.provider_transaction_id<>p_provider_transaction_id) then
    raise exception 'Verified charge does not match provider subscription reservation' using errcode='23514';
  end if;

  if payment_row.status='successful' and coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) then
    return jsonb_build_object('paymentId',payment_row.id,'status','successful','idempotentReplay',true);
  end if;
  if payment_row.status<>'pending' then
    raise exception 'Provider subscription purchase is not pending' using errcode='23514';
  end if;

  select * into subscription_row from customer_subscriptions
   where id=(payment_row.metadata->>'subscription_id')::uuid and owner_id=payment_row.owner_id
   for update;
  if not found then raise exception 'Subscription does not belong to payment owner' using errcode='42501'; end if;
  if subscription_row.status<>'pending' or subscription_row.amount_minor<>payment_row.amount_minor
     or subscription_row.currency<>payment_row.currency or subscription_row.provider<>provider_name
     or subscription_row.billing_interval not in ('monthly','yearly') then
    raise exception 'Pending subscription does not match verified provider payment' using errcode='23514';
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
    metadata=metadata||jsonb_build_object('subscription_applied',true,'subscription_verified_at',p_verified_at,
      'provider_verification',p_provider_payload),
    updated_at=now()
   where id=payment_row.id;

  if subscription_row.included_credits>0 then
    insert into credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata)
    values(subscription_row.owner_id,'purchase_grant',subscription_row.included_credits,
      'subscription-purchase:'||payment_row.id::text,payment_row.id,
      'Included credits for verified initial subscription purchase',
      jsonb_build_object('subscription_id',subscription_row.id,'plan_code',subscription_row.plan_code,
        'period_start',p_verified_at,'period_end',period_end,'provider',provider_name))
    on conflict(owner_id,idempotency_key) do nothing;
  end if;

  update customer_subscriptions set status='active',
    provider_subscription_id=coalesce(provider_subscription_id,v_provider_subscription_id),
    provider_customer_id=coalesce(provider_customer_id,v_provider_customer_id),
    current_period_start=p_verified_at,current_period_end=period_end,updated_at=now()
   where id=subscription_row.id;

  select current_period_end into period_end from customer_subscriptions where id=subscription_row.id;
  insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
  values(subscription_row.id,subscription_row.owner_id,'activated',provider_name,
    'Initial customer subscription activated after verified provider payment',
    jsonb_build_object('payment_id',payment_row.id,'provider_transaction_id',p_provider_transaction_id,
      'amount_minor',payment_row.amount_minor,'currency',payment_row.currency,
      'period_start',p_verified_at,'period_end',period_end,'provider',provider_name));

  return jsonb_build_object('paymentId',payment_row.id,'subscriptionId',subscription_row.id,
    'status','active','periodStart',p_verified_at,'periodEnd',period_end,'idempotentReplay',false);
end;
$$;

revoke all on function executive_visuals.reserve_subscription_purchase_for_provider(uuid,text,text,text,text,text)
  from public,anon,authenticated;
revoke all on function executive_visuals.finalize_subscription_purchase_for_provider(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.reserve_subscription_purchase_for_provider(uuid,text,text,text,text,text)
  to service_role;
grant execute on function executive_visuals.finalize_subscription_purchase_for_provider(uuid,text,jsonb,timestamptz)
  to service_role;
 and currency in ('USD','EUR','GBP'))
    or
    (provider='pesapal' and provider_price_id is null and currency='UGX')
  )
);
create unique index if not exists subscription_plan_provider_price_id_uq
  on executive_visuals.subscription_plan_provider_prices(provider,provider_price_id)
  where provider_price_id is not null;
create index if not exists subscription_plan_provider_prices_active_idx
  on executive_visuals.subscription_plan_provider_prices(provider,active,plan_id);

alter table executive_visuals.subscription_plan_provider_prices enable row level security;
revoke all on executive_visuals.subscription_plan_provider_prices from anon,authenticated;
grant all privileges on executive_visuals.subscription_plan_provider_prices to service_role;

create or replace function executive_visuals.reserve_subscription_purchase_for_provider(
  p_owner_id uuid,
  p_plan_code text,
  p_customer_email text,
  p_provider text,
  p_idempotency_key text,
  p_tx_ref text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  plan_row executive_visuals.subscription_plans%rowtype;
  price_row executive_visuals.subscription_plan_provider_prices%rowtype;
  existing_payment executive_visuals.payment_transactions%rowtype;
  subscription_id uuid;
  payment_id uuid;
begin
  if p_owner_id is null
     or p_plan_code !~ '^[a-z][a-z0-9_-]{1,63}$'
     or p_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or lower(coalesce(p_provider,'')) not in ('paddle','pesapal')
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 180
     or p_tx_ref is null or char_length(p_tx_ref) not between 8 and 180 then
    raise exception 'Invalid provider subscription purchase reservation' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));

  select * into existing_payment from payment_transactions
   where owner_id=p_owner_id and metadata->>'idempotency_key'=p_idempotency_key
   limit 1 for update;
  if found then
    if existing_payment.metadata->>'payment_purpose'<>'subscription_purchase'
       or existing_payment.metadata->>'plan_code'<>p_plan_code
       or existing_payment.provider<>lower(p_provider)
       or lower(coalesce(existing_payment.customer_email,''))<>lower(p_customer_email) then
      raise exception 'Idempotency key is already used for another payment' using errcode='23505';
    end if;
    return jsonb_build_object(
      'paymentId',existing_payment.id,
      'subscriptionId',existing_payment.metadata->>'subscription_id',
      'txRef',existing_payment.tx_ref,
      'amountMinor',existing_payment.amount_minor,
      'amountMajor',case when existing_payment.currency='UGX' then existing_payment.amount_minor::numeric
        else existing_payment.amount_minor::numeric/100 end,
      'currency',existing_payment.currency,
      'provider',existing_payment.provider,
      'providerPriceId',existing_payment.metadata->>'provider_price_id',
      'status',existing_payment.status,
      'idempotentReplay',true
    );
  end if;

  if exists(select 1 from customer_subscriptions
    where owner_id=p_owner_id and status in ('pending','trialing','active','past_due')) then
    raise exception 'Customer already has a current or pending subscription' using errcode='23505';
  end if;

  select * into plan_row from subscription_plans
   where plan_code=p_plan_code and status='active' and is_public=true
     and billing_interval in ('monthly','yearly')
   for share;
  if not found then
    raise exception 'Subscription plan is not available' using errcode='22023';
  end if;

  select * into price_row from subscription_plan_provider_prices
   where plan_id=plan_row.id and provider=lower(p_provider) and active=true
   for share;
  if not found then
    raise exception 'Subscription plan has no active price for this payment provider' using errcode='22023';
  end if;

  insert into customer_subscriptions(
    owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
    included_credits,entitlements_snapshot,provider,provider_price_id,customer_email,current_period_start
  ) values(
    p_owner_id,plan_row.id,plan_row.plan_code,plan_row.version,'pending',
    plan_row.billing_interval,price_row.amount_minor,price_row.currency,
    plan_row.included_credits,plan_row.entitlements,lower(p_provider),price_row.provider_price_id,
    lower(p_customer_email),now()
  ) returning id into subscription_id;

  insert into payment_transactions(
    owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,customer_email,description,metadata
  ) values(
    p_owner_id,lower(p_provider),p_tx_ref,price_row.amount_minor,price_row.currency,'pending',
    case when lower(p_provider)='paddle' then 'card' else 'hosted_checkout' end,
    lower(p_customer_email),'Initial subscription purchase',
    jsonb_build_object(
      'payment_purpose','subscription_purchase',
      'subscription_id',subscription_id,
      'plan_code',plan_row.plan_code,
      'idempotency_key',p_idempotency_key,
      'provider',lower(p_provider),
      'provider_price_id',price_row.provider_price_id,
      'billing_interval',plan_row.billing_interval
    )
  ) returning id into payment_id;

  return jsonb_build_object(
    'paymentId',payment_id,'subscriptionId',subscription_id,'txRef',p_tx_ref,
    'amountMinor',price_row.amount_minor,
    'amountMajor',case when price_row.currency='UGX' then price_row.amount_minor::numeric
      else price_row.amount_minor::numeric/100 end,
    'currency',price_row.currency,'provider',lower(p_provider),
    'providerPriceId',price_row.provider_price_id,
    'status','pending','idempotentReplay',false
  );
end;
$$;

create or replace function executive_visuals.finalize_subscription_purchase_for_provider(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  period_end timestamptz;
  provider_name text;
  amount_minor bigint;
  currency_code text;
  reference text;
  provider_subscription_id text;
  provider_customer_id text;
begin
  if p_payment_id is null or nullif(btrim(p_provider_transaction_id),'') is null
     or p_verified_at is null or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb))<>'object'
     or lower(coalesce(p_provider_payload->>'status',''))<>'succeeded' then
    raise exception 'Invalid verified provider subscription purchase input' using errcode='22023';
  end if;

  select * into payment_row from payment_transactions where id=p_payment_id for update;
  if not found then raise exception 'Subscription purchase payment not found' using errcode='P0002'; end if;
  provider_name:=payment_row.provider;
  if provider_name not in ('paddle','pesapal')
     or payment_row.metadata->>'payment_purpose'<>'subscription_purchase'
     or nullif(payment_row.metadata->>'subscription_id','') is null then
    raise exception 'Payment is not a supported provider subscription purchase' using errcode='23514';
  end if;

  begin
    amount_minor:=(p_provider_payload->>'amount_minor')::bigint;
  exception when others then
    raise exception 'Verified provider amount is invalid' using errcode='22023';
  end;
  currency_code:=upper(coalesce(p_provider_payload->>'currency',''));
  reference:=coalesce(p_provider_payload->>'reference','');
  provider_subscription_id:=nullif(p_provider_payload->>'provider_subscription_id','');
  provider_customer_id:=nullif(p_provider_payload->>'provider_customer_id','');

  if amount_minor<>payment_row.amount_minor or currency_code<>payment_row.currency
     or reference<>payment_row.tx_ref
     or (payment_row.provider_transaction_id is not null and payment_row.provider_transaction_id<>p_provider_transaction_id) then
    raise exception 'Verified charge does not match provider subscription reservation' using errcode='23514';
  end if;

  if payment_row.status='successful' and coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) then
    return jsonb_build_object('paymentId',payment_row.id,'status','successful','idempotentReplay',true);
  end if;
  if payment_row.status<>'pending' then
    raise exception 'Provider subscription purchase is not pending' using errcode='23514';
  end if;

  select * into subscription_row from customer_subscriptions
   where id=(payment_row.metadata->>'subscription_id')::uuid and owner_id=payment_row.owner_id
   for update;
  if not found then raise exception 'Subscription does not belong to payment owner' using errcode='42501'; end if;
  if subscription_row.status<>'pending' or subscription_row.amount_minor<>payment_row.amount_minor
     or subscription_row.currency<>payment_row.currency or subscription_row.provider<>provider_name
     or subscription_row.billing_interval not in ('monthly','yearly') then
    raise exception 'Pending subscription does not match verified provider payment' using errcode='23514';
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
    metadata=metadata||jsonb_build_object('subscription_applied',true,'subscription_verified_at',p_verified_at,
      'provider_verification',p_provider_payload),
    updated_at=now()
   where id=payment_row.id;

  if subscription_row.included_credits>0 then
    insert into credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata)
    values(subscription_row.owner_id,'purchase_grant',subscription_row.included_credits,
      'subscription-purchase:'||payment_row.id::text,payment_row.id,
      'Included credits for verified initial subscription purchase',
      jsonb_build_object('subscription_id',subscription_row.id,'plan_code',subscription_row.plan_code,
        'period_start',p_verified_at,'period_end',period_end,'provider',provider_name))
    on conflict(owner_id,idempotency_key) do nothing;
  end if;

  update customer_subscriptions set status='active',
    provider_subscription_id=coalesce(provider_subscription_id,v_provider_subscription_id),
    provider_customer_id=coalesce(provider_customer_id,v_provider_customer_id),
    current_period_start=p_verified_at,current_period_end=period_end,updated_at=now()
   where id=subscription_row.id;

  select current_period_end into period_end from customer_subscriptions where id=subscription_row.id;
  insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
  values(subscription_row.id,subscription_row.owner_id,'activated',provider_name,
    'Initial customer subscription activated after verified provider payment',
    jsonb_build_object('payment_id',payment_row.id,'provider_transaction_id',p_provider_transaction_id,
      'amount_minor',payment_row.amount_minor,'currency',payment_row.currency,
      'period_start',p_verified_at,'period_end',period_end,'provider',provider_name));

  return jsonb_build_object('paymentId',payment_row.id,'subscriptionId',subscription_row.id,
    'status','active','periodStart',p_verified_at,'periodEnd',period_end,'idempotentReplay',false);
end;
$$;

revoke all on function executive_visuals.reserve_subscription_purchase_for_provider(uuid,text,text,text,text,text)
  from public,anon,authenticated;
revoke all on function executive_visuals.finalize_subscription_purchase_for_provider(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.reserve_subscription_purchase_for_provider(uuid,text,text,text,text,text)
  to service_role;
grant execute on function executive_visuals.finalize_subscription_purchase_for_provider(uuid,text,jsonb,timestamptz)
  to service_role;


-- Paddle recurring renewals are reserved from a verified subscription ID and
-- completed transaction ID. Pesapal automatic recurring schedules remain off
-- until its recurring IPN flow is separately verified and tested.
create or replace function executive_visuals.reserve_paddle_subscription_renewal(
  p_owner_id uuid,
  p_provider_subscription_id text,
  p_provider_transaction_id text,
  p_idempotency_key text,
  p_tx_ref text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  existing_payment executive_visuals.payment_transactions%rowtype;
  price_row executive_visuals.subscription_plan_provider_prices%rowtype;
  payment_id uuid;
begin
  if p_owner_id is null
     or p_provider_subscription_id !~ '^sub_[a-z0-9]{26}$'
     or p_provider_transaction_id !~ '^txn_[a-z0-9]{26}$'
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 180
     or p_tx_ref is null or char_length(p_tx_ref) not between 8 and 180 then
    raise exception 'Invalid Paddle subscription renewal reservation' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));

  select * into existing_payment from payment_transactions
   where provider='paddle' and provider_transaction_id=p_provider_transaction_id
   limit 1 for update;
  if found then
    if existing_payment.owner_id<>p_owner_id
       or existing_payment.metadata->>'provider_subscription_id'<>p_provider_subscription_id then
      raise exception 'Paddle transaction ID is already assigned to another subscription' using errcode='23505';
    end if;
    return jsonb_build_object('paymentId',existing_payment.id,'txRef',existing_payment.tx_ref,
      'amountMinor',existing_payment.amount_minor,'currency',existing_payment.currency,
      'status',existing_payment.status,'idempotentReplay',true);
  end if;

  select * into subscription_row from customer_subscriptions
   where owner_id=p_owner_id and provider='paddle'
     and provider_subscription_id=p_provider_subscription_id
     and status in ('active','past_due') and cancel_at_period_end=false
   for update;
  if not found then
    raise exception 'Active Paddle subscription for renewal was not found' using errcode='P0002';
  end if;

  select * into price_row from subscription_plan_provider_prices
   where plan_id=subscription_row.plan_id and provider='paddle' and active=true
   for share;
  if not found or price_row.provider_price_id is distinct from subscription_row.provider_price_id
     or price_row.amount_minor<>subscription_row.amount_minor
     or price_row.currency<>subscription_row.currency then
    raise exception 'Paddle subscription price no longer matches the active server price' using errcode='23514';
  end if;

  select * into existing_payment from payment_transactions
   where owner_id=p_owner_id and metadata->>'idempotency_key'=p_idempotency_key
   limit 1 for update;
  if found then
    if existing_payment.provider<>'paddle'
       or existing_payment.metadata->>'provider_subscription_id'<>p_provider_subscription_id then
      raise exception 'Paddle renewal idempotency key conflict' using errcode='23505';
    end if;
    return jsonb_build_object('paymentId',existing_payment.id,'txRef',existing_payment.tx_ref,
      'amountMinor',existing_payment.amount_minor,'currency',existing_payment.currency,
      'status',existing_payment.status,'idempotentReplay',true);
  end if;

  insert into payment_transactions(
    owner_id,provider,provider_transaction_id,tx_ref,amount_minor,currency,status,
    payment_method,customer_email,description,metadata
  ) values(
    p_owner_id,'paddle',p_provider_transaction_id,p_tx_ref,price_row.amount_minor,
    price_row.currency,'pending','card',subscription_row.customer_email,
    'Paddle recurring subscription renewal',
    jsonb_build_object('payment_purpose','subscription_renewal',
      'subscription_id',subscription_row.id,'plan_code',subscription_row.plan_code,
      'provider_subscription_id',p_provider_subscription_id,
      'provider_price_id',price_row.provider_price_id,'idempotency_key',p_idempotency_key)
  ) returning id into payment_id;

  return jsonb_build_object('paymentId',payment_id,'subscriptionId',subscription_row.id,
    'txRef',p_tx_ref,'amountMinor',price_row.amount_minor,'currency',price_row.currency,
    'status','pending','idempotentReplay',false);
end;
$$;

create or replace function executive_visuals.finalize_paddle_subscription_renewal(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  period_start timestamptz;
  period_end timestamptz;
  amount_minor bigint;
begin
  if p_payment_id is null or p_provider_transaction_id is null or p_verified_at is null
     or lower(coalesce(p_provider_payload->>'status',''))<>'succeeded'
     or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb))<>'object' then
    raise exception 'Invalid verified Paddle renewal input' using errcode='22023';
  end if;

  select * into payment_row from payment_transactions where id=p_payment_id for update;
  if not found or payment_row.provider<>'paddle'
     or payment_row.metadata->>'payment_purpose'<>'subscription_renewal'
     or payment_row.provider_transaction_id<>p_provider_transaction_id then
    raise exception 'Paddle renewal payment reservation not found' using errcode='23514';
  end if;

  begin
    amount_minor:=(p_provider_payload->>'amount_minor')::bigint;
  exception when others then
    raise exception 'Verified Paddle renewal amount is invalid' using errcode='22023';
  end;
  if amount_minor<>payment_row.amount_minor
     or upper(coalesce(p_provider_payload->>'currency',''))<>payment_row.currency
     or coalesce(p_provider_payload->>'reference','')<>payment_row.tx_ref then
    raise exception 'Verified Paddle renewal does not match its reservation' using errcode='23514';
  end if;

  if payment_row.status='successful' and coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) then
    return jsonb_build_object('paymentId',payment_row.id,'status','successful','idempotentReplay',true);
  end if;
  if payment_row.status<>'pending' then
    raise exception 'Paddle renewal payment is not pending' using errcode='23514';
  end if;

  select * into subscription_row from customer_subscriptions
   where id=(payment_row.metadata->>'subscription_id')::uuid
     and owner_id=payment_row.owner_id and provider='paddle'
     and provider_subscription_id=payment_row.metadata->>'provider_subscription_id'
   for update;
  if not found or subscription_row.status not in ('active','past_due') then
    raise exception 'Paddle renewal subscription is not active' using errcode='23514';
  end if;

  period_start:=greatest(coalesce(subscription_row.current_period_end,p_verified_at),p_verified_at);
  period_end:=case subscription_row.billing_interval
    when 'monthly' then period_start+interval '1 month'
    when 'yearly' then period_start+interval '1 year'
    else null end;
  if period_end is null or period_end<=period_start then
    raise exception 'Could not calculate Paddle renewal period' using errcode='22023';
  end if;

  update payment_transactions set status='successful',paid_at=coalesce(paid_at,p_verified_at),
    verified_at=p_verified_at,
    metadata=metadata||jsonb_build_object('subscription_applied',true,
      'subscription_verified_at',p_verified_at,'provider_verification',p_provider_payload),
    updated_at=now()
   where id=payment_row.id;

  if subscription_row.included_credits>0 then
    insert into credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata)
    values(subscription_row.owner_id,'purchase_grant',subscription_row.included_credits,
      'subscription-renewal:'||payment_row.id::text,payment_row.id,
      'Included credits for verified Paddle subscription renewal',
      jsonb_build_object('subscription_id',subscription_row.id,'plan_code',subscription_row.plan_code,
        'period_start',period_start,'period_end',period_end,'provider','paddle'))
    on conflict(owner_id,idempotency_key) do nothing;
  end if;

  update customer_subscriptions set status='active',current_period_start=period_start,
    current_period_end=period_end,grace_until=null,updated_at=now()
   where id=subscription_row.id;

  insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
  values(subscription_row.id,subscription_row.owner_id,'renewed','paddle',
    'Subscription period extended after verified Paddle recurring payment',
    jsonb_build_object('payment_id',payment_row.id,'provider_transaction_id',p_provider_transaction_id,
      'amount_minor',payment_row.amount_minor,'currency',payment_row.currency,
      'period_start',period_start,'period_end',period_end));

  return jsonb_build_object('paymentId',payment_row.id,'subscriptionId',subscription_row.id,
    'status','active','periodStart',period_start,'periodEnd',period_end,'idempotentReplay',false);
end;
$$;

revoke all on function executive_visuals.reserve_paddle_subscription_renewal(uuid,text,text,text,text)
  from public,anon,authenticated;
revoke all on function executive_visuals.finalize_paddle_subscription_renewal(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.reserve_paddle_subscription_renewal(uuid,text,text,text,text)
  to service_role;
grant execute on function executive_visuals.finalize_paddle_subscription_renewal(uuid,text,jsonb,timestamptz)
  to service_role;

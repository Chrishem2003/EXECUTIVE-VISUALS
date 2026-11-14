grant usage on schema executive_visuals to service_role;
insert into auth.users(id,email) values
 ('33333333-3333-4333-8333-333333333333','paddle-integration@example.com'),
 ('44444444-4444-4444-8444-444444444444','pesapal-integration@example.com')
on conflict(id) do nothing;

insert into executive_visuals.subscription_plan_provider_prices(
  plan_id,provider,provider_price_id,amount_minor,currency,active
)
select id,'paddle','pri_01abcdefghijklmnopqrstuvwx',2500,'USD',true
from executive_visuals.subscription_plans where plan_code='creator-monthly'
on conflict(plan_id,provider) do update set
  provider_price_id=excluded.provider_price_id,amount_minor=excluded.amount_minor,
  currency=excluded.currency,active=true,updated_at=now();

insert into executive_visuals.subscription_plan_provider_prices(
  plan_id,provider,provider_price_id,amount_minor,currency,active
)
select id,'pesapal',null,25000,'UGX',true
from executive_visuals.subscription_plans where plan_code='creator-monthly'
on conflict(plan_id,provider) do update set
  provider_price_id=null,amount_minor=excluded.amount_minor,
  currency=excluded.currency,active=true,updated_at=now();

set role service_role;
do $$
declare
  paddle_owner constant uuid := '33333333-3333-4333-8333-333333333333';
  pesapal_owner constant uuid := '44444444-4444-4444-8444-444444444444';
  paddle_subscription_id uuid;
  pesapal_subscription_id uuid;
  paddle_payment_id uuid;
  pesapal_payment_id uuid;
  paddle_renewal_payment_id uuid;
  pesapal_renewal_payment_id uuid;
  paddle_reference text;
  pesapal_reference text;
  paddle_renewal_reference text;
  pesapal_renewal_reference text;
  result jsonb;
  replay jsonb;
  paddle_subscription_key constant text := 'sub_01abcdefghijklmnopqrstuvwx';
  paddle_customer_key constant text := 'ctm_01abcdefghijklmnopqrstuvwx';
  paddle_initial_tx constant text := 'txn_01abcdefghijklmnopqrstuvwx';
  paddle_renewal_tx constant text := 'txn_02abcdefghijklmnopqrstuvwx';
  period_before timestamptz;
  period_after timestamptz;
  payment_provider_tx text;
  paddle_provider_subscription text;
  paddle_provider_customer text;
  paddle_status text;
begin
  result:=executive_visuals.reserve_subscription_purchase_for_provider(
    paddle_owner,'creator-monthly','paddle-integration@example.com','paddle',
    'paddle-initial-key-0001','EVP-PADDLE-INITIAL-0001'
  );
  if result->>'status'<>'pending' or result->>'provider'<>'paddle'
     or result->>'currency'<>'USD' or (result->>'amountMinor')::bigint<>2500
     or result->>'providerPriceId'<>'pri_01abcdefghijklmnopqrstuvwx' then
    raise exception 'Paddle initial reservation did not use the server-owned provider price';
  end if;
  paddle_subscription_id:=(result->>'subscriptionId')::uuid;
  paddle_payment_id:=(result->>'paymentId')::uuid;
  paddle_reference:=result->>'txRef';

  replay:=executive_visuals.reserve_subscription_purchase_for_provider(
    paddle_owner,'creator-monthly','paddle-integration@example.com','paddle',
    'paddle-initial-key-0001','EVP-PADDLE-INITIAL-0001'
  );
  if (replay->>'paymentId')::uuid<>paddle_payment_id or replay->>'idempotentReplay'<>'true' then
    raise exception 'Paddle initial checkout reservation is not idempotent';
  end if;

  result:=executive_visuals.finalize_subscription_purchase_for_provider(
    paddle_payment_id,paddle_initial_tx,
    jsonb_build_object('status','succeeded','amount_minor',2500,'currency','USD',
      'reference',paddle_reference,'provider_subscription_id',paddle_subscription_key,
      'provider_customer_id',paddle_customer_key),
    now()
  );
  if result->>'status'<>'active' then raise exception 'Verified Paddle initial purchase did not activate'; end if;

  select status,provider_subscription_id,provider_customer_id
    into paddle_status,paddle_provider_subscription,paddle_provider_customer
    from executive_visuals.customer_subscriptions where id=paddle_subscription_id;
  if paddle_status<>'active' or paddle_provider_subscription<>paddle_subscription_key
     or paddle_provider_customer<>paddle_customer_key then
    raise exception 'Paddle provider identity mapping was not persisted';
  end if;

  replay:=executive_visuals.finalize_subscription_purchase_for_provider(
    paddle_payment_id,paddle_initial_tx,
    jsonb_build_object('status','succeeded','amount_minor',2500,'currency','USD',
      'reference',paddle_reference,'provider_subscription_id',paddle_subscription_key,
      'provider_customer_id',paddle_customer_key),
    now()
  );
  if replay->>'idempotentReplay'<>'true' then raise exception 'Paddle initial settlement replay was not idempotent'; end if;

  result:=executive_visuals.reserve_paddle_subscription_renewal(
    paddle_owner,paddle_subscription_key,paddle_renewal_tx,
    'paddle-renewal-key-0001','EVP-PADDLE-RENEWAL-0001'
  );
  if result->>'status'<>'pending' or result->>'currency'<>'USD'
     or (result->>'amountMinor')::bigint<>2500 then
    raise exception 'Paddle recurring renewal reservation is invalid';
  end if;
  paddle_renewal_payment_id:=(result->>'paymentId')::uuid;
  paddle_renewal_reference:=result->>'txRef';
  select current_period_end into period_before
    from executive_visuals.customer_subscriptions where id=paddle_subscription_id;

  result:=executive_visuals.finalize_paddle_subscription_renewal(
    paddle_renewal_payment_id,paddle_renewal_tx,
    jsonb_build_object('status','succeeded','amount_minor',2500,'currency','USD',
      'reference',paddle_renewal_reference),
    now()+interval '1 day'
  );
  if result->>'status'<>'active' then raise exception 'Paddle recurring renewal did not settle'; end if;
  select current_period_end into period_after
    from executive_visuals.customer_subscriptions where id=paddle_subscription_id;
  if period_after<=period_before then raise exception 'Paddle recurring renewal did not extend the period'; end if;

  result:=executive_visuals.apply_paddle_subscription_lifecycle(
    paddle_subscription_key,'subscription.canceled',null,null,false,
    jsonb_build_object('source','postgres-integration','occurred_at',now()::text)
  );
  if result->>'status'<>'cancelled' then raise exception 'Paddle cancellation lifecycle event was not applied'; end if;

  result:=executive_visuals.apply_paddle_subscription_lifecycle(
    paddle_subscription_key,'subscription.resumed',null,null,false,
    jsonb_build_object('source','postgres-integration','occurred_at',(now()-interval '1 day')::text)
  );
  if result->>'stale'<>'true' or result->>'status'<>'cancelled' then
    raise exception 'Out-of-order Paddle resume event incorrectly reverted a newer cancellation';
  end if;
  select status into paddle_status from executive_visuals.customer_subscriptions
    where id=paddle_subscription_id;
  if paddle_status<>'cancelled' then
    raise exception 'Stale Paddle lifecycle event changed the persisted subscription state';
  end if;

  result:=executive_visuals.apply_paddle_subscription_lifecycle(
    paddle_subscription_key,'subscription.resumed',null,null,false,
    '{"source":"postgres-integration"}'::jsonb
  );
  if result->>'needsReview'<>'true' or result->>'reason'<>'event_timestamp_missing' then
    raise exception 'Paddle lifecycle event without occurred_at was not quarantined for review';
  end if;

  result:=executive_visuals.reserve_subscription_purchase_for_provider(
    pesapal_owner,'creator-monthly','pesapal-integration@example.com','pesapal',
    'pesapal-initial-key-0001','EVP-PESAPAL-INITIAL-0001'
  );
  if result->>'status'<>'pending' or result->>'provider'<>'pesapal'
     or result->>'currency'<>'UGX' or (result->>'amountMinor')::bigint<>25000 then
    raise exception 'Pesapal initial reservation did not use the UGX provider price';
  end if;
  pesapal_subscription_id:=(result->>'subscriptionId')::uuid;
  pesapal_payment_id:=(result->>'paymentId')::uuid;
  pesapal_reference:=result->>'txRef';

  result:=executive_visuals.finalize_subscription_purchase_for_provider(
    pesapal_payment_id,'pesapal-initial-transaction',
    jsonb_build_object('status','succeeded','amount_minor',25000,'currency','UGX',
      'reference',pesapal_reference),
    now()
  );
  if result->>'status'<>'active' then raise exception 'Verified Pesapal initial purchase did not activate'; end if;

  result:=executive_visuals.reserve_pesapal_subscription_renewal(
    pesapal_owner,pesapal_subscription_id,'pesapal-renewal-key-0001',
    'EVP-PESAPAL-RENEWAL-0001'
  );
  if result->>'status'<>'pending' or result->>'currency'<>'UGX'
     or (result->>'amountMinor')::bigint<>25000 then
    raise exception 'Pesapal manual renewal reservation is invalid';
  end if;
  pesapal_renewal_payment_id:=(result->>'paymentId')::uuid;
  pesapal_renewal_reference:=result->>'txRef';
  select current_period_end into period_before
    from executive_visuals.customer_subscriptions where id=pesapal_subscription_id;

  result:=executive_visuals.finalize_subscription_renewal_for_provider(
    pesapal_renewal_payment_id,'pesapal-renewal-transaction',
    jsonb_build_object('status','succeeded','amount_minor',25000,'currency','UGX',
      'reference',pesapal_renewal_reference),
    now()+interval '1 day'
  );
  if result->>'status'<>'active' then raise exception 'Verified Pesapal manual renewal did not settle'; end if;
  select current_period_end into period_after
    from executive_visuals.customer_subscriptions where id=pesapal_subscription_id;
  if period_after<=period_before then raise exception 'Pesapal manual renewal did not extend the period'; end if;

  select provider_transaction_id into payment_provider_tx
    from executive_visuals.payment_transactions where id=pesapal_renewal_payment_id;
  if payment_provider_tx<>'pesapal-renewal-transaction' then
    raise exception 'Verified Pesapal renewal transaction ID was not persisted';
  end if;

  replay:=executive_visuals.finalize_subscription_renewal_for_provider(
    pesapal_renewal_payment_id,'pesapal-renewal-transaction',
    jsonb_build_object('status','succeeded','amount_minor',25000,'currency','UGX',
      'reference',pesapal_renewal_reference),
    now()+interval '1 day'
  );
  if replay->>'idempotentReplay'<>'true' then raise exception 'Pesapal manual renewal replay was not idempotent'; end if;

  begin
    perform executive_visuals.reserve_pesapal_subscription_renewal(
      paddle_owner,pesapal_subscription_id,'pesapal-cross-owner-key-0001',
      'EVP-PESAPAL-CROSS-OWNER-0001'
    );
    raise exception 'Cross-owner Pesapal renewal reservation unexpectedly succeeded';
  exception when sqlstate 'P0002' then
    null;
  end;
end;
$$;
reset role;

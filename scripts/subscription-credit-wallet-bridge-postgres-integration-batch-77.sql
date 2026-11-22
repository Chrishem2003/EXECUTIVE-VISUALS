-- Batch 77: verified legacy Flutterwave renewal receives one generation allowance.
reset role;
do $batch77_seed$
declare
  v_owner constant uuid:='77777777-7777-4777-8777-777777777701';
  v_plan constant uuid:='77777777-7777-4777-8777-777777777702';
  v_subscription constant uuid:='77777777-7777-4777-8777-777777777703';
  v_payment constant uuid:='77777777-7777-4777-8777-777777777704';
  v_legacy_grant uuid;
  v_wallet_grant uuid;
  v_balance bigint;
begin
  insert into auth.users(id,email)
  values(v_owner,'batch77-owner@example.invalid')
  on conflict(id) do nothing;

  insert into executive_visuals.subscription_plans(
    id,plan_code,name,version,status,is_public,billing_interval,amount_minor,currency,included_credits,entitlements
  ) values(v_plan,'batch77_creator','Batch 77 test creator',1,'active',false,'monthly',2900,'USD',75,'{}')
  on conflict(id) do nothing;

  insert into executive_visuals.customer_subscriptions(
    id,owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
    included_credits,entitlements_snapshot,provider,customer_email,current_period_start,current_period_end
  ) values(v_subscription,v_owner,v_plan,'batch77_creator',1,'active','monthly',2900,'USD',
    75,'{}','flutterwave','batch77-owner@example.invalid',
    '2026-11-01T00:00:00Z','2026-12-01T00:00:00Z')
  on conflict(id) do nothing;

  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,provider_transaction_id,tx_ref,amount_minor,currency,status,
    customer_email,description,paid_at,verified_at,metadata
  ) values(v_payment,v_owner,'flutterwave','batch77-flw-renewal','batch77-renewal-ref',
    2900,'USD','successful','batch77-owner@example.invalid','Verified manual renewal',
    '2026-12-01T00:00:00Z','2026-12-01T00:00:00Z',
    jsonb_build_object('payment_purpose','subscription_renewal',
      'subscription_id',v_subscription,'renewal_applied',true,'subscription_applied',false))
  on conflict(id) do nothing;

  insert into executive_visuals.subscription_events(
    subscription_id,owner_id,event_type,source,reason,event_data
  ) values(v_subscription,v_owner,'renewed','flutterwave','Batch 77 verified manual renewal',
    jsonb_build_object('payment_id',v_payment,'period_start','2026-12-01T00:00:00Z',
      'period_end','2027-01-01T00:00:00Z'));

  select id into v_legacy_grant from executive_visuals.credit_ledger
   where owner_id=v_owner and payment_transaction_id=v_payment and entry_type='purchase_grant';
  if v_legacy_grant is null then
    raise exception 'Legacy verified renewal did not create its included-credit grant';
  end if;

  select id into v_wallet_grant from executive_visuals.billing_credit_ledger
   where owner_id=v_owner and idempotency_key='payment-credit-ledger:'||v_legacy_grant::text;
  if v_wallet_grant is null then
    raise exception 'Batch 71 payment-ledger mirror did not create the generation-wallet grant';
  end if;

  if not exists(select 1 from executive_visuals.billing_credit_revenue_sources
    where grant_ledger_id=v_wallet_grant and source_type='subscription_allowance'
      and source_reference_id=v_payment and credits_granted=75
      and revenue_status='pending_subscription_split' and allocatable_revenue_minor is null) then
    raise exception 'Subscription allowance source was not registered conservatively';
  end if;

  if (select metadata->>'subscription_applied' from executive_visuals.payment_transactions
      where id=v_payment)<>'true' then
    raise exception 'Legacy renewal marker was not normalized after verification';
  end if;

  -- Repeated lifecycle event delivery must not issue a second allowance.
  insert into executive_visuals.subscription_events(
    subscription_id,owner_id,event_type,source,reason,event_data
  ) values(v_subscription,v_owner,'renewed','flutterwave','Batch 77 duplicate event',
    jsonb_build_object('payment_id',v_payment,'period_start','2026-12-01T00:00:00Z',
      'period_end','2027-01-01T00:00:00Z'));

  if (select count(*) from executive_visuals.credit_ledger
      where owner_id=v_owner and payment_transaction_id=v_payment and entry_type='purchase_grant')<>1 then
    raise exception 'Duplicate lifecycle event issued multiple legacy credit grants';
  end if;
  if (select count(*) from executive_visuals.billing_credit_ledger
      where owner_id=v_owner and idempotency_key='payment-credit-ledger:'||v_legacy_grant::text)<>1 then
    raise exception 'Duplicate lifecycle event issued multiple generation-wallet grants';
  end if;

  select coalesce(sum(amount),0) into v_balance
    from executive_visuals.billing_credit_ledger where owner_id=v_owner;
  if v_balance<>75 then
    raise exception 'Generation wallet balance mismatch: expected 75, got %',v_balance;
  end if;
end
$batch77_seed$;
reset role;

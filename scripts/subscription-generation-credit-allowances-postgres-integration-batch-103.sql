-- Runs after Batch 103 subscription-generation allowance migration in disposable billing PostgreSQL.
grant usage on schema executive_visuals to service_role;
insert into auth.users(id,email) values
 ('33333333-3333-4333-8333-333333333333','generation-credit-owner@example.test'),
 ('44444444-4444-4444-8444-444444444444','generation-credit-failed@example.test'),
 ('55555555-5555-4555-8555-555555555555','generation-credit-admin@example.test'),
 ('66666666-6666-4666-8666-666666666666','generation-credit-unpublished@example.test')
on conflict(id) do nothing;

insert into executive_visuals.subscription_plans(
 id,plan_code,name,version,status,is_public,billing_interval,amount_minor,currency,
 included_credits,entitlements,included_generation_credits,generation_credit_allowance_published
) values
 ('63333333-3333-4333-8333-333333333333','generation-monthly','Generation Monthly',1,'active',true,'monthly',25000,'UGX',0,'{}',4321,true),
 ('64444444-4444-4444-8444-444444444444','generation-pro','Generation Pro',1,'active',true,'monthly',79000,'UGX',0,'{}',7654,true),
 ('65555555-5555-4555-8555-555555555555','generation-unpublished','Generation Unpublished',1,'active',true,'monthly',25000,'UGX',0,'{}',9999,false)
on conflict(plan_code) do nothing;

set role service_role;
do $subscription_generation_credit_assertions$
declare
  initial_reservation jsonb;
  replay_reservation jsonb;
  purchase_result jsonb;
  renewal_result jsonb;
  replay_renewal jsonb;
  failed_reservation jsonb;
  failed_result jsonb;
  admin_subscription uuid;
  subscription_id uuid;
  payment_id uuid;
  renewal_id uuid := '73333333-3333-4333-8333-333333333333';
  failed_payment_id uuid;
  failed_subscription_id uuid;
  available bigint;
  current_allowance bigint;
  scheduled_allowance bigint;
  grant_count integer;
begin
  initial_reservation:=executive_visuals.reserve_subscription_purchase(
    '33333333-3333-4333-8333-333333333333','generation-monthly',
    'generation-credit-owner@example.test','MTN','generation-purchase-001','EVS-GEN-PURCHASE-001'
  );
  subscription_id:=(initial_reservation->>'subscriptionId')::uuid;
  payment_id:=(initial_reservation->>'paymentId')::uuid;
  select included_generation_credits into current_allowance
    from executive_visuals.customer_subscriptions where id=subscription_id;
  if current_allowance<>4321 then
    raise exception 'Published generation allowance was not snapshotted at purchase reservation';
  end if;

  purchase_result:=executive_visuals.finalize_subscription_purchase(
    payment_id,'chg-generation-purchase-001',
    jsonb_build_object('status','succeeded','amount',25000,'currency','UGX','reference','EVS-GEN-PURCHASE-001'),
    now()
  );
  if purchase_result->>'status'<>'active' then
    raise exception 'Verified purchase did not activate generation subscription';
  end if;
  select coalesce(sum(amount),0)::bigint into available
    from executive_visuals.billing_credit_ledger
   where owner_id='33333333-3333-4333-8333-333333333333';
  if available<>4321 then
    raise exception 'Verified initial purchase did not grant exactly 4321 generation credits; got %',available;
  end if;
  select count(*) into grant_count
    from executive_visuals.billing_credit_ledger
   where owner_id='33333333-3333-4333-8333-333333333333'
     and event_type='grant' and amount=4321
     and evidence->>'evidenceType'='verified_subscription_payment'
     and evidence->>'paymentId'=payment_id::text;
  if grant_count<>1 then raise exception 'Initial generation grant evidence was not recorded exactly once'; end if;

  -- A loyalty/access extension changes only the period end; it must not issue a second grant.
  update executive_visuals.customer_subscriptions
     set current_period_end=current_period_end+interval '1 day'
   where id=subscription_id;
  select count(*) into grant_count from executive_visuals.billing_credit_ledger
   where owner_id='33333333-3333-4333-8333-333333333333' and event_type='grant';
  if grant_count<>1 then raise exception 'Period-end extension duplicated the subscription generation grant'; end if;

  replay_reservation:=executive_visuals.reserve_subscription_purchase(
    '33333333-3333-4333-8333-333333333333','generation-monthly',
    'generation-credit-owner@example.test','MTN','generation-purchase-001','EVS-GEN-PURCHASE-REPLAY'
  );
  if (replay_reservation->>'paymentId')::uuid<>payment_id
     or replay_reservation->>'idempotentReplay'<>'true' then
    raise exception 'Subscription purchase reservation replay changed payment identity';
  end if;
  purchase_result:=executive_visuals.finalize_subscription_purchase(
    payment_id,'chg-generation-purchase-001',
    jsonb_build_object('status','succeeded','amount',25000,'currency','UGX','reference','EVS-GEN-PURCHASE-001'),
    now()
  );
  if purchase_result->>'idempotentReplay'<>'true' then
    raise exception 'Verified purchase replay was not idempotent';
  end if;
  select count(*) into grant_count from executive_visuals.billing_credit_ledger
   where owner_id='33333333-3333-4333-8333-333333333333' and event_type='grant';
  if grant_count<>1 then raise exception 'Purchase replay duplicated generation credits'; end if;

  perform executive_visuals.manage_customer_subscription(
    '33333333-3333-4333-8333-333333333333',subscription_id,
    'schedule_plan_change','generation-pro','Batch 103 integration plan change'
  );
  select scheduled_included_generation_credits into scheduled_allowance
    from executive_visuals.customer_subscriptions where id=subscription_id;
  if scheduled_allowance<>7654 then
    raise exception 'Scheduled plan change did not snapshot its future generation allowance';
  end if;

  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,
    customer_email,description,metadata
  ) values(
    renewal_id,'33333333-3333-4333-8333-333333333333','flutterwave',
    'EVS-GEN-RENEWAL-001',79000,'UGX','pending','mobile_money',
    'generation-credit-owner@example.test','Generation subscription renewal',
    jsonb_build_object('payment_purpose','subscription_renewal','subscription_id',subscription_id)
  );
  renewal_result:=executive_visuals.finalize_subscription_renewal(
    renewal_id,'chg-generation-renewal-001',
    jsonb_build_object('status','succeeded','amount',79000,'currency','UGX','reference','EVS-GEN-RENEWAL-001'),
    now()
  );
  if renewal_result->>'status'<>'active' then raise exception 'Verified renewal did not complete'; end if;
  select included_generation_credits into current_allowance
    from executive_visuals.customer_subscriptions where id=subscription_id;
  if current_allowance<>7654 then raise exception 'Renewal did not apply the scheduled generation allowance'; end if;
  select coalesce(sum(amount),0)::bigint into available
    from executive_visuals.billing_credit_ledger
   where owner_id='33333333-3333-4333-8333-333333333333';
  if available<>11975 then
    raise exception 'Renewal did not grant only the new period allowance; expected 11975 total, got %',available;
  end if;
  replay_renewal:=executive_visuals.finalize_subscription_renewal(
    renewal_id,'chg-generation-renewal-001',
    jsonb_build_object('status','succeeded','amount',79000,'currency','UGX','reference','EVS-GEN-RENEWAL-001'),
    now()
  );
  if replay_renewal->>'idempotentReplay'<>'true' then raise exception 'Renewal replay was not idempotent'; end if;
  select count(*) into grant_count from executive_visuals.billing_credit_ledger
   where owner_id='33333333-3333-4333-8333-333333333333' and event_type='grant';
  if grant_count<>2 then raise exception 'Renewal replay duplicated generation credits'; end if;

  failed_reservation:=executive_visuals.reserve_subscription_purchase(
    '44444444-4444-4444-8444-444444444444','generation-monthly',
    'generation-credit-failed@example.test','AIRTEL','generation-failed-001','EVS-GEN-FAILED-001'
  );
  failed_subscription_id:=(failed_reservation->>'subscriptionId')::uuid;
  failed_payment_id:=(failed_reservation->>'paymentId')::uuid;
  update executive_visuals.payment_transactions set status='failed' where id=failed_payment_id;
  failed_result:=executive_visuals.expire_failed_subscription_purchase(failed_payment_id);
  if failed_result->>'expired'<>'true' then raise exception 'Failed subscription payment did not expire'; end if;
  if exists(select 1 from executive_visuals.billing_credit_ledger
    where owner_id='44444444-4444-4444-8444-444444444444') then
    raise exception 'Failed payment unexpectedly granted generation credits';
  end if;

  admin_subscription:='76666666-6666-4666-8666-666666666666';
  insert into executive_visuals.customer_subscriptions(
    id,owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
    included_credits,entitlements_snapshot,provider,current_period_start,current_period_end,
    granted_by,grant_reason
  ) values(
    admin_subscription,'55555555-5555-4555-8555-555555555555',
    '64444444-4444-4444-8444-444444444444','generation-pro',1,'active','monthly',79000,'UGX',
    0,'{}',null,now(),now()+interval '1 month',
    '33333333-3333-4333-8333-333333333333','Batch 103 admin grant integration'
  );
  if not exists(select 1 from executive_visuals.billing_credit_ledger
    where owner_id='55555555-5555-4555-8555-555555555555'
      and amount=7654 and evidence->>'evidenceType'='admin_granted_subscription'
      and evidence->>'subscriptionId'=admin_subscription::text) then
    raise exception 'Admin-granted active subscription did not issue its published generation allowance';
  end if;

  insert into executive_visuals.customer_subscriptions(
    owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
    included_credits,entitlements_snapshot,provider,current_period_start,current_period_end
  ) values(
    '66666666-6666-4666-8666-666666666666',
    '65555555-5555-4555-8555-555555555555','generation-unpublished',1,'active','monthly',25000,'UGX',
    0,'{}',null,now(),now()+interval '1 month'
  );
  if exists(select 1 from executive_visuals.billing_credit_ledger
    where owner_id='66666666-6666-4666-8666-666666666666') then
    raise exception 'Unpublished generation allowance unexpectedly granted credits';
  end if;
  if (select included_generation_credits from executive_visuals.customer_subscriptions
    where owner_id='66666666-6666-4666-8666-666666666666')<>0 then
    raise exception 'Unpublished generation allowance was copied into the customer snapshot';
  end if;

  -- Keep disposable fixtures from contaminating later finance-dashboard assertions.
  update executive_visuals.customer_subscriptions
     set status='expired',updated_at=now()
   where owner_id in (
     '33333333-3333-4333-8333-333333333333',
     '55555555-5555-4555-8555-555555555555',
     '66666666-6666-4666-8666-666666666666'
   ) and status='active';

end;
$subscription_generation_credit_assertions$;
reset role;

select 'Batch 103 subscription generation credit grants passed' as result;

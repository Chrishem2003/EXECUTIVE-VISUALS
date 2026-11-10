grant usage on schema executive_visuals to service_role;
insert into auth.users(id) values('11111111-1111-4111-8111-111111111111');
insert into executive_visuals.subscription_plans(
 plan_code,version,status,is_public,billing_interval,amount_minor,currency,included_credits,entitlements
) values
 ('creator-monthly',1,'active',true,'monthly',25000,'UGX',1000,'{"projects":20,"ai_generation":true}'::jsonb),
 ('pro-yearly',1,'active',true,'yearly',240000,'UGX',20000,'{"projects":200,"ai_generation":true,"collaboration":true}'::jsonb);

set role service_role;
do $$
declare
  owner_id constant uuid := '11111111-1111-4111-8111-111111111111';
  reservation jsonb;
  replay jsonb;
  sub_id uuid;
  payment_id uuid;
  renewal_id uuid := gen_random_uuid();
  result jsonb;
  current_plan text;
  current_amount bigint;
  current_status text;
begin
  reservation := executive_visuals.reserve_subscription_purchase(
    owner_id,'creator-monthly','customer@example.com','MTN','sql-integration-key-01','EVS-SQL-INITIAL-01'
  );
  sub_id := (reservation->>'subscriptionId')::uuid;
  payment_id := (reservation->>'paymentId')::uuid;
  if reservation->>'status'<>'pending' then raise exception 'Initial reservation must be pending'; end if;

  replay := executive_visuals.reserve_subscription_purchase(
    owner_id,'creator-monthly','customer@example.com','MTN','sql-integration-key-01','EVS-SQL-INITIAL-REPLAY'
  );
  if (replay->>'paymentId')::uuid<>payment_id or replay->>'idempotentReplay'<>'true' then
    raise exception 'Initial subscription reservation was not idempotent';
  end if;

  begin
    perform executive_visuals.manage_customer_subscription(owner_id,sub_id,'cancel_immediately',null,'Race guard test');
    raise exception 'Pending subscription payment should block cancellation';
  exception when sqlstate '55000' then
    null;
  end;

  result := executive_visuals.finalize_subscription_purchase(
    payment_id,'chg-sql-initial',
    jsonb_build_object('status','succeeded','amount',25000,'currency','UGX','reference','EVS-SQL-INITIAL-01'),
    now()
  );
  if result->>'status'<>'active' then raise exception 'Verified purchase did not activate subscription'; end if;
  if (select coalesce(sum(credit_delta),0) from executive_visuals.credit_ledger cl where cl.owner_id=owner_id and cl.payment_transaction_id=payment_id)<>1000 then
    raise exception 'Initial subscription included credits were not granted exactly once';
  end if;


  result := executive_visuals.manage_customer_subscription(owner_id,sub_id,'schedule_plan_change','pro-yearly','SQL integration plan change');
  if result->>'scheduledPlanCode'<>'pro-yearly' then raise exception 'Plan change was not scheduled'; end if;

  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,customer_email,description,metadata
  ) values(
    renewal_id,owner_id,'flutterwave','EVR-SQL-RENEWAL-01',240000,'UGX','pending',
    'mobile_money','customer@example.com','Subscription renewal',
    jsonb_build_object('payment_purpose','subscription_renewal','subscription_id',sub_id)
  );
  result := executive_visuals.finalize_subscription_renewal(
    renewal_id,'chg-sql-renewal',
    jsonb_build_object('status','succeeded','amount',240000,'currency','UGX','reference','EVR-SQL-RENEWAL-01'),
    now()
  );
  select plan_code,amount_minor,status into current_plan,current_amount,current_status
    from executive_visuals.customer_subscriptions where id=sub_id;
  if current_plan<>'pro-yearly' or current_amount<>240000 or current_status<>'active' then
    raise exception 'Verified renewal did not atomically apply scheduled plan snapshot';
  end if;
  perform executive_visuals.finalize_subscription_renewal(
    renewal_id,'chg-sql-renewal',
    jsonb_build_object('status','succeeded','amount',240000,'currency','UGX','reference','EVR-SQL-RENEWAL-01'),
    now()
  );
  if (select coalesce(sum(credit_delta),0) from executive_visuals.credit_ledger cl where cl.owner_id=owner_id)<>21000 then
    raise exception 'Renewal did not grant scheduled plan credits exactly once';
  end if;


  perform executive_visuals.manage_customer_subscription(owner_id,sub_id,'cancel_at_period_end',null,'SQL integration scheduled cancellation');
  update executive_visuals.customer_subscriptions set current_period_start=now()-interval '2 days',current_period_end=now()-interval '1 second' where id=sub_id;
  result := executive_visuals.expire_due_subscriptions(100);
  select status into current_status from executive_visuals.customer_subscriptions where id=sub_id;
  if current_status<>'expired' or (result->>'scheduledCancellationsFinalized')::integer<>1 then
    raise exception 'Scheduled cancellation did not finalize at paid period end';
  end if;

  reservation := executive_visuals.reserve_subscription_purchase(
    owner_id,'creator-monthly','customer@example.com','AIRTEL','sql-integration-key-02','EVS-SQL-FAILED-01'
  );
  sub_id := (reservation->>'subscriptionId')::uuid;
  payment_id := (reservation->>'paymentId')::uuid;
  update executive_visuals.payment_transactions set status='failed' where id=payment_id;
  result := executive_visuals.expire_failed_subscription_purchase(payment_id);
  select status into current_status from executive_visuals.customer_subscriptions where id=sub_id;
  if result->>'expired'<>'true' or current_status<>'expired' then
    raise exception 'Failed initial checkout did not release pending subscription slot';
  end if;
end;
$$;
reset role;

\\set ON_ERROR_STOP on

-- Disposable PostgreSQL regression coverage for the repaired refund and payment
-- recovery RPCs. All generated rows are rolled back at the end of this script.
begin;

do $refund_payment_recovery$
declare
  v_owner uuid := gen_random_uuid();
  v_payment uuid := gen_random_uuid();
  v_refund uuid;
  v_refund_replay uuid;
  v_plan uuid := gen_random_uuid();
  v_subscription uuid := gen_random_uuid();
  v_failed_payment uuid := gen_random_uuid();
  v_result jsonb;
  v_grace_until timestamptz;
begin
  if has_function_privilege('anon','executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid)','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid)','EXECUTE') then
    raise exception 'Refund RPC privileges are not service-role only';
  end if;

  insert into auth.users(id,email) values(v_owner,gen_random_uuid()::text||'@integration.invalid');

  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,tx_ref,amount_minor,currency,status,metadata
  ) values(v_payment,v_owner,'flutterwave','REFUND-TEST-'||v_payment::text,1000,'UGX','successful','{}'::jsonb);
  insert into executive_visuals.credit_ledger(
    owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason
  ) values(v_owner,'purchase_grant',100,'refund-test-grant-'||v_payment::text,v_payment,'Integration credit grant');

  v_refund := executive_visuals.reserve_payment_refund(
    v_owner,v_payment,500,'UGX','Integration refund','refund-test-key-0001',null
  );
  v_refund_replay := executive_visuals.reserve_payment_refund(
    v_owner,v_payment,500,'UGX','Integration refund','refund-test-key-0001',null
  );
  if v_refund is distinct from v_refund_replay then
    raise exception 'Refund reservation replay did not return the original ID';
  end if;

  v_result := executive_visuals.finalize_payment_refund(
    v_refund,'provider-refund-test','succeeded','{"status":"succeeded"}'::jsonb
  );
  if (v_result->>'creditReversalDelta')::bigint <> 50 then
    raise exception 'Refund credit reversal allocation mismatch: %',v_result;
  end if;
  v_result := executive_visuals.finalize_payment_refund(
    v_refund,'provider-refund-test','succeeded','{"status":"succeeded"}'::jsonb
  );
  if v_result->>'idempotentReplay' <> 'true' then
    raise exception 'Refund finalization replay was not idempotent';
  end if;
  if (select coalesce(sum(credit_delta),0) from executive_visuals.credit_ledger
      where payment_transaction_id=v_payment and entry_type='refund_reversal') <> -50 then
    raise exception 'Refund ledger contains an incorrect or duplicate reversal';
  end if;

  begin
    perform executive_visuals.reserve_payment_refund(
      v_owner,v_payment,600,'UGX','Excess refund','refund-test-key-0002',null
    );
    raise exception 'Over-refund was unexpectedly accepted';
  exception when invalid_parameter_value then
    null;
  end;

  insert into executive_visuals.subscription_plans(
    id,plan_code,name,version,status,is_public,billing_interval,amount_minor,currency,included_credits,entitlements
  ) values(v_plan,'recovery-test-'||v_plan::text,'Recovery integration',1,'active',false,'monthly',1000,'UGX',100,
    '{"ai_generation":true}'::jsonb);
  insert into executive_visuals.customer_subscriptions(
    id,owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
    included_credits,entitlements_snapshot,current_period_start,current_period_end
  ) values(v_subscription,v_owner,v_plan,'recovery-test-'||v_plan::text,1,'active','monthly',1000,'UGX',100,
    '{"ai_generation":true}'::jsonb,now(),now()+interval '30 days');
  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,tx_ref,amount_minor,currency,status,metadata
  ) values(v_failed_payment,v_owner,'flutterwave','RECOVERY-TEST-'||v_failed_payment::text,1000,'UGX','failed',
    jsonb_build_object('subscription_id',v_subscription::text));

  v_result := executive_visuals.record_payment_failure(v_failed_payment,'TEST_DECLINED','Integration decline',0);
  select grace_until into v_grace_until from executive_visuals.customer_subscriptions where id=v_subscription;
  if v_result->>'status' <> 'retry_scheduled' or v_grace_until is null
     or v_grace_until > now()+interval '2 seconds' then
    raise exception 'Payment recovery did not schedule retry and immediate grace expiry: %',v_result;
  end if;

  perform executive_visuals.record_payment_failure(v_failed_payment,'TEST_DECLINED','Repeated integration decline',0);
  if (select count(*) from executive_visuals.payment_attempts where payment_transaction_id=v_failed_payment) <> 1 then
    raise exception 'Repeated payment failure created duplicate retry attempts';
  end if;
  if (select count(*) from executive_visuals.billing_notification_outbox
      where dedupe_key='payment-failed:'||v_failed_payment::text) <> 1 then
    raise exception 'Payment-failure notification was not deduplicated';
  end if;

  v_result := executive_visuals.expire_due_subscriptions(100);
  if (select status from executive_visuals.customer_subscriptions where id=v_subscription) <> 'expired'
     or (v_result->>'expiredCount')::integer <> 1 then
    raise exception 'Grace-period expiry did not transition subscription: %',v_result;
  end if;
end;
$refund_payment_recovery$;

rollback;

grant usage on schema executive_visuals to service_role;
insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222');
insert into executive_visuals.subscription_plans(
 plan_code,version,status,is_public,billing_interval,amount_minor,currency,included_credits,entitlements
) values
 ('creator-monthly',1,'active',true,'monthly',25000,'UGX',1000,'{"projects":20,"ai_generation":true}'::jsonb),
 ('pro-yearly',1,'active',true,'yearly',240000,'UGX',20000,'{"projects":200,"ai_generation":true,"collaboration":true}'::jsonb);

set role service_role;
do $$
declare
  v_owner_id constant uuid := '11111111-1111-4111-8111-111111111111';
  reservation jsonb;
  replay jsonb;
  sub_id uuid;
  payment_id uuid;
  renewal_id uuid := gen_random_uuid();
  result jsonb;
  current_plan text;
  current_amount bigint;
  current_status text;
  rewarded_period_end timestamptz;
  referred_owner constant uuid := '22222222-2222-4222-8222-222222222222';
  referral_code jsonb;
  attribution jsonb;
  referred_reservation jsonb;
  referred_result jsonb;
  referred_subscription_id uuid;
  referred_payment_id uuid;
begin
  reservation := executive_visuals.reserve_subscription_purchase(
    v_owner_id,'creator-monthly','customer@example.com','MTN','sql-integration-key-01','EVS-SQL-INITIAL-01'
  );
  sub_id := (reservation->>'subscriptionId')::uuid;
  payment_id := (reservation->>'paymentId')::uuid;
  if reservation->>'status'<>'pending' then raise exception 'Initial reservation must be pending'; end if;

  replay := executive_visuals.reserve_subscription_purchase(
    v_owner_id,'creator-monthly','customer@example.com','MTN','sql-integration-key-01','EVS-SQL-INITIAL-REPLAY'
  );
  if (replay->>'paymentId')::uuid<>payment_id or replay->>'idempotentReplay'<>'true' then
    raise exception 'Initial subscription reservation was not idempotent';
  end if;

  begin
    perform executive_visuals.manage_customer_subscription(v_owner_id,sub_id,'cancel_immediately',null,'Race guard test');
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
  select current_period_end into rewarded_period_end from executive_visuals.customer_subscriptions where id=sub_id;
  if rewarded_period_end<now()+interval '1 month 29 days'
     or rewarded_period_end>now()+interval '1 month 31 days' then
    raise exception 'First paid subscription did not receive the one-month access extension';
  end if;
  if (select count(*) from executive_visuals.customer_loyalty_rewards where owner_id=v_owner_id and reward_code='first_paid_creator_welcome')<>1 then
    raise exception 'First paid welcome reward was not recorded exactly once';
  end if;
  if (select coalesce(sum(credit_delta),0) from executive_visuals.credit_ledger cl where cl.owner_id=v_owner_id and cl.payment_transaction_id=payment_id)<>1100 then
    raise exception 'Initial subscription credits plus welcome bonus were not granted exactly once';
  end if;


  referral_code:=executive_visuals.create_customer_referral_code(v_owner_id);
  if length(referral_code->>'code')<8 then raise exception 'Creator referral code was not generated'; end if;
  begin
   perform executive_visuals.attribute_customer_referral_code(v_owner_id,referral_code->>'code');
   raise exception 'Self-referral unexpectedly succeeded';
  exception when sqlstate '23514' then null;
  end;
  attribution:=executive_visuals.attribute_customer_referral_code(referred_owner,referral_code->>'code');
  if attribution->>'status'<>'pending' then raise exception 'Referral attribution was not recorded'; end if;
  referred_reservation:=executive_visuals.reserve_subscription_purchase(
   referred_owner,'creator-monthly','referred@example.com','AIRTEL','sql-referral-key-01','EVS-SQL-REFERRAL-01'
  );
  referred_subscription_id:=(referred_reservation->>'subscriptionId')::uuid;
  referred_payment_id:=(referred_reservation->>'paymentId')::uuid;
  referred_result:=executive_visuals.finalize_subscription_purchase(
   referred_payment_id,'chg-sql-referral',
   jsonb_build_object('status','succeeded','amount',25000,'currency','UGX','reference','EVS-SQL-REFERRAL-01'),
   now()
  );
  if referred_result->>'status'<>'active' then raise exception 'Referred creator subscription did not activate'; end if;
  if (select count(*) from executive_visuals.customer_referral_rewards where referral_attribution_id=(select id from executive_visuals.customer_referral_attributions where referred_owner_id=referred_owner))<>2 then
   raise exception 'Double-sided Creator Circle rewards were not issued exactly once';
  end if;
  if (select coalesce(sum(credit_delta),0) from executive_visuals.credit_ledger where owner_id=v_owner_id and idempotency_key like 'creator-referral:%')<>50
   or (select coalesce(sum(credit_delta),0) from executive_visuals.credit_ledger where owner_id=referred_owner and idempotency_key like 'creator-referral:%')<>50 then
   raise exception 'Creator Circle referral credits were not granted to both creators';
  end if;
  if (select status from executive_visuals.customer_referral_attributions where referred_owner_id=referred_owner)<>'converted' then
   raise exception 'Referral attribution did not transition to converted after verified payment';
  end if;

  result := executive_visuals.manage_customer_subscription(v_owner_id,sub_id,'schedule_plan_change','pro-yearly','SQL integration plan change');
  if result->>'scheduledPlanCode'<>'pro-yearly' then raise exception 'Plan change was not scheduled'; end if;

  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,customer_email,description,metadata
  ) values(
    renewal_id,v_owner_id,'flutterwave','EVR-SQL-RENEWAL-01',240000,'UGX','pending',
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
  if (select coalesce(sum(credit_delta),0) from executive_visuals.credit_ledger cl where cl.owner_id=v_owner_id)<>21150 then
    raise exception 'Renewal did not grant scheduled plan credits exactly once';
  end if;


  perform executive_visuals.manage_customer_subscription(v_owner_id,sub_id,'cancel_at_period_end',null,'SQL integration scheduled cancellation');
  update executive_visuals.customer_subscriptions set current_period_start=now()-interval '2 days',current_period_end=now()-interval '1 second' where id=sub_id;
  result := executive_visuals.expire_due_subscriptions(100);
  select status into current_status from executive_visuals.customer_subscriptions where id=sub_id;
  if current_status<>'expired' or (result->>'scheduledCancellationsFinalized')::integer<>1 then
    raise exception 'Scheduled cancellation did not finalize at paid period end';
  end if;

  reservation := executive_visuals.reserve_subscription_purchase(
    v_owner_id,'creator-monthly','customer@example.com','AIRTEL','sql-integration-key-02','EVS-SQL-FAILED-01'
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

-- Batch 12: dashboard aggregates, MRR/ARR, settlement persistence and append-only audit.
insert into executive_visuals.platform_admins(user_id,role,reason)
values('11111111-1111-4111-8111-111111111111','owner','Disposable PostgreSQL integration owner')
on conflict(user_id) do update set role='owner';

update executive_visuals.customer_subscriptions
 set status='active',current_period_start=now()-interval '1 day',current_period_end=now()+interval '29 days'
 where owner_id='11111111-1111-4111-8111-111111111111' and plan_code='pro-yearly';

do $$
declare
 dashboard jsonb;
 mrr bigint;
 arr bigint;
 audit_id uuid;
 settlement jsonb;
 dispute_id uuid;
 evidence jsonb;
begin
 dashboard:=executive_visuals.admin_financial_command_centre(
  '11111111-1111-4111-8111-111111111111',now()-interval '30 days',now(),50
 );
 select (item->>'mrrMinor')::bigint,(item->>'arrMinor')::bigint into mrr,arr
 from jsonb_array_elements(dashboard->'byCurrency') item where item->>'currency'='UGX';
 if mrr<>20000 or arr<>240000 then
  raise exception 'MRR/ARR calculation mismatch: mrr %, arr %',mrr,arr;
 end if;
 if not exists(select 1 from jsonb_array_elements(dashboard->'tiers') t where t->>'plan_code'='pro-yearly') then
  raise exception 'Subscription tier revenue is missing from dashboard';
 end if;
 if not exists(select 1 from jsonb_array_elements(dashboard->'customerProfiles') p
   where p->>'ownerId'='11111111-1111-4111-8111-111111111111'
    and (p->>'realizedLifetimeValueMinor')::bigint=265000) then
  raise exception 'Realized customer lifetime value mismatch';
 end if;

 settlement:=executive_visuals.record_flutterwave_settlement(
  '11111111-1111-4111-8111-111111111111',
  '{"id":"stm_batch12_test","currency":"UGX","gross_amount":265000,"net_amount":264900,"status":"completed","destination":"wallet","charge_count":"0","fees":[{"type":"charge_fee","amount":100}],"processed_date":"2026-11-10T08:00:00Z"}'::jsonb,
  265100,null
 );
 if settlement->>'currency'<>'UGX' or (settlement->>'grossMinor')::bigint<>265000 then
  raise exception 'Settlement import did not preserve provider amounts';
 end if;
 perform executive_visuals.record_flutterwave_settlement(
  '11111111-1111-4111-8111-111111111111',
  '{"id":"stm_batch12_test","currency":"UGX","gross_amount":265000,"net_amount":264900,"status":"completed","destination":"wallet","charge_count":"0","fees":[{"type":"charge_fee","amount":100}],"processed_date":"2026-11-10T08:00:00Z"}'::jsonb,
  265100,null
 );
 if (select count(*) from executive_visuals.financial_reconciliation_exceptions
   where provider_settlement_id='stm_batch12_test' and exception_code='gross_amount_mismatch' and status='open')<>1 then
  raise exception 'Repeated settlement mismatch created duplicate exceptions';
 end if;
 select id into audit_id from executive_visuals.financial_reconciliation_exceptions
  where provider_settlement_id='stm_batch12_test' and exception_code='gross_amount_mismatch' and status='open';
 perform executive_visuals.resolve_financial_reconciliation_exception(
  '11111111-1111-4111-8111-111111111111',audit_id,'resolved','Resolved after confirming test settlement discrepancy'
 );

 insert into executive_visuals.chargeback_cases(owner_id,provider_case_id,amount_minor,currency,reason,status,response_due_at)
 values('11111111-1111-4111-8111-111111111111','cb_batch13_test',265000,'UGX','Integration dispute','open',now()+interval '2 days')
 returning id into dispute_id;
 evidence:=executive_visuals.upsert_financial_dispute_evidence(
  '11111111-1111-4111-8111-111111111111',dispute_id,'payment_receipt','uploaded',
  'private-disputes/cb_batch13_test/receipt.pdf','Provider receipt attached','Attach verified provider receipt'
 );
 if evidence->>'status'<>'uploaded' or evidence->>'owner_id'<>'11111111-1111-4111-8111-111111111111' then
  raise exception 'Dispute evidence was not stored against the correct customer';
 end if;
 begin
  perform executive_visuals.upsert_financial_dispute_evidence(
   '11111111-1111-4111-8111-111111111111',dispute_id,'service_delivery','uploaded',
   'https://unsafe.example/evidence.pdf','Unsafe URL','Reject external evidence URLs'
  );
  raise exception 'External evidence URL unexpectedly accepted';
 exception when sqlstate '22023' then null;
 end;
 evidence:=executive_visuals.upsert_financial_dispute_evidence(
  '11111111-1111-4111-8111-111111111111',dispute_id,'payment_receipt','verified',
  'private-disputes/cb_batch13_test/receipt.pdf','Provider receipt checked','Verify receipt against provider transaction'
 );
 if evidence->>'status'<>'verified' then raise exception 'Evidence verification status was not saved'; end if;

 audit_id:=executive_visuals.write_financial_admin_audit(
  '11111111-1111-4111-8111-111111111111','finance.test.audit','integration_test','batch-12',
  'Verify append-only financial audit'
 );
 begin
  update executive_visuals.financial_admin_audit set reason='tampered' where id=audit_id;
  raise exception 'Financial audit update unexpectedly succeeded';
 exception when sqlstate '42501' then null;
 end;
end $$;


do $
declare
  v_owner constant uuid := '11111111-1111-4111-8111-111111111111';
  event_result jsonb;
  summary_result jsonb;
  health_result jsonb;
  i integer;
begin
  for i in 1..5 loop
    event_result:=executive_visuals.record_customer_success_event(v_owner,'session_started','batch16-session-'||i);
  end loop;
  perform executive_visuals.record_customer_success_event(v_owner,'project_created','batch16-project-first');
  perform executive_visuals.record_customer_success_event(v_owner,'render_completed','batch16-render-first');
  perform executive_visuals.record_customer_success_event(v_owner,'asset_uploaded','batch16-asset-first');
  perform executive_visuals.record_customer_success_event(v_owner,'workflow_completed','batch16-workflow-first');
  event_result:=executive_visuals.record_customer_success_event(v_owner,'render_completed','batch16-render-first');
  if event_result->>'duplicate'<>'true' then
    raise exception 'Customer-success event idempotency did not reject a duplicate event';
  end if;
  summary_result:=executive_visuals.customer_success_summary(v_owner);
  if (summary_result->>'completedCount')::integer<>5
   or (summary_result->>'points')::integer<>85 then
    raise exception 'Creator milestone awards or points were not calculated correctly: %',summary_result;
  end if;
  health_result:=executive_visuals.customer_success_health_for_owner(v_owner);
  if (health_result->>'score')::integer<75
   or health_result->>'riskLevel'<>'healthy' then
    raise exception 'Customer health score did not reflect verified engagement milestones: %',health_result;
  end if;
  if (select count(*) from executive_visuals.customer_success_activity_events
      where owner_id=v_owner and event_key='batch16-render-first')<>1 then
    raise exception 'Duplicate product events were stored more than once';
  end if;
end $;

reset role;

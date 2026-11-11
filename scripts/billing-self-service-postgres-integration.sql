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
    perform executive_visuals.reserve_subscription_purchase(
      v_owner_id,'creator-monthly','different@example.com','MTN',
      'sql-integration-key-01','EVS-SQL-EMAIL-MISMATCH'
    );
    raise exception 'Checkout idempotency key unexpectedly accepted a different customer email';
  exception when sqlstate '23505' then
    null;
  end;

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
 if mrr<>45000 or arr<>540000 then
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


do $$
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
end $$;


do $$
declare
 v_owner constant uuid := '11111111-1111-4111-8111-111111111111';
 experiment_result jsonb;
 assignment_one jsonb;
 assignment_two jsonb;
 intervention_result jsonb;
 intervention_update jsonb;
 growth_result jsonb;
begin
 experiment_result:=executive_visuals.customer_growth_create_experiment(
  v_owner,'batch17-onboarding-test','Guided onboarding experiment',
  'A guided first project increases activation and first value completion.',
  'activation_rate',
  '[{"key":"control","label":"Standard onboarding"},{"key":"guided","label":"Guided onboarding"}]'::jsonb,
  now()-interval '1 hour',now()+interval '7 days'
 );
 if experiment_result->>'status'<>'draft' then
  raise exception 'New growth experiment should begin in draft status: %',experiment_result;
 end if;
 perform executive_visuals.customer_growth_set_experiment_status(
  v_owner,(experiment_result->>'id')::uuid,'running'
 );
 assignment_one:=executive_visuals.customer_growth_assign_experiment(v_owner,'batch17-onboarding-test');
 assignment_two:=executive_visuals.customer_growth_assign_experiment(v_owner,'batch17-onboarding-test');
 if assignment_one->>'assigned'<>'true'
  or assignment_one->>'variant' not in('control','guided')
  or assignment_two->>'variant'<>assignment_one->>'variant'
  or assignment_two->>'existing'<>'true' then
  raise exception 'Experiment assignment must be stable and idempotent: %, %',assignment_one,assignment_two;
 end if;
 intervention_result:=executive_visuals.customer_growth_record_intervention(
  v_owner,v_owner,'renewal_checkin','Check that the creator reached first value before renewal.'
 );
 intervention_update:=executive_visuals.customer_growth_update_intervention(
  v_owner,(intervention_result->>'id')::uuid,'completed','renewed'
 );
 if intervention_update->>'status'<>'completed'
  or intervention_update->>'outcome'<>'renewed' then
  raise exception 'Intervention outcome was not recorded: %',intervention_update;
 end if;
 growth_result:=executive_visuals.customer_growth_admin_overview();
 if not (growth_result ? 'cohorts')
  or not (growth_result ? 'renewalWatchlist')
  or not (growth_result ? 'cancellationReasons')
  or not (growth_result ? 'experiments') then
  raise exception 'Growth overview omitted required sections: %',growth_result;
 end if;
 if jsonb_array_length(growth_result->'experiments')<1 then
  raise exception 'Growth overview did not include the active experiment';
 end if;
end $$;

do $$
declare
 forecast_result jsonb;
 ugx_row jsonb;
 snapshot_id uuid;
begin
 forecast_result:=executive_visuals.financial_predictive_revenue_overview(
  '11111111-1111-4111-8111-111111111111'
 );
 if forecast_result->>'modelVersion'<>'subscription-scenario-v1'
  or forecast_result->>'sourceWindowDays'<>'180'
  or not (forecast_result ? 'forecastSemantics')
  or jsonb_array_length(forecast_result->'currencies')<1 then
  raise exception 'Predictive revenue overview is missing its model metadata or currency rows: %',forecast_result;
 end if;
 select item into ugx_row from jsonb_array_elements(forecast_result->'currencies') item
 where item->>'currency'='UGX';
 if ugx_row is null then raise exception 'Expected UGX forecast currency row'; end if;
 if jsonb_array_length(ugx_row->'forecast')<>4 then
  raise exception 'Expected 30/60/90/365 day forecast horizons: %',ugx_row->'forecast';
 end if;
 if ugx_row->>'cacAvailability'<>'not_instrumented' then
  raise exception 'CAC must be explicitly unavailable until acquisition costs are instrumented';
 end if;
 if not (ugx_row->'forecast'->0 ? 'conservative')
  or not (ugx_row->'forecast'->0 ? 'base')
  or not (ugx_row->'forecast'->0 ? 'upside') then
  raise exception 'Forecast scenarios are incomplete';
 end if;
 snapshot_id:=(forecast_result->>'snapshotId')::uuid;
 if not exists(select 1 from executive_visuals.financial_forecast_snapshots where id=snapshot_id) then
  raise exception 'Forecast snapshot was not persisted';
 end if;
end $$;

do $batch19$
declare
 snap jsonb; replay jsonb; spend jsonb; attr jsonb; report jsonb; month_start date:=date_trunc('month',now())::date; row_data jsonb;
begin
 snap:=executive_visuals.capture_subscription_revenue_snapshot('11111111-1111-4111-8111-111111111111');
 if coalesce((snap->>'insertedCustomers')::integer,0)<1 then raise exception 'Revenue snapshot did not capture paid customers: %',snap; end if;
 replay:=executive_visuals.capture_subscription_revenue_snapshot('11111111-1111-4111-8111-111111111111');
 if replay->>'alreadyCaptured'<>'true' then raise exception 'Snapshot capture must be idempotent: %',replay; end if;
 spend:=executive_visuals.record_customer_acquisition_spend('11111111-1111-4111-8111-111111111111',month_start,'paid_search','integration-campaign','UGX',120000,'Disposable integration acquisition spend','batch19-acq-spend-0001');
 attr:=executive_visuals.record_customer_acquisition_attribution('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','paid_search','integration-campaign','UGX','paid_campaign',now());
 report:=executive_visuals.financial_revenue_retention_overview('11111111-1111-4111-8111-111111111111');
 select item into row_data from jsonb_array_elements(report->'acquisition') item where item->>'periodMonth'=month_start::text and item->>'currency'='UGX' and item->>'channel'='paid_search';
 if row_data is null or (row_data->>'spendMinor')::bigint<>120000 or (row_data->>'attributedNewCustomers')::integer<1 or (row_data->>'cacMinor')::bigint<>120000 then raise exception 'Acquisition CAC did not reconcile: %',report->'acquisition'; end if;
 if jsonb_array_length(report->'retention')<>0 then raise exception 'Retention comparison must wait for a second real monthly snapshot'; end if;
 -- Controlled prior-month fixture verifies the formulas after the no-backfill assertion.
 insert into executive_visuals.subscription_revenue_snapshots(snapshot_month,owner_id,cohort_month,currency,mrr_minor,subscription_status)
 select (month_start-interval '1 month')::date,owner_id,cohort_month,currency,mrr_minor,subscription_status
 from executive_visuals.subscription_revenue_snapshots
 where snapshot_month=month_start and mrr_minor>0;
 report:=executive_visuals.financial_revenue_retention_overview('11111111-1111-4111-8111-111111111111');
if not exists(select 1 from jsonb_array_elements(report->'retention') item where (item->>'grrPct')::numeric=100 and (item->>'nrrPct')::numeric=100) then
  raise exception 'GRR/NRR cohort calculations did not reconcile for equal opening and ending MRR: %',report->'retention';
 end if;
end $batch19$;

do $batch20$
declare
 v_owner constant uuid:='11111111-1111-4111-8111-111111111111';
 v_customer constant uuid:='22222222-2222-4222-8222-222222222222';
 direct_cost jsonb; replay jsonb; report jsonb; currency_row jsonb; customer_row jsonb; shared_row jsonb;
 original_id uuid; month_start date:=date_trunc('month',now())::date;
begin
 direct_cost:=executive_visuals.record_financial_service_cost(
  v_owner,month_start,v_customer,'ai_inference','provider_usage_export','UGX',1000,
  'batch20-model-invoice','Attributed model inference cost','batch20-direct-cost-0001',null
 );
 original_id:=(direct_cost->>'id')::uuid;
 replay:=executive_visuals.record_financial_service_cost(
  v_owner,month_start,v_customer,'ai_inference','provider_usage_export','UGX',1000,
  'batch20-model-invoice','Attributed model inference cost','batch20-direct-cost-0001',null
 );
 if replay->>'idempotentReplay'<>'true' then raise exception 'Cost evidence replay was not idempotent'; end if;
 perform executive_visuals.record_financial_service_cost(
  v_owner,month_start,v_customer,'ai_inference','provider_invoice','UGX',-200,
  'batch20-provider-credit','Partial provider credit reversal','batch20-direct-reversal-0001',original_id
 );
 perform executive_visuals.record_financial_service_cost(
  v_owner,month_start,null,'storage','cloud_invoice','UGX',3000,
  'batch20-cloud-invoice','Shared platform storage cost','batch20-shared-cost-0001',null
 );
 begin
  perform executive_visuals.record_financial_service_cost(
   v_owner,month_start,v_customer,'ai_inference','provider_invoice','UGX',-900,
   'batch20-over-credit','Invalid excess provider credit','batch20-direct-reversal-over-0001',original_id
  );
  raise exception 'Excess cost reversal unexpectedly succeeded';
 exception when sqlstate '22023' then null;
 end;
 report:=executive_visuals.financial_profitability_overview(v_owner);
 select item into currency_row from jsonb_array_elements(report->'byCurrency') item where item->>'currency'='UGX';
 if currency_row is null or (currency_row->>'directCostMinor')::bigint<>800 then
  raise exception 'Direct costs did not net original expense and reversal: %',report->'byCurrency';
 end if;
 select item into customer_row from jsonb_array_elements(report->'customers') item where item->>'ownerId'=v_customer::text;
 if customer_row is null or (customer_row->>'directCostMinor')::bigint<>800
  or (customer_row->>'grossContributionMinor')::bigint<>(customer_row->>'mrrMinor')::bigint-800
  or (customer_row->>'cacMinor')::bigint<>120000
  or (customer_row->>'cacPaybackMonths') is null then
  raise exception 'Customer contribution, CAC or payback did not reconcile: %',customer_row;
 end if;
 select item into shared_row from jsonb_array_elements(report->'sharedCosts') item
  where item->>'category'='storage' and item->>'currency'='UGX';
 if shared_row is null or (shared_row->>'amountMinor')::bigint<>3000 then
  raise exception 'Shared overhead should be reported separately, not allocated to customer gross margin: %',report->'sharedCosts';
 end if;
 if (customer_row->>'ltvAvailability')<>'no_observed_churn_in_comparison_window' then
  raise exception 'LTV must not be fabricated when the comparison window has no observed churn: %',customer_row;
 end if;
end $batch20$;
reset role;


do $batch22$
declare
 v_actor constant uuid:='11111111-1111-4111-8111-111111111111';
 v_customer constant uuid:='22222222-2222-4222-8222-222222222222';
 v_month date:=date_trunc('month',now())::date;
 v_import jsonb; v_duplicate jsonb; v_reconciled jsonb; v_replay jsonb; v_anomalies jsonb; v_usage jsonb; v_unpriced jsonb; i integer;
begin
 v_usage:=executive_visuals.record_ai_usage_cost_event(
  v_actor,now(),v_customer,null,null,'batch22-video-job-001','runway','gen-4','gen-4',
  'video','succeeded',0,0,0,10,0,'UGX',500,'line-b22-001','batch22-trace-001','batch22-ai-usage-0001'
 );
 if v_usage->>'costBasis'<>'provider_reported' or (v_usage->>'costMinor')::bigint<>500 then
  raise exception 'Provider-reported usage cost was not preserved: %',v_usage;
 end if;
 v_unpriced:=executive_visuals.record_ai_usage_cost_event(
  v_actor,now(),v_customer,null,null,'batch22-image-job-001','unknownprovider','unknown-image-model',null,
  'image','failed',0,0,1,0,0,null,null,'','batch22-trace-002','batch22-ai-usage-0002'
 );
 if v_unpriced->>'costBasis'<>'unpriced' or v_unpriced->>'costMinor' is not null then
  raise exception 'Unknown provider pricing must remain explicitly unpriced: %',v_unpriced;
 end if;
 v_import:=executive_visuals.import_ai_provider_invoice(
  v_actor,'runway','BATCH22-INV-001','UGX',v_month,(v_month+interval '1 month' - interval '1 day')::date,
  500,repeat('a',64),
  jsonb_build_array(jsonb_build_object('lineReference','line-b22-001','provider','runway',
   'currency','UGX','model','gen-4','operation','video','amountMinor',500,'usagePeriod',v_month::text))
 );
 if v_import->>'duplicate'<>'false' or v_import->>'reconciliationStatus'<>'pending' then
  raise exception 'Invoice import did not create pending evidence: %',v_import;
 end if;
 v_duplicate:=executive_visuals.import_ai_provider_invoice(
  v_actor,'runway','BATCH22-INV-001','UGX',v_month,(v_month+interval '1 month' - interval '1 day')::date,
  500,repeat('a',64),
  jsonb_build_array(jsonb_build_object('lineReference','line-b22-001','provider','runway',
   'currency','UGX','model','gen-4','operation','video','amountMinor',500,'usagePeriod',v_month::text))
 );
 if v_duplicate->>'duplicate'<>'true' then raise exception 'Invoice import was not idempotent: %',v_duplicate; end if;
 v_reconciled:=executive_visuals.reconcile_ai_provider_invoice(v_actor,(v_import->>'importId')::uuid);
 if (v_reconciled->>'matched')::integer<>1 or (v_reconciled->>'unmatched')::integer<>0 then
  raise exception 'Exact invoice line did not reconcile to its usage event: %',v_reconciled;
 end if;
 v_replay:=executive_visuals.reconcile_ai_provider_invoice(v_actor,(v_import->>'importId')::uuid);
 if v_replay->>'idempotentReplay'<>'true' then raise exception 'Invoice reconciliation replay was not idempotent: %',v_replay; end if;

 insert into executive_visuals.ai_model_price_catalog(
  provider,model,currency,video_second_minor,effective_from,source_type,source_reference,recorded_by
 ) values('test-provider','test-video-model','USD',25,now()-interval '1 day',
  'admin_verified','batch22-rate-card-test',v_actor);
 v_unpriced:=executive_visuals.record_ai_usage_cost_event(
  v_actor,now(),v_customer,null,null,'batch22-currencyless-usage','test-provider','test-video-model',null,
  'video','succeeded',0,0,0,4,0,null,null,'','batch22-trace-003','batch22-ai-usage-0003'
 );
 if v_unpriced->>'costBasis'<>'unpriced' then
  raise exception 'Rate cards must not infer a currency when none is supplied: %',v_unpriced;
 end if;
 v_usage:=executive_visuals.record_ai_usage_cost_event(
  v_actor,now(),v_customer,null,null,'batch22-priced-usage','test-provider','test-video-model',null,
  'video','succeeded',0,0,0,4,0,'USD',null,'','batch22-trace-004','batch22-ai-usage-0004'
 );
 if v_usage->>'costBasis'<>'catalog_estimate' or (v_usage->>'costMinor')::bigint<>100
  or v_usage->>'currency'<>'USD' then
  raise exception 'Effective-dated model rate card did not calculate expected cost: %',v_usage;
 end if;


 for i in 1..5 loop
  perform executive_visuals.record_ai_usage_cost_event(
   v_actor,(v_month-6+i)::timestamptz,v_customer,null,null,'batch22-spike-baseline-'||i,
   'anomaly-provider','anomaly-model','anomaly-model','video','succeeded',0,0,0,1,0,
   'USD',100,'','batch22-spike-trace-'||i,'batch22-spike-key-'||i
  );
 end loop;
 perform executive_visuals.record_ai_usage_cost_event(
  v_actor,(v_month+1)::timestamptz,v_customer,null,null,'batch22-spike-current',
  'anomaly-provider','anomaly-model','anomaly-model','video','succeeded',0,0,0,1,0,
  'USD',500,'','batch22-spike-trace-current','batch22-spike-key-current'
 );

 v_anomalies:=executive_visuals.ai_cost_anomaly_report(v_actor,v_month,100,2,0.25);
 if jsonb_array_length(v_anomalies->'unpricedUsage')<1 then
  raise exception 'Cost anomaly report must expose unpriced provider/model usage: %',v_anomalies;
 end if;
 if not exists(select 1 from jsonb_array_elements(v_anomalies->'spendAnomalies') item where item->>'type'='spend_spike') then
  raise exception 'Cost anomaly report did not detect a spend spike against five observed baseline days: %',v_anomalies;
 end if;
end $batch22$;

do $batch24$
declare
 v_actor constant uuid:='11111111-1111-4111-8111-111111111111';
 v_customer constant uuid:='22222222-2222-4222-8222-222222222222';
 v_policy jsonb;v_duplicate jsonb;v_evaluation jsonb;v_replay jsonb;v_listing jsonb;
 v_month date:=date_trunc('month',now())::date;
 v_policy_id uuid;
begin
 v_policy:=executive_visuals.add_financial_margin_policy(
  v_actor,'customer',v_customer,'UGX',99.99,null,v_month,null,'batch24-margin-policy-0001'
 );
 v_policy_id:=(v_policy->>'policyId')::uuid;
 v_duplicate:=executive_visuals.add_financial_margin_policy(
  v_actor,'customer',v_customer,'UGX',99.99,null,v_month,null,'batch24-margin-policy-0001'
 );
 if v_duplicate->>'duplicate'<>'true' or v_duplicate->>'policyId'<>v_policy_id::text then
  raise exception 'Margin policy creation must be idempotent: %',v_duplicate;
 end if;
 v_evaluation:=executive_visuals.evaluate_financial_margin_alerts(v_actor);
 if (v_evaluation->>'evaluatedCustomers')::integer<1
  or (v_evaluation->>'policiesApplied')::integer<1
  or (v_evaluation->>'alertsCreated')::integer<1 then
  raise exception 'Low-margin customer did not create a margin protection alert: %',v_evaluation;
 end if;
 v_replay:=executive_visuals.evaluate_financial_margin_alerts(v_actor);
 if (v_replay->>'alertsCreated')::integer<>0 then
  raise exception 'Repeated margin evaluation must not create duplicate alerts: %',v_replay;
 end if;
 v_listing:=executive_visuals.list_financial_margin_alerts(v_actor,25);
 if (v_listing->>'count')::integer<1
  or not exists(select 1 from jsonb_array_elements(v_listing->'alerts') item
   where item->>'ownerId'=v_customer::text and item->>'notificationStatus'='pending') then
  raise exception 'Margin alert list/outbox did not retain the in-app notification: %',v_listing;
 end if;
 if exists(select 1 from executive_visuals.financial_margin_notification_outbox where delivery_status='sent') then
  raise exception 'Margin alert evaluation must not claim external notification delivery';
 end if;
end $batch24$;


-- Batch 25: manually reconcile only exact, verified provider subscription cancellations.
do $batch25$
declare
 v_actor constant uuid:='11111111-1111-4111-8111-111111111111';
 v_customer constant uuid:='22222222-2222-4222-8222-222222222222';
 v_subscription uuid;
 v_mismatch_event uuid:=gen_random_uuid();
 v_email_mismatch_event uuid:=gen_random_uuid();
 v_valid_event uuid:=gen_random_uuid();
 v_result jsonb;
 v_replay jsonb;
begin
 select id into v_subscription
   from executive_visuals.customer_subscriptions
  where owner_id=v_customer and status='active' and provider='flutterwave'
  order by created_at desc limit 1;
 if v_subscription is null then raise exception 'Expected a paid Flutterwave subscription for reconciliation test'; end if;

 update executive_visuals.customer_subscriptions
    set provider_subscription_id='sub-sql-cancellation-01',customer_email='referred@example.com'
  where id=v_subscription;

 insert into executive_visuals.payment_webhook_events(
  id,provider,event_key,event_type,payload_hash,signature_verified,processing_status,payload
 ) values
 (v_mismatch_event,'flutterwave','sql-sub-cancel-mismatch-01','subscription.cancelled',repeat('a',64),true,'needs_review',
  jsonb_build_object('event','subscription.cancelled','data',jsonb_build_object('id','sub-another-customer','customer',jsonb_build_object('email','referred@example.com'),'status','cancelled'))),
 (v_email_mismatch_event,'flutterwave','sql-sub-cancel-email-mismatch','subscription.cancelled',repeat('b',64),true,'needs_review',
  jsonb_build_object('event','subscription.cancelled','data',jsonb_build_object('id','sub-sql-cancellation-01','customer',jsonb_build_object('email','wrong@example.com'),'status','cancelled'))),
 (v_valid_event,'flutterwave','sql-sub-cancel-valid-01','subscription.cancelled',repeat('c',64),true,'needs_review',
  jsonb_build_object('event','subscription.cancelled','data',jsonb_build_object('id','sub-sql-cancellation-01','customer',jsonb_build_object('email','referred@example.com'),'status','cancelled')));

 v_result:=executive_visuals.reconcile_flutterwave_subscription_cancellation(
  v_actor,v_mismatch_event,v_subscription,'Provider subscription ID did not match; retained for review'
 );
 if v_result->>'resolved'<>'false' or v_result->>'reason'<>'provider_subscription_id_mismatch' then
  raise exception 'Mismatched provider subscription must remain in review: %',v_result;
 end if;
 v_result:=executive_visuals.reconcile_flutterwave_subscription_cancellation(
  v_actor,v_email_mismatch_event,v_subscription,'Provider customer email did not match; retained for review'
 );
 if v_result->>'resolved'<>'false' or v_result->>'reason'<>'provider_customer_email_mismatch' then
  raise exception 'Mismatched customer email must remain in review: %',v_result;
 end if;
 if (select status from executive_visuals.customer_subscriptions where id=v_subscription)<>'active' then
  raise exception 'Ambiguous provider callbacks must not change subscription access';
 end if;

 v_result:=executive_visuals.reconcile_flutterwave_subscription_cancellation(
  v_actor,v_valid_event,v_subscription,'Operator verified the exact provider subscription ID and customer email'
 );
 if v_result->>'resolved'<>'true' or v_result->>'idempotentReplay'<>'false' then
  raise exception 'Exact provider cancellation did not resolve: %',v_result;
 end if;
 v_replay:=executive_visuals.reconcile_flutterwave_subscription_cancellation(
  v_actor,v_valid_event,v_subscription,'Operator verified the exact provider subscription ID and customer email'
 );
 if v_replay->>'idempotentReplay'<>'true' then
  raise exception 'Subscription cancellation reconciliation was not idempotent: %',v_replay;
 end if;
 if (select status from executive_visuals.customer_subscriptions where id=v_subscription)<>'cancelled'
   or (select processing_status from executive_visuals.payment_webhook_events where id=v_valid_event)<>'processed'
   or (select count(*) from executive_visuals.subscription_events where subscription_id=v_subscription and event_data->>'webhookEventId'=v_valid_event::text)<>1 then
  raise exception 'Verified subscription cancellation, webhook state and audit event did not commit atomically';
 end if;
end;
$batch25$;


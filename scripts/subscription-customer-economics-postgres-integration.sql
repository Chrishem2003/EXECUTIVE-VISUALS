-- Batch 37: end-to-end customer economics on the disposable billing test database.
reset role;
insert into auth.users(id,email) values
 ('99999999-9999-4999-8999-999999999999','batch37-admin@example.invalid'),
 ('77777777-7777-4777-8777-777777777777','batch37-customer@example.invalid')
on conflict(id) do nothing;
insert into executive_visuals.platform_admins(user_id,role,reason)
values('99999999-9999-4999-8999-999999999999','owner','Batch 37 disposable integration test')
on conflict(user_id) do update set role='owner';
insert into executive_visuals.subscription_plans(
 id,plan_code,name,version,status,is_public,billing_interval,amount_minor,currency,included_credits,entitlements
) values(
 '77777777-7777-4777-8777-777777777778','batch37-pro','Batch 37 Pro',1,'active',true,'monthly',100000,'UGX',10000,'{}'::jsonb
) on conflict(id) do nothing;
insert into executive_visuals.customer_subscriptions(
 id,owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
 included_credits,entitlements_snapshot,current_period_start,current_period_end
) values(
 '77777777-7777-4777-8777-777777777779','77777777-7777-4777-8777-777777777777',
 '77777777-7777-4777-8777-777777777778','batch37-pro',1,'active','monthly',100000,'UGX',10000,'{}'::jsonb,
 date_trunc('month',now()),date_trunc('month',now())+interval '1 month'
) on conflict(id) do nothing;
insert into executive_visuals.subscription_revenue_snapshots(
 snapshot_month,owner_id,cohort_month,currency,mrr_minor,subscription_status
) values(date_trunc('month',now())::date,'77777777-7777-4777-8777-777777777777',
 date_trunc('month',now())::date,'UGX',100000,'active')
on conflict(snapshot_month,owner_id,currency) do update set mrr_minor=excluded.mrr_minor,subscription_status=excluded.subscription_status;
insert into executive_visuals.payment_transactions(
 owner_id,provider,tx_ref,amount_minor,currency,status,paid_at,metadata
) values
 ('77777777-7777-4777-8777-777777777777','flutterwave','batch37-subscription-paid',50000,'UGX','successful',now(),
  jsonb_build_object('payment_purpose','subscription_purchase','subscription_id','77777777-7777-4777-8777-777777777779')),
 ('77777777-7777-4777-8777-777777777777','flutterwave','batch37-other-currency',7000,'USD','successful',now(),
  jsonb_build_object('payment_purpose','subscription_purchase','subscription_id','77777777-7777-4777-8777-777777777779'))
on conflict(provider,tx_ref) do nothing;
insert into executive_visuals.payment_refunds(
 owner_id,payment_transaction_id,provider,amount_minor,currency,status,reason,idempotency_key,completed_at
) select '77777777-7777-4777-8777-777777777777',id,'flutterwave',5000,'UGX','succeeded',
 'Batch 37 refund reporting integration','batch37-refund',now()
 from executive_visuals.payment_transactions where tx_ref='batch37-subscription-paid';
insert into executive_visuals.credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,reason,metadata)
values
 ('77777777-7777-4777-8777-777777777777','purchase_grant',5000,'batch37-credit-grant','Batch 37 subscription credits',
  jsonb_build_object('subscription_id','77777777-7777-4777-8777-777777777779')),
 ('77777777-7777-4777-8777-777777777777','settlement',-125,'batch37-credit-settlement','Batch 37 consumed credits','{}'::jsonb)
on conflict(owner_id,idempotency_key) do nothing;
set role service_role;
do $batch37$
declare
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
 v_owner constant uuid:='77777777-7777-4777-8777-777777777777';
 v_subscription constant uuid:='77777777-7777-4777-8777-777777777779';
 v_month date:=date_trunc('month',now())::date;
 v_cost jsonb;v_telemetry jsonb;v_policy jsonb;v_report jsonb;v_customer jsonb;
begin
 v_cost:=executive_visuals.record_financial_service_cost(
  v_actor,v_month,v_owner,'video_generation','provider_invoice','UGX',20000,
  'batch37-unreconciled-provider-reference','Provider cost intentionally without invoice attribution link',
  'batch37-direct-cost',null
 );
 v_telemetry:=executive_visuals.record_ai_workload_telemetry_event(
  v_actor,now(),v_owner,null,null,'batch37-video-job','openai','video-model','video',
  'provider_response','1080p',null,null,
  '{"outputImageCount":2,"generatedVideoSeconds":12,"retryCount":1}'::jsonb,
  '','',null,'batch37-usage-evidence','batch37-telemetry'
 );
 v_policy:=executive_visuals.add_financial_margin_policy(
  v_actor,'customer',v_owner,'UGX',85,60000,v_month,null,'batch37-customer-margin-policy'
 );
 v_report:=executive_visuals.subscription_customer_economics_report(v_actor,v_month,50);
 select customer.value into v_customer from jsonb_array_elements(v_report->'customers') as customer(value)
 where customer.value->>'ownerId'=v_owner::text;
 if v_customer is null then raise exception 'Batch 37 customer row missing: %',v_report; end if;
 if (v_customer->>'mrrMinor')::bigint<>100000
  or (v_customer->>'directCostMinor')::bigint<>20000
  or (v_customer->>'contributionMinor')::bigint<>80000
  or (v_customer->>'grossMarginPct')::numeric<>80 then
  raise exception 'MRR/direct cost/contribution calculation mismatch: %',v_customer;
 end if;
 if (v_customer->>'cashCollectedMinor')::bigint<>50000
  or (v_customer->>'refundedMinor')::bigint<>5000
  or (v_customer->>'netCashCollectedMinor')::bigint<>45000 then
  raise exception 'Cash receipts/refunds were not kept distinct from MRR or currency: %',v_customer;
 end if;
 if (v_customer->>'subscriptionCreditsGranted')::bigint<>5000
  or (v_customer->>'creditsConsumed')::bigint<>125
  or (v_customer->>'creditLedgerBalanceAtPeriodEnd')::bigint<>4875 then
  raise exception 'Subscription credit accounting mismatch: %',v_customer;
 end if;
 if (v_customer->>'verifiedProviderCostMinor')::bigint<>0
  or (v_customer->>'otherDirectCostMinor')::bigint<>20000 then
  raise exception 'Unlinked provider invoice reference was incorrectly treated as verified cost: %',v_customer;
 end if;
 if (v_customer->>'generatedVideoSeconds')::numeric<>12
  or (v_customer->>'outputImageCount')::numeric<>2
  or v_customer->>'marginStatus'<>'below_configured_margin_policy' then
  raise exception 'Telemetry or configured margin policy was not applied: %',v_customer;
 end if;
 if (v_customer->>'subscriptionIncludedCredits')::bigint<>10000 then
  raise exception 'Subscription entitlement snapshot was not reported: %',v_customer;
 end if;
 if jsonb_array_length(v_report->'byCurrency')<>1
  or (v_report->'byCurrency'->0->>'currency')<>'UGX' then
  raise exception 'Customer economics crossed currency boundaries: %',v_report->'byCurrency';
 end if;
end $batch37$;
reset role;

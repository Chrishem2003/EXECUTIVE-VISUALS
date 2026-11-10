-- Batch 26: measured shared-cost allocation, exact integer reconciliation and profitability reporting.
set role service_role;
do $batch26$
declare
 v_actor constant uuid:='11111111-1111-4111-8111-111111111111';
 v_customer_a constant uuid:='11111111-1111-4111-8111-111111111111';
 v_customer_b constant uuid:='22222222-2222-4222-8222-222222222222';
 v_month date:=date_trunc('month',now())::date;
 v_policy jsonb;
 v_run jsonb;
 v_replay jsonb;
 v_report jsonb;
 v_a bigint;
 v_b bigint;
 v_sum bigint;
 v_lines integer;
begin
 insert into executive_visuals.subscription_revenue_snapshots(
  snapshot_month,owner_id,cohort_month,currency,mrr_minor,subscription_status
 ) values
  (v_month,v_customer_a,v_month,'XTS',10000,'active'),
  (v_month,v_customer_b,v_month,'XTS',20000,'active')
 on conflict(snapshot_month,owner_id,currency) do update
 set mrr_minor=excluded.mrr_minor,subscription_status=excluded.subscription_status;

 perform executive_visuals.record_ai_usage_cost_event(
  v_actor,now()-interval '2 hours',v_customer_a,null,null,'batch26-ai-use-a',
  'openai','gpt-batch26','gpt-batch26','text','succeeded',
  80,20,0,0,0,'XTS',0,'','batch26-trace-a','batch26-ai-usage-a'
 );
 perform executive_visuals.record_ai_usage_cost_event(
  v_actor,now()-interval '1 hour',v_customer_b,null,null,'batch26-ai-use-b',
  'openai','gpt-batch26','gpt-batch26','text','succeeded',
  240,60,0,0,0,'XTS',0,'','batch26-trace-b','batch26-ai-usage-b'
 );
 perform executive_visuals.record_financial_service_cost(
  v_actor,v_month,null,'ai_inference','cloud_invoice','XTS',1001,
  'batch26-shared-inference','Shared inference gateway and platform cost',
  'batch26-shared-inference-cost',null
 );
 v_policy:=executive_visuals.add_financial_shared_cost_allocation_policy(
  v_actor,'ai_inference','inference_tokens','XTS',v_month,null,2,
  'batch26-policy-inference-usd'
 );
 if v_policy->>'duplicate'<>'false' or v_policy->>'driverType'<>'inference_tokens' then
  raise exception 'Measured allocation policy was not created: %',v_policy;
 end if;
 v_run:=executive_visuals.run_financial_shared_cost_allocation(v_actor,v_month,'XTS','ai_inference');
 if v_run->>'status'<>'allocated' or (v_run->>'allocatedMinor')::bigint<>1001
  or (v_run->>'unallocatedMinor')::bigint<>0 or (v_run->>'recipientCount')::integer<>2 then
  raise exception 'Shared inference cost did not allocate to measured recipients: %',v_run;
 end if;
 select amount_minor into v_a from executive_visuals.financial_shared_cost_allocation_lines l
 join executive_visuals.financial_shared_cost_allocation_batches b on b.id=l.batch_id
 where b.period_month=v_month and b.currency='XTS' and b.cost_category='ai_inference'
  and l.owner_id=v_customer_a;
 select amount_minor into v_b from executive_visuals.financial_shared_cost_allocation_lines l
 join executive_visuals.financial_shared_cost_allocation_batches b on b.id=l.batch_id
 where b.period_month=v_month and b.currency='XTS' and b.cost_category='ai_inference'
  and l.owner_id=v_customer_b;
 if v_a<>250 or v_b<>751 then
  raise exception 'Largest-remainder allocation was not deterministic (expected 250/751): % / %',v_a,v_b;
 end if;
 select sum(l.amount_minor)::bigint,count(*)::integer into v_sum,v_lines
 from executive_visuals.financial_shared_cost_allocation_lines l
 join executive_visuals.financial_shared_cost_allocation_batches b on b.id=l.batch_id
 where b.period_month=v_month and b.currency='XTS' and b.cost_category='ai_inference';
 if v_sum<>1001 or v_lines<>2 then
  raise exception 'Allocation lines do not reconcile exactly to the shared cost pool';
 end if;
 v_replay:=executive_visuals.run_financial_shared_cost_allocation(v_actor,v_month,'XTS','ai_inference');
 if v_replay->>'status'<>'already_allocated' or v_replay->>'duplicate'<>'true' then
  raise exception 'Repeated allocation run was not idempotent: %',v_replay;
 end if;
 select count(*) into v_lines from executive_visuals.financial_shared_cost_allocation_batches
 where period_month=v_month and currency='XTS' and cost_category='ai_inference';
 if v_lines<>1 then raise exception 'Repeated run created duplicate allocation batches'; end if;
 v_report:=executive_visuals.financial_profitability_trend_report(v_actor,12);
 if not exists(
  select 1 from jsonb_array_elements(v_report->'periods') p
  where p->>'periodMonth'=v_month::text and p->>'currency'='XTS'
   and (p->>'allocatedSharedCostMinor')::bigint=1001
   and (p->>'fullyLoadedContributionMinor')::bigint=28999
   and (p->>'sharedOverheadAllocated')='true'
 ) then
  raise exception 'Profitability trend did not include fully-loaded measured shared costs: %',v_report;
 end if;
 v_report:=executive_visuals.financial_shared_cost_allocation_overview(v_actor,12);
 if jsonb_array_length(v_report->'batches')<1 or jsonb_array_length(v_report->'customers')<2 then
  raise exception 'Allocation overview did not expose batch and customer-level evidence: %',v_report;
 end if;
 begin
  perform executive_visuals.add_financial_shared_cost_allocation_policy(
   v_actor,'support','inference_tokens','XTS',v_month,null,2,'batch26-invalid-support-policy'
  );
  raise exception 'Unsupported support allocation driver was accepted';
 exception when sqlstate '22023' then null;
 end;
end $batch26$;
reset role;

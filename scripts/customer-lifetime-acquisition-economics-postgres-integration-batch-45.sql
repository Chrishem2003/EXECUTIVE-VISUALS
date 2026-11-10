-- Batch 45: realized/predicted lifetime contribution, channel/campaign CAC and payback.
reset role;
set role service_role;
do $batch45$
declare
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
 v_owner constant uuid:='77777777-7777-4777-8777-777777777777';
 v_month date:=date_trunc('month',now())::date;
 v_prior_month date:=(date_trunc('month',now())-interval '1 month')::date;
 v_spend jsonb;v_spend_replay jsonb;v_attribution jsonb;v_report jsonb;v_customer jsonb;v_campaign jsonb;v_channel jsonb;
 v_snapshot_count integer;
begin
 if not exists(select 1 from executive_visuals.customer_subscriptions where owner_id=v_owner and amount_minor>0) then
  raise exception 'Batch 45 fixture requires the prior Batch 37 paid customer.';
 end if;
 insert into executive_visuals.subscription_revenue_snapshots(
  snapshot_month,owner_id,cohort_month,currency,mrr_minor,subscription_status
 ) values(v_prior_month,v_owner,v_prior_month,'UGX',100000,'active')
 on conflict(snapshot_month,owner_id,currency) do nothing;

 v_spend:=executive_visuals.record_customer_acquisition_spend(
  v_actor,v_prior_month,'search_ads','batch45-q4-launch','UGX',50000,
  'Verified campaign spend for Batch 45 acquisition economics','batch45-acquisition-spend-001'
 );
 v_spend_replay:=executive_visuals.record_customer_acquisition_spend(
  v_actor,v_prior_month,'search_ads','batch45-q4-launch','UGX',50000,
  'Verified campaign spend for Batch 45 acquisition economics','batch45-acquisition-spend-001'
 );
 if v_spend->>'id'<>v_spend_replay->>'id' or v_spend_replay->>'idempotentReplay'<>'true' then
  raise exception 'Campaign spend idempotency did not replay the original evidence: % / %',v_spend,v_spend_replay;
 end if;
 v_attribution:=executive_visuals.record_customer_acquisition_attribution(
  v_actor,v_owner,'search_ads','batch45-q4-launch','UGX','paid_campaign',
  (v_prior_month+interval '5 days')::timestamptz
 );
 select count(*) into v_snapshot_count from executive_visuals.subscription_revenue_snapshots
  where owner_id=v_owner and currency='UGX' and snapshot_month<=v_month;

 v_report:=executive_visuals.customer_lifetime_acquisition_economics_report(v_actor,v_month,100,36);
 select value into v_customer from jsonb_array_elements(v_report->'customers') where value->>'ownerId'=v_owner::text;
 if v_customer is null then raise exception 'Batch 45 customer lifetime row missing: %',v_report; end if;
 if (v_customer->>'realizedContributionToDateMinor')::bigint is distinct from 180000 then
  raise exception 'Realized contribution must sum actual monthly snapshots and direct costs from the paid cohort: %',v_customer;
 end if;
 if (v_customer->>'cacMinor')::bigint is distinct from 50000 then
  raise exception 'Campaign CAC must use same-month spend divided by attributed paid customers: %',v_customer;
 end if;
 if coalesce((v_customer->>'predictedLifetimeContributionMinor')::bigint,0)<=180000 then
  raise exception 'Predicted lifetime contribution must include discounted retained future contribution: %',v_customer;
 end if;
 if coalesce((v_customer->>'ltvCacRatio')::numeric,0)<=3 then
  raise exception 'Retention-adjusted LTV:CAC ratio was not calculated from contribution and CAC: %',v_customer;
 end if;
 if v_customer->>'actualPaybackMonth' is distinct from v_prior_month::text then
  raise exception 'Actual payback must be based on the first observed cumulative contribution recovery month: %',v_customer;
 end if;
 if v_customer->>'forecastConfidence' is distinct from 'low' then
  raise exception 'A single observed retention interval must remain low confidence: %',v_customer;
 end if;
 if v_customer->>'growthQuality' is distinct from 'strong_unit_economics' then
  raise exception 'Growth quality classification did not follow the modeled LTV:CAC evidence: %',v_customer;
 end if;

 select value into v_campaign from jsonb_array_elements(v_report->'campaigns')
  where value->>'campaign'='batch45-q4-launch' and value->>'currency'='UGX';
 if v_campaign is null or (v_campaign->>'spendMinor')::bigint is distinct from 50000
  or (v_campaign->>'attributedNewPaidCustomers')::integer is distinct from 1
  or (v_campaign->>'cacMinor')::bigint is distinct from 50000
  or v_campaign->>'attributionCoverage' is distinct from 'measured' then
  raise exception 'Campaign-level spend, attribution and CAC do not reconcile: %',v_campaign;
 end if;
 select value into v_channel from jsonb_array_elements(v_report->'channels')
  where value->>'channel'='search_ads' and value->>'currency'='UGX';
 if v_channel is null or (v_channel->>'cacMinor')::bigint is distinct from 50000 then
  raise exception 'Channel CAC does not reconcile to campaign evidence: %',v_channel;
 end if;
 if (select count(*) from executive_visuals.subscription_revenue_snapshots
  where owner_id=v_owner and currency='UGX' and snapshot_month<=v_month)<>v_snapshot_count then
  raise exception 'Read-only lifetime report unexpectedly mutated revenue snapshots.';
 end if;
end $batch45$;
reset role;

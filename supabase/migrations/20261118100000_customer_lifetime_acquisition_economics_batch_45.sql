-- Batch 45: realized and modeled customer lifetime contribution, campaign CAC and growth quality.
-- Read-only report over immutable monthly revenue snapshots, cost ledger and acquisition evidence.
create or replace function executive_visuals.customer_lifetime_acquisition_economics_report(
 p_actor_id uuid,p_period_month date default date_trunc('month',now())::date,
 p_discount_rate_bps integer default 100,p_horizon_months integer default 36
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_discount_rate_bps is null or p_discount_rate_bps not between 0 and 5000
  or p_horizon_months is null or p_horizon_months not between 1 and 60 then
  raise exception 'Invalid customer lifetime reporting period or model assumptions' using errcode='22023';
 end if;

 with monthly_costs as(
  select c.period_month,c.owner_id,c.currency,sum(c.amount_minor)::bigint direct_cost_minor
  from financial_service_cost_events c
  where c.owner_id is not null and c.period_month<=p_period_month
  group by c.period_month,c.owner_id,c.currency
 ), monthly_customer as(
  select s.snapshot_month,s.owner_id,s.cohort_month,s.currency,s.mrr_minor,
   coalesce(mc.direct_cost_minor,0)::bigint direct_cost_minor,
   (s.mrr_minor-coalesce(mc.direct_cost_minor,0))::bigint contribution_minor,
   s.subscription_status
  from subscription_revenue_snapshots s
  left join monthly_costs mc on mc.period_month=s.snapshot_month and mc.owner_id=s.owner_id and mc.currency=s.currency
  where s.snapshot_month<=p_period_month
 ), current_customer as(
  select * from monthly_customer where snapshot_month=p_period_month
 ), realized as(
  select owner_id,currency,sum(contribution_minor)::bigint realized_contribution_to_date_minor,
   count(*)::integer observed_months,min(snapshot_month) first_observed_month,
   max(snapshot_month) last_observed_month
  from monthly_customer
  where snapshot_month>=cohort_month
  group by owner_id,currency
 ), spend_campaign as(
  select period_month,currency,channel,campaign,sum(amount_minor)::bigint spend_minor
  from customer_acquisition_spend_events
  where period_month<=p_period_month
  group by period_month,currency,channel,campaign
 ), paid_attributions as(
  select date_trunc('month',a.acquired_at)::date period_month,a.currency,a.channel,a.campaign,
   count(distinct a.owner_id)::integer attributed_new_paid_customers
  from customer_acquisition_attributions a
  where a.acquired_at<p_period_month+interval '1 month'
   and exists(select 1 from customer_subscriptions cs where cs.owner_id=a.owner_id and cs.amount_minor>0)
  group by date_trunc('month',a.acquired_at)::date,a.currency,a.channel,a.campaign
 ), campaign_rows as(
  select coalesce(s.period_month,a.period_month) period_month,
   coalesce(s.currency,a.currency) currency,coalesce(s.channel,a.channel) channel,
   coalesce(s.campaign,a.campaign,'') campaign,coalesce(s.spend_minor,0)::bigint spend_minor,
   coalesce(a.attributed_new_paid_customers,0)::integer attributed_new_paid_customers,
   case when coalesce(a.attributed_new_paid_customers,0)>0
    then round(coalesce(s.spend_minor,0)::numeric/a.attributed_new_paid_customers)::bigint else null end cac_minor
  from spend_campaign s full join paid_attributions a
   on a.period_month=s.period_month and a.currency=s.currency and a.channel=s.channel and a.campaign=s.campaign
 ), channel_rows as(
  select period_month,currency,channel,sum(spend_minor)::bigint spend_minor,
   sum(attributed_new_paid_customers)::integer attributed_new_paid_customers,
   case when sum(attributed_new_paid_customers)>0
    then round(sum(spend_minor)::numeric/sum(attributed_new_paid_customers))::bigint else null end cac_minor,
   count(*) filter(where attributed_new_paid_customers>0)::integer campaigns_with_attribution,
   count(*)::integer campaign_count
  from campaign_rows group by period_month,currency,channel
 ), customer_cac as(
  select a.owner_id,a.currency,a.channel,a.campaign,date_trunc('month',a.acquired_at)::date acquisition_month,
   cr.cac_minor,cr.spend_minor,cr.attributed_new_paid_customers
  from customer_acquisition_attributions a
  join campaign_rows cr on cr.period_month=date_trunc('month',a.acquired_at)::date
   and cr.currency=a.currency and cr.channel=a.channel and cr.campaign=a.campaign
  where date_trunc('month',a.acquired_at)::date<=p_period_month
   and exists(select 1 from customer_subscriptions cs where cs.owner_id=a.owner_id and cs.amount_minor>0)
 ), retention_pairs as(
  select prior.currency,prior.snapshot_month,prior.owner_id,
   case when following.mrr_minor>0 then 1 else 0 end retained
  from subscription_revenue_snapshots prior
  join subscription_revenue_snapshots following on following.owner_id=prior.owner_id and following.currency=prior.currency
   and following.snapshot_month=(prior.snapshot_month+interval '1 month')::date
  where prior.snapshot_month<p_period_month and prior.mrr_minor>0
 ), retention as(
  select currency,count(*)::integer observed_customer_month_pairs,
   count(distinct snapshot_month)::integer observed_intervals,
   (sum(retained)::numeric/nullif(count(*),0))::numeric retention_rate
  from retention_pairs group by currency
 ), customer_base as(
  select c.owner_id,c.currency,c.snapshot_month,c.mrr_minor,c.direct_cost_minor,c.contribution_minor,
   coalesce(r.realized_contribution_to_date_minor,0)::bigint realized_contribution_to_date_minor,
   coalesce(r.observed_months,0)::integer observed_months,r.first_observed_month,r.last_observed_month,
   a.channel,a.campaign,a.acquisition_month,a.cac_minor,
   rt.retention_rate,coalesce(rt.observed_intervals,0)::integer observed_intervals,
   coalesce(rt.observed_customer_month_pairs,0)::integer observed_customer_month_pairs
  from current_customer c
  left join realized r on r.owner_id=c.owner_id and r.currency=c.currency
  left join customer_cac a on a.owner_id=c.owner_id and a.currency=c.currency
  left join retention rt on rt.currency=c.currency
 ), projected as(
  select b.*,
   case when b.retention_rate is not null and b.observed_intervals>=1 and b.contribution_minor>0
    then round(b.contribution_minor*(
     select sum(power(b.retention_rate::numeric,g.n::numeric)/
      power(1+p_discount_rate_bps::numeric/10000,g.n::numeric))
     from generate_series(1,p_horizon_months) g(n)
    ))::bigint else null end projected_future_contribution_minor
  from customer_base b
 ), ltv_rows as(
  select p.*,
   case when p.projected_future_contribution_minor is not null
    then p.realized_contribution_to_date_minor+p.projected_future_contribution_minor else null end predicted_lifetime_contribution_minor,
   case when p.cac_minor is not null and p.contribution_minor>0
    then round(p.cac_minor::numeric/p.contribution_minor,2) else null end modeled_payback_months,
   case when p.observed_intervals>=6 and p.observed_customer_month_pairs>=50 then 'high'
    when p.observed_intervals>=3 and p.observed_customer_month_pairs>=10 then 'moderate'
    when p.observed_intervals>=1 then 'low' else 'insufficient_history' end forecast_confidence
  from projected p
 ), cumulative as(
  select m.owner_id,m.currency,m.snapshot_month,m.contribution_minor,
   sum(m.contribution_minor) over(partition by m.owner_id,m.currency order by m.snapshot_month rows unbounded preceding)::bigint cumulative_contribution_minor
  from monthly_customer m where m.snapshot_month>=m.cohort_month
 ), actual_payback as(
  select c.owner_id,c.currency,min(c.snapshot_month) filter(where c.cumulative_contribution_minor>=a.cac_minor) actual_payback_month
  from cumulative c join customer_cac a on a.owner_id=c.owner_id and a.currency=c.currency
   and c.snapshot_month>=a.acquisition_month
  where a.cac_minor is not null
  group by c.owner_id,c.currency,a.cac_minor
 ), campaign_history as(
  select * from campaign_rows where period_month<=p_period_month
 ), currency_totals as(
  select currency,count(*) filter(where mrr_minor>0)::integer active_paid_customers,
   sum(realized_contribution_to_date_minor)::bigint realized_contribution_to_date_minor,
   sum(predicted_lifetime_contribution_minor) filter(where predicted_lifetime_contribution_minor is not null)::bigint predicted_lifetime_contribution_minor,
   count(*) filter(where predicted_lifetime_contribution_minor is not null)::integer modeled_customers,
   sum(cac_minor) filter(where cac_minor is not null)::bigint attributed_cac_minor,
   sum(realized_contribution_to_date_minor-cac_minor) filter(where cac_minor is not null)::bigint realized_after_cac_minor,
   sum(predicted_lifetime_contribution_minor-cac_minor) filter(where predicted_lifetime_contribution_minor is not null and cac_minor is not null)::bigint predicted_after_cac_minor
  from ltv_rows group by currency
 )
 select jsonb_build_object(
  'generatedAt',now(),'periodMonth',p_period_month,'discountRateBps',p_discount_rate_bps,
  'projectionHorizonMonths',p_horizon_months,
  'byCurrency',coalesce((select jsonb_agg(jsonb_build_object(
   'currency',currency,'activePaidCustomers',active_paid_customers,
   'realizedContributionToDateMinor',realized_contribution_to_date_minor,
   'predictedLifetimeContributionMinor',predicted_lifetime_contribution_minor,
   'modeledCustomers',modeled_customers,'attributedCacMinor',attributed_cac_minor,
   'realizedAfterCacMinor',realized_after_cac_minor,'predictedAfterCacMinor',predicted_after_cac_minor
  ) order by currency) from currency_totals),'[]'::jsonb),
  'channels',coalesce((select jsonb_agg(jsonb_build_object(
   'periodMonth',period_month,'channel',channel,'currency',currency,'spendMinor',spend_minor,
   'attributedNewPaidCustomers',attributed_new_paid_customers,'cacMinor',cac_minor,
   'campaignCount',campaign_count,'campaignsWithAttribution',campaigns_with_attribution
  ) order by period_month desc,currency,channel) from channel_rows),'[]'::jsonb),
  'campaigns',coalesce((select jsonb_agg(jsonb_build_object(
   'periodMonth',period_month,'channel',channel,'campaign',campaign,'currency',currency,
   'spendMinor',spend_minor,'attributedNewPaidCustomers',attributed_new_paid_customers,'cacMinor',cac_minor,
   'attributionCoverage',case when spend_minor>0 and attributed_new_paid_customers>0 then 'measured'
    when spend_minor>0 then 'spend_without_attribution' when attributed_new_paid_customers>0 then 'attribution_without_spend'
    else 'no_denominator' end
  ) order by period_month desc,currency,channel,campaign) from campaign_history),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(jsonb_build_object(
   'ownerId',l.owner_id,'currency',l.currency,'periodMonth',l.snapshot_month,
   'channel',l.channel,'campaign',l.campaign,'acquisitionMonth',l.acquisition_month,
   'monthlyContributionMinor',l.contribution_minor,
   'realizedContributionToDateMinor',l.realized_contribution_to_date_minor,
   'predictedLifetimeContributionMinor',l.predicted_lifetime_contribution_minor,
   'cacMinor',l.cac_minor,'realizedAfterCacMinor',case when l.cac_minor is null then null else l.realized_contribution_to_date_minor-l.cac_minor end,
   'predictedAfterCacMinor',case when l.predicted_lifetime_contribution_minor is null or l.cac_minor is null then null else l.predicted_lifetime_contribution_minor-l.cac_minor end,
   'ltvCacRatio',case when l.cac_minor>0 and l.predicted_lifetime_contribution_minor is not null then round(l.predicted_lifetime_contribution_minor::numeric/l.cac_minor,2) else null end,
   'growthQuality',case when l.cac_minor is null then 'insufficient_acquisition_evidence'
    when l.predicted_lifetime_contribution_minor is null then 'insufficient_lifetime_evidence'
    when l.predicted_lifetime_contribution_minor<l.cac_minor then 'value_below_acquisition_cost'
    when l.predicted_lifetime_contribution_minor::numeric/l.cac_minor::numeric>=3 then 'strong_unit_economics' else 'monitor_unit_economics' end,
   'modeledPaybackMonths',l.modeled_payback_months,
   'actualPaybackMonth',ap.actual_payback_month,
   'actualPaybackMonths',case when ap.actual_payback_month is null then null
    else ((extract(year from age(ap.actual_payback_month,l.acquisition_month))*12)+extract(month from age(ap.actual_payback_month,l.acquisition_month)))::integer end,
   'observedRetentionRate',case when l.retention_rate is null then null else round(l.retention_rate*100,2) end,
   'observedRetentionIntervals',l.observed_intervals,'observedCustomerMonthPairs',l.observed_customer_month_pairs,
   'forecastConfidence',l.forecast_confidence,
   'ltvAvailability',case when l.predicted_lifetime_contribution_minor is not null then 'modeled'
    else 'insufficient_retention_or_positive_contribution_evidence' end
  ) order by l.currency,l.realized_contribution_to_date_minor desc,l.owner_id) from ltv_rows l
   left join actual_payback ap on ap.owner_id=l.owner_id and ap.currency=l.currency),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Realized contribution is the sum of recorded monthly subscription MRR less same-month directly attributed service costs from the first available snapshot through the selected month; it is not a complete customer lifetime if earlier periods were not captured.',
   'Predicted lifetime contribution adds a discounted, constant-current-contribution projection over the selected horizon using observed consecutive-month paid-customer retention for the same currency. It is a management estimate, not a guarantee.',
   'Forecast confidence is an evidence-volume label based on observed monthly intervals and customer-month transitions, not a statistical confidence interval.',
   'CAC is reported only where immutable first-touch attribution and recorded spend exist for the same acquisition month, channel, campaign and currency. Missing spend or attribution is not imputed.',
   'Modeled payback is CAC divided by current positive monthly direct contribution. Actual payback is shown only when recorded cumulative contribution reaches CAC in observed monthly snapshots.',
   'Shared overhead is excluded from customer contribution unless an existing approved allocation has already been posted to the direct customer cost ledger. No overhead is invented or silently allocated.',
   'Currencies are never combined. MRR is not cash collected and these metrics are management accounting, not statutory revenue recognition or audited financial statements.'
  )
 ) into v_result;
 return v_result;
end $$;

revoke all on function executive_visuals.customer_lifetime_acquisition_economics_report(uuid,date,integer,integer) from public,anon,authenticated;
grant execute on function executive_visuals.customer_lifetime_acquisition_economics_report(uuid,date,integer,integer) to service_role;

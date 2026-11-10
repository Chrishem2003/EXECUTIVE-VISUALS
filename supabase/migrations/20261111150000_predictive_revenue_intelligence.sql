-- Batch 18: evidence-grounded predictive revenue and customer intelligence.
-- Scenarios are transparent sensitivity models, not ML predictions or guaranteed receipts.

create table if not exists executive_visuals.financial_forecast_snapshots(
 id uuid primary key default gen_random_uuid(),
 generated_by uuid not null references auth.users(id) on delete restrict,
 model_version text not null default 'subscription-scenario-v1',
 source_window_days integer not null default 180 check(source_window_days between 30 and 730),
 input_counts jsonb not null default '{}'::jsonb check(jsonb_typeof(input_counts)='object'),
 forecast_payload jsonb not null check(jsonb_typeof(forecast_payload)='object'),
 created_at timestamptz not null default now()
);
create index if not exists financial_forecast_snapshots_created_idx
 on executive_visuals.financial_forecast_snapshots(created_at desc);

create or replace function executive_visuals.financial_predictive_revenue_overview(p_actor_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_payload jsonb;
 v_snapshot_id uuid;
 v_currency_count integer:=0;
 v_active_count integer:=0;
 v_cancellation_count integer:=0;
begin
 if p_actor_id is null or not exists(
  select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')
 ) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;

 with active_subscriptions as(
  select cs.owner_id,cs.currency,cs.amount_minor,cs.billing_interval,
   case
    when cs.billing_interval='yearly' then cs.amount_minor/12.0
    when cs.billing_interval='quarterly' then cs.amount_minor/3.0
    when cs.billing_interval='weekly' then cs.amount_minor*52.0/12.0
    when cs.billing_interval='daily' then cs.amount_minor*365.0/12.0
    else cs.amount_minor::numeric
   end monthly_minor,
   cs.current_period_end,cs.status,cs.plan_code
  from customer_subscriptions cs
  where cs.status in('active','past_due') and cs.amount_minor>0
 ), currency_set as(
  select currency from active_subscriptions
  union
  select currency from payment_transactions
  where status='successful' and paid_at>=now()-interval '180 days'
 ), activation_base as(
  select distinct owner_id from subscription_events
  where event_type='activated' and created_at>=now()-interval '180 days'
  union
  select distinct owner_id from active_subscriptions
 ), cancellation_events as(
  select distinct se.owner_id,cs.currency
  from subscription_events se
  join customer_subscriptions cs on cs.id=se.subscription_id
  where se.event_type in('cancelled','expired')
   and se.created_at>=now()-interval '180 days'
 ), churn_stats as(
  select cs.currency,count(distinct ce.owner_id)::integer cancellation_customers
  from currency_set cs
  left join cancellation_events ce on ce.currency=cs.currency
  group by cs.currency
 ), activation_stats as(
  select cs.currency,count(distinct ab.owner_id)::integer activation_customers
  from currency_set cs
  left join active_subscriptions a on a.currency=cs.currency
  left join activation_base ab on ab.owner_id=a.owner_id
  group by cs.currency
 ), active_stats as(
  select currency,count(distinct owner_id)::integer active_subscribers,
   coalesce(round(sum(monthly_minor)),0)::bigint current_mrr_minor,
   coalesce(round(sum(monthly_minor)*12),0)::bigint current_arr_minor,
   coalesce(round(sum(monthly_minor) filter(where current_period_end<=now()+interval '30 days')),0)::bigint renewal_mrr_30d_minor,
   count(*) filter(where status='past_due')::integer past_due_subscribers
  from active_subscriptions group by currency
 ), refunds_by_payment as(
  select payment_transaction_id,sum(amount_minor)::bigint refunded_minor
  from payment_refunds where status in('completed','successful','succeeded')
  group by payment_transaction_id
 ), customer_net_payments as(
  select p.owner_id,p.currency,
   greatest(0,sum(p.amount_minor-coalesce(r.refunded_minor,0)))::bigint net_paid_minor
  from payment_transactions p
  left join refunds_by_payment r on r.payment_transaction_id=p.id
  where p.status='successful'
  group by p.owner_id,p.currency
 ), ltv_stats as(
  select currency,count(*)::integer paying_customers,
   coalesce(round(avg(net_paid_minor)),0)::bigint average_realized_ltv_minor,
   coalesce(sum(net_paid_minor),0)::bigint realized_revenue_minor
  from customer_net_payments group by currency
 ), health_stats as(
  select a.currency,
   count(distinct a.owner_id) filter(where coalesce((h.health->>'score')::integer,0)>=80)::integer high_health_customers
  from active_subscriptions a
  cross join lateral(
   select customer_success_health_for_owner(a.owner_id) health
  ) h
  group by a.currency
 ), winback_stats as(
  select cs.currency,count(distinct cs.owner_id)::integer winback_candidates
  from customer_subscriptions cs
  where cs.status in('cancelled','expired') and coalesce(cs.cancelled_at,cs.updated_at)>=now()-interval '90 days'
   and not exists(select 1 from customer_subscriptions current
    where current.owner_id=cs.owner_id and current.status in('active','past_due','trialing'))
  group by cs.currency
 ), metrics as(
  select cur.currency,
   coalesce(a.active_subscribers,0) active_subscribers,
   coalesce(a.current_mrr_minor,0) current_mrr_minor,
   coalesce(a.current_arr_minor,0) current_arr_minor,
   coalesce(a.renewal_mrr_30d_minor,0) renewal_mrr_30d_minor,
   coalesce(a.past_due_subscribers,0) past_due_subscribers,
   coalesce(ch.cancellation_customers,0) cancellation_customers,
   coalesce(ac.activation_customers,0) activation_customers,
   coalesce(l.paying_customers,0) paying_customers,
   coalesce(l.average_realized_ltv_minor,0) average_realized_ltv_minor,
   coalesce(l.realized_revenue_minor,0) realized_revenue_minor,
   coalesce(h.high_health_customers,0) high_health_customers,
   coalesce(w.winback_candidates,0) winback_candidates,
   case when coalesce(ac.activation_customers,0)+coalesce(ch.cancellation_customers,0)=0 then null
    else least(0.5,greatest(0,1-power(
     greatest(0.0001,1.0*coalesce(ch.cancellation_customers,0)/
      greatest(1,coalesce(ac.activation_customers,0)+coalesce(ch.cancellation_customers,0))),1.0/6.0)))
   end monthly_churn_rate
  from currency_set cur
  left join active_stats a on a.currency=cur.currency
  left join churn_stats ch on ch.currency=cur.currency
  left join activation_stats ac on ac.currency=cur.currency
  left join ltv_stats l on l.currency=cur.currency
  left join health_stats h on h.currency=cur.currency
  left join winback_stats w on w.currency=cur.currency
 ), horizons as(
  select unnest(array[30,60,90,365])::integer days
 ), projections as(
  select m.*,h.days,
   greatest(0,least(0.5,coalesce(m.monthly_churn_rate,0))) base_rate,
   greatest(0,least(0.5,coalesce(m.monthly_churn_rate,0)*1.5)) conservative_rate,
   greatest(0,least(0.5,coalesce(m.monthly_churn_rate,0)*0.75)) upside_rate
  from metrics m cross join horizons h
 ), scenario_rows as(
  select p.*,
   greatest(0,round(current_mrr_minor*power(1-base_rate,days/30.4375)))::bigint base_end_mrr,
   greatest(0,round(current_mrr_minor*power(1-conservative_rate,days/30.4375)))::bigint conservative_end_mrr,
   greatest(0,round(current_mrr_minor*power(1-upside_rate,days/30.4375)))::bigint upside_end_mrr,
   greatest(0,round(current_mrr_minor*greatest(0,1-power(1-base_rate,days/30.4375))))::bigint base_risk,
   greatest(0,round(current_mrr_minor*greatest(0,1-power(1-conservative_rate,days/30.4375))))::bigint conservative_risk,
   greatest(0,round(current_mrr_minor*greatest(0,1-power(1-upside_rate,days/30.4375))))::bigint upside_risk
  from projections p
 ), currency_json as(
  select currency,jsonb_build_object(
   'currency',currency,'activeSubscribers',active_subscribers,
   'currentMrrMinor',current_mrr_minor,'currentArrMinor',current_arr_minor,
   'renewalMrr30dMinor',renewal_mrr_30d_minor,'pastDueSubscribers',past_due_subscribers,
   'cancellationCustomers180d',cancellation_customers,'activationCustomers180d',activation_customers,
   'observedMonthlyChurnPct',case when monthly_churn_rate is null then null else round(monthly_churn_rate*100,2) end,
   'churnConfidence',case when activation_customers+cancellation_customers>=100 then 'moderate'
    when activation_customers+cancellation_customers>=20 then 'low' else 'insufficient_data' end,
   'churnSampleSize',activation_customers+cancellation_customers,
   'payingCustomers',paying_customers,'averageRealizedLtvMinor',average_realized_ltv_minor,
   'realizedRevenueMinor',realized_revenue_minor,
   'predictedLtvMinor',case when monthly_churn_rate is not null and paying_customers>=10
    then round(average_realized_ltv_minor+
      (current_mrr_minor/greatest(1,active_subscribers))*least(36,1/greatest(monthly_churn_rate,0.01)))::bigint
    else null end,
   'ltvConfidence',case when paying_customers>=100 and cancellation_customers>=20 then 'moderate'
    when paying_customers>=10 and cancellation_customers>=5 then 'low' else 'insufficient_data' end,
   'cacAvailability','not_instrumented',
   'highHealthExpansionCandidates',high_health_customers,
   'winbackCandidates90d',winback_candidates,
   'forecast',(
    select jsonb_agg(jsonb_build_object(
     'days',s.days,'months',round(s.days/30.4375,2),
     'base',jsonb_build_object('endMrrMinor',s.base_end_mrr,'revenueAtRiskMinor',s.base_risk),
     'conservative',jsonb_build_object('endMrrMinor',s.conservative_end_mrr,'revenueAtRiskMinor',s.conservative_risk),
     'upside',jsonb_build_object('endMrrMinor',s.upside_end_mrr,'revenueAtRiskMinor',s.upside_risk)
    ) order by s.days)
    from scenario_rows s where s.currency=currency_json.currency
   )
  ) payload
  from metrics currency_json
 )
 select jsonb_build_object(
  'modelVersion','subscription-scenario-v1',
  'generatedAt',now(),
  'sourceWindowDays',180,
  'methodology','Current paid MRR is projected using observed six-month cancellation hazard. Conservative and upside scenarios apply 1.5x and 0.75x churn sensitivity. No new sales, expansion, price changes, fees or taxes are assumed.',
  'forecastSemantics','Scenario estimates, not recognized revenue, cash balances, booked contracts or guaranteed collections.',
  'currencies',coalesce((select jsonb_agg(payload order by payload->>'currency') from currency_json),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'CAC and acquisition-channel attribution are unavailable until campaign cost and source data are instrumented.',
   'Churn confidence is reduced when event history or sample size is limited.',
   'LTV is a cohort-level estimate; it is not a customer-specific guarantee.',
   'Refunds are deducted only where refund status is recorded as completed, successful or succeeded.',
   'Forecasts exclude future acquisition, expansion, contraction, provider fees, taxes and foreign-exchange movements.'
  )
 ) into v_payload;

 select coalesce(jsonb_array_length(v_payload->'currencies'),0) into v_currency_count;
 select coalesce(sum((item->>'activeSubscribers')::integer),0) into v_active_count
 from jsonb_array_elements(v_payload->'currencies') item;
 select coalesce(sum((item->>'cancellationCustomers180d')::integer),0) into v_cancellation_count
 from jsonb_array_elements(v_payload->'currencies') item;

 insert into financial_forecast_snapshots(generated_by,model_version,source_window_days,input_counts,forecast_payload)
 values(p_actor_id,'subscription-scenario-v1',180,
  jsonb_build_object('currencies',v_currency_count,'activeSubscribers',v_active_count,'cancellationCustomers180d',v_cancellation_count),
  v_payload)
 returning id into v_snapshot_id;

 return v_payload||jsonb_build_object('snapshotId',v_snapshot_id);
end $$;

revoke all on executive_visuals.financial_forecast_snapshots from public,anon,authenticated;
grant select,insert on executive_visuals.financial_forecast_snapshots to service_role;
revoke all on function executive_visuals.financial_predictive_revenue_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.financial_predictive_revenue_overview(uuid) to service_role;

-- Batch 39: monthly recurring-revenue movement bridge and observed cohort retention curves.
-- This reports only captured monthly snapshots. It never reconstructs missing historical snapshots.
create or replace function executive_visuals.financial_revenue_movement_overview(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(
  select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')
 ) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;

 with observed_months as(
  select distinct snapshot_month from subscription_revenue_snapshots
  order by snapshot_month desc limit 12
 ), month_pair as(
  select min(snapshot_month) prior_month,max(snapshot_month) current_month,
   count(*)=2 and max(snapshot_month)=(min(snapshot_month)+interval '1 month')::date consecutive
  from (select snapshot_month from observed_months order by snapshot_month desc limit 2) m
 ), prior_rows as(
  select s.owner_id,s.currency,s.mrr_minor
  from subscription_revenue_snapshots s cross join month_pair p
  where s.snapshot_month=p.prior_month and s.mrr_minor>0
 ), current_rows as(
  select s.owner_id,s.currency,s.mrr_minor
  from subscription_revenue_snapshots s cross join month_pair p
  where s.snapshot_month=p.current_month and s.mrr_minor>0
 ), movement as(
  select coalesce(c.currency,b.currency) currency,
   coalesce(b.mrr_minor,0)::numeric opening_mrr,
   coalesce(c.mrr_minor,0)::numeric closing_mrr,
   case when coalesce(b.mrr_minor,0)=0 and coalesce(c.mrr_minor,0)>0 then c.mrr_minor else 0 end::numeric new_mrr,
   case when b.mrr_minor>0 and c.mrr_minor>b.mrr_minor then c.mrr_minor-b.mrr_minor else 0 end::numeric expansion_mrr,
   case when b.mrr_minor>0 and c.mrr_minor>0 and c.mrr_minor<b.mrr_minor then b.mrr_minor-c.mrr_minor else 0 end::numeric contraction_mrr,
   case when b.mrr_minor>0 and coalesce(c.mrr_minor,0)=0 then b.mrr_minor else 0 end::numeric churn_mrr,
   case when coalesce(b.mrr_minor,0)=0 and coalesce(c.mrr_minor,0)>0 then 1 else 0 end new_customers,
   case when b.mrr_minor>0 and c.mrr_minor>b.mrr_minor then 1 else 0 end expansion_customers,
   case when b.mrr_minor>0 and c.mrr_minor>0 and c.mrr_minor<b.mrr_minor then 1 else 0 end contraction_customers,
   case when b.mrr_minor>0 and coalesce(c.mrr_minor,0)=0 then 1 else 0 end churned_customers,
   case when c.mrr_minor>0 then 1 else 0 end ending_customers
  from prior_rows b full outer join current_rows c on c.owner_id=b.owner_id and c.currency=b.currency
 ), bridge as(
  select currency,sum(opening_mrr)::bigint opening_mrr_minor,
   sum(new_mrr)::bigint new_mrr_minor,sum(expansion_mrr)::bigint expansion_mrr_minor,
   sum(contraction_mrr)::bigint contraction_mrr_minor,sum(churn_mrr)::bigint churn_mrr_minor,
   sum(closing_mrr)::bigint closing_mrr_minor,
   sum(new_customers)::integer new_customers,sum(expansion_customers)::integer expansion_customers,
   sum(contraction_customers)::integer contraction_customers,sum(churned_customers)::integer churned_customers,
   sum(ending_customers)::integer ending_customers
  from movement group by currency
 ), cohort_months as(
  select distinct snapshot_month from observed_months
 ), cohort_first_seen as(
  select currency,cohort_month,min(snapshot_month) baseline_month
  from subscription_revenue_snapshots group by currency,cohort_month
 ), cohort_baseline as(
  select f.currency,f.cohort_month,f.baseline_month,
   count(*)::integer baseline_customers,sum(s.mrr_minor)::bigint baseline_mrr_minor
  from cohort_first_seen f join subscription_revenue_snapshots s
   on s.currency=f.currency and s.cohort_month=f.cohort_month and s.snapshot_month=f.baseline_month
  group by f.currency,f.cohort_month,f.baseline_month
 ), cohort_observations as(
  select s.snapshot_month,s.currency,s.cohort_month,count(*)::integer active_customers,
   sum(s.mrr_minor)::bigint current_mrr_minor
  from subscription_revenue_snapshots s join cohort_months m on m.snapshot_month=s.snapshot_month
  group by s.snapshot_month,s.currency,s.cohort_month
 ), cohort_curve as(
  select o.snapshot_month,o.currency,o.cohort_month,b.baseline_month,b.baseline_customers,
   o.active_customers,b.baseline_mrr_minor,o.current_mrr_minor,
   ((extract(year from age(o.snapshot_month,b.baseline_month))*12)+extract(month from age(o.snapshot_month,b.baseline_month)))::integer months_since_baseline
  from cohort_observations o join cohort_baseline b using(currency,cohort_month)
  where o.snapshot_month>=b.baseline_month
 )
 select jsonb_build_object(
  'generatedAt',now(),
  'comparison',jsonb_build_object(
   'priorMonth',p.prior_month,'currentMonth',p.current_month,
   'available',coalesce(p.consecutive,false),
   'note',case when p.prior_month is null then 'Capture two real monthly snapshots to calculate revenue movement.'
    when not p.consecutive then 'The two latest snapshots are not consecutive months; a monthly movement bridge is withheld.'
    else 'Movement reconciles opening MRR to closing MRR using new, expansion, contraction and churn movements.' end
  ),
  'movement',case when p.consecutive then coalesce((select jsonb_agg(jsonb_build_object(
   'currency',b.currency,'openingMrrMinor',b.opening_mrr_minor,'newMrrMinor',b.new_mrr_minor,
   'expansionMrrMinor',b.expansion_mrr_minor,'contractionMrrMinor',b.contraction_mrr_minor,
   'churnMrrMinor',b.churn_mrr_minor,'closingMrrMinor',b.closing_mrr_minor,
   'newCustomers',b.new_customers,'expansionCustomers',b.expansion_customers,
   'contractionCustomers',b.contraction_customers,'churnedCustomers',b.churned_customers,
   'endingCustomers',b.ending_customers,
   'reconciledClosingMrrMinor',b.opening_mrr_minor+b.new_mrr_minor+b.expansion_mrr_minor-b.contraction_mrr_minor-b.churn_mrr_minor,
   'reconciliationDeltaMinor',b.closing_mrr_minor-(b.opening_mrr_minor+b.new_mrr_minor+b.expansion_mrr_minor-b.contraction_mrr_minor-b.churn_mrr_minor)
  ) order by b.currency) from bridge b),'[]'::jsonb) else '[]'::jsonb end,
  'cohorts',coalesce((select jsonb_agg(jsonb_build_object(
   'snapshotMonth',c.snapshot_month,'baselineMonth',c.baseline_month,'cohortMonth',c.cohort_month,
   'currency',c.currency,'monthsSinceBaseline',c.months_since_baseline,
   'baselineCustomers',c.baseline_customers,'activeCustomers',c.active_customers,
   'logoRetentionPct',case when c.baseline_customers>0 then round(c.active_customers*100.0/c.baseline_customers,2) else null end,
   'baselineMrrMinor',c.baseline_mrr_minor,'currentMrrMinor',c.current_mrr_minor,
   'revenueRetentionPct',case when c.baseline_mrr_minor>0 then round(c.current_mrr_minor*100.0/c.baseline_mrr_minor,2) else null end
  ) order by c.cohort_month desc,c.currency,c.snapshot_month) from cohort_curve c),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Revenue movement compares only the two latest consecutive, actually captured monthly snapshots.',
   'Cohort retention baseline is the first observed snapshot for each paid cohort and currency, not a reconstructed acquisition-day balance.',
   'Missing snapshots are not interpolated; no synthetic churn, expansion, cash receipts or recognized revenue is created.',
   'MRR movement is a run-rate bridge, not cash flow, billings or accounting revenue.'
  )
 ) into v_result from month_pair p;
 return v_result;
end $$;

revoke all on function executive_visuals.financial_revenue_movement_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.financial_revenue_movement_overview(uuid) to service_role;

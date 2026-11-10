-- Batch 20: evidence-backed profitability, service-cost attribution and unit economics.
-- Shared overhead remains separate from direct customer costs; no arbitrary allocation is applied.

create table if not exists executive_visuals.financial_service_cost_events(
 id uuid primary key default gen_random_uuid(),
 period_month date not null check(period_month=date_trunc('month',period_month)::date),
 owner_id uuid references auth.users(id) on delete restrict,
 cost_category text not null check(cost_category in(
  'ai_inference','video_generation','image_generation','render_compute','storage','egress',
  'payment_processing','support','other'
 )),
 source_type text not null check(source_type in(
  'provider_invoice','provider_usage_export','cloud_invoice','payment_processor',
  'manual_receipt','other'
 )),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 amount_minor bigint not null check(amount_minor<>0),
 entry_type text not null check(entry_type in('expense','reversal')),
 reverses_event_id uuid references executive_visuals.financial_service_cost_events(id) on delete restrict,
 source_reference text not null default '' check(length(source_reference)<=160),
 description text not null check(length(btrim(description)) between 3 and 500),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 recorded_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 check((entry_type='expense' and amount_minor>0 and reverses_event_id is null)
    or (entry_type='reversal' and amount_minor<0 and reverses_event_id is not null))
);
create index if not exists financial_service_cost_period_idx
 on executive_visuals.financial_service_cost_events(period_month,currency,cost_category);
create index if not exists financial_service_cost_customer_idx
 on executive_visuals.financial_service_cost_events(owner_id,period_month,currency)
 where owner_id is not null;

alter table executive_visuals.financial_service_cost_events enable row level security;
revoke all on executive_visuals.financial_service_cost_events from public,anon,authenticated;
grant select,insert on executive_visuals.financial_service_cost_events to service_role;
create trigger financial_service_cost_events_immutable
 before update or delete on executive_visuals.financial_service_cost_events
 for each row execute function executive_visuals.reject_revenue_intelligence_mutation();

create or replace function executive_visuals.record_financial_service_cost(
 p_actor_id uuid,p_period_month date,p_owner_id uuid,p_cost_category text,
 p_source_type text,p_currency text,p_amount_minor bigint,p_source_reference text,
 p_description text,p_idempotency_key text,p_reverses_event_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_id uuid; v_existing financial_service_cost_events%rowtype;
 v_original financial_service_cost_events%rowtype; v_reversed bigint;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_period_month>date_trunc('month',now())::date
  or coalesce(p_cost_category,'') not in(
   'ai_inference','video_generation','image_generation','render_compute','storage','egress',
   'payment_processing','support','other')
  or coalesce(p_source_type,'') not in(
   'provider_invoice','provider_usage_export','cloud_invoice','payment_processor','manual_receipt','other')
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$'
  or p_amount_minor is null or p_amount_minor=0
  or length(coalesce(p_source_reference,''))>160
  or length(btrim(coalesce(p_description,''))) not between 3 and 500
  or length(coalesce(p_idempotency_key,'')) not between 8 and 160 then
  raise exception 'Invalid financial service cost details' using errcode='22023';
 end if;
 select * into v_existing from financial_service_cost_events where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.recorded_by<>p_actor_id or v_existing.amount_minor<>p_amount_minor
   or v_existing.currency<>p_currency or v_existing.owner_id is distinct from p_owner_id
   or v_existing.cost_category<>p_cost_category or v_existing.period_month<>p_period_month
   or v_existing.reverses_event_id is distinct from p_reverses_event_id
   or v_existing.source_type<>p_source_type or v_existing.source_reference<>coalesce(p_source_reference,'')
   or v_existing.description<>p_description then
   raise exception 'Idempotency key was already used with different cost details' using errcode='23505';
  end if;
  return jsonb_build_object('id',v_existing.id,'periodMonth',v_existing.period_month,'ownerId',v_existing.owner_id,
   'category',v_existing.cost_category,'currency',v_existing.currency,'amountMinor',v_existing.amount_minor,
   'entryType',v_existing.entry_type,'idempotentReplay',true);
 end if;
 if p_reverses_event_id is null and p_amount_minor<0 then
  raise exception 'A negative cost entry must reference the original expense being reversed' using errcode='22023';
 end if;
 if p_reverses_event_id is not null then
  if p_amount_minor>=0 then raise exception 'A reversal must be a negative amount' using errcode='22023'; end if;
  select * into v_original from financial_service_cost_events
   where id=p_reverses_event_id and entry_type='expense' for update;
  if not found or v_original.currency<>p_currency
   or v_original.period_month<>p_period_month
   or v_original.owner_id is distinct from p_owner_id
   or v_original.cost_category<>p_cost_category then
   raise exception 'Reversal must match an existing expense, customer, category, month and currency' using errcode='22023';
  end if;
  select coalesce(-sum(amount_minor),0) into v_reversed
   from financial_service_cost_events where reverses_event_id=p_reverses_event_id;
  if v_reversed+(-p_amount_minor)>v_original.amount_minor then
   raise exception 'Reversal exceeds the original recorded expense' using errcode='22023';
  end if;
 end if;
 insert into financial_service_cost_events(
  period_month,owner_id,cost_category,source_type,currency,amount_minor,entry_type,
  reverses_event_id,source_reference,description,idempotency_key,recorded_by
 ) values(
  p_period_month,p_owner_id,p_cost_category,p_source_type,p_currency,p_amount_minor,
  case when p_reverses_event_id is null then 'expense' else 'reversal' end,
  p_reverses_event_id,coalesce(p_source_reference,''),p_description,p_idempotency_key,p_actor_id
 ) on conflict(idempotency_key) do nothing returning id into v_id;
 if v_id is null then
  select * into v_existing from financial_service_cost_events where idempotency_key=p_idempotency_key;
  if v_existing.recorded_by<>p_actor_id or v_existing.amount_minor<>p_amount_minor
   or v_existing.currency<>p_currency or v_existing.owner_id is distinct from p_owner_id
   or v_existing.cost_category<>p_cost_category or v_existing.period_month<>p_period_month
   or v_existing.reverses_event_id is distinct from p_reverses_event_id
   or v_existing.source_type<>p_source_type or v_existing.source_reference<>coalesce(p_source_reference,'')
   or v_existing.description<>p_description then
   raise exception 'Idempotency key was already used with different cost details' using errcode='23505';
  end if;
  v_id:=v_existing.id;
 else
  perform write_financial_admin_audit(p_actor_id,
   case when p_reverses_event_id is null then 'finance.service_cost.recorded' else 'finance.service_cost.reversed' end,
   'financial_service_cost',v_id::text,p_description,p_idempotency_key,
   jsonb_build_object('periodMonth',p_period_month,'ownerId',p_owner_id,'category',p_cost_category,
    'sourceType',p_source_type,'currency',p_currency,'amountMinor',p_amount_minor,
    'reversesEventId',p_reverses_event_id));
 end if;
 return jsonb_build_object('id',v_id,'periodMonth',p_period_month,'ownerId',p_owner_id,
  'category',p_cost_category,'currency',p_currency,'amountMinor',p_amount_minor,
  'entryType',case when p_reverses_event_id is null then 'expense' else 'reversal' end,
  'idempotentReplay',v_existing.id is not null);
end $$;

create or replace function executive_visuals.financial_profitability_overview(p_actor_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;

 with latest_month as(
  select max(snapshot_month) snapshot_month from subscription_revenue_snapshots
 ), direct_costs as(
  select c.period_month,c.owner_id,c.currency,sum(c.amount_minor)::bigint direct_cost_minor
  from financial_service_cost_events c
  join latest_month m on m.snapshot_month=c.period_month
  where c.owner_id is not null
  group by c.period_month,c.owner_id,c.currency
 ), shared_costs as(
  select c.period_month,c.currency,c.cost_category,sum(c.amount_minor)::bigint amount_minor
  from financial_service_cost_events c
  join latest_month m on m.snapshot_month=c.period_month
  where c.owner_id is null
  group by c.period_month,c.currency,c.cost_category
 ), customer_base as(
  select s.snapshot_month,s.owner_id,s.cohort_month,s.currency,s.mrr_minor,
   coalesce(d.direct_cost_minor,0)::bigint direct_cost_minor,
   (s.mrr_minor-coalesce(d.direct_cost_minor,0))::bigint contribution_minor,
   a.channel,a.acquired_at
  from subscription_revenue_snapshots s
  join latest_month lm on lm.snapshot_month=s.snapshot_month
  left join direct_costs d on d.period_month=s.snapshot_month and d.owner_id=s.owner_id and d.currency=s.currency
  left join customer_acquisition_attributions a on a.owner_id=s.owner_id and a.currency=s.currency
 ), currency_totals as(
  select currency,count(*) filter(where mrr_minor>0)::integer paid_customers,
   sum(mrr_minor)::bigint mrr_minor,sum(direct_cost_minor)::bigint direct_cost_minor,
   sum(contribution_minor)::bigint contribution_minor,
   case when sum(mrr_minor)>0 then round((sum(mrr_minor)-sum(direct_cost_minor))*100.0/sum(mrr_minor),2) else null end direct_gross_margin_pct
  from customer_base group by currency
 ), churn as(
  select cur.currency,
   count(*) filter(where prior.mrr_minor>0)::integer opening_customers,
   count(*) filter(where prior.mrr_minor>0 and coalesce(cur_snap.mrr_minor,0)=0)::integer churned_customers,
   case when count(*) filter(where prior.mrr_minor>0)>0
    then (count(*) filter(where prior.mrr_minor>0 and coalesce(cur_snap.mrr_minor,0)=0))::numeric/
     count(*) filter(where prior.mrr_minor>0) else null end monthly_logo_churn
  from (select distinct currency from customer_base) cur
  left join lateral(
   select s.owner_id,s.mrr_minor,s.currency,s.snapshot_month
   from subscription_revenue_snapshots s
   where s.currency=cur.currency and s.snapshot_month=((select snapshot_month from latest_month)-interval '1 month')::date
  ) prior on true
  left join lateral(
   select s.owner_id,s.mrr_minor from subscription_revenue_snapshots s
   where s.currency=cur.currency and s.snapshot_month=(select snapshot_month from latest_month)
  ) cur_snap on cur_snap.owner_id=prior.owner_id
  group by cur.currency
 ), spend_by_channel as(
  select period_month,currency,channel,sum(amount_minor)::bigint spend_minor
  from customer_acquisition_spend_events
  group by period_month,currency,channel
 ), channel_cac as(
  select a.currency,a.channel,date_trunc('month',a.acquired_at)::date period_month,
   round(s.spend_minor::numeric/nullif(count(distinct a.owner_id),0))::bigint cac_minor
  from customer_acquisition_attributions a
  join spend_by_channel s on s.currency=a.currency and s.channel=a.channel
   and s.period_month=date_trunc('month',a.acquired_at)::date
  where exists(select 1 from customer_subscriptions cs where cs.owner_id=a.owner_id and cs.amount_minor>0)
  group by a.currency,a.channel,date_trunc('month',a.acquired_at)::date,s.spend_minor
 ), customer_rows as(
  select cb.*,cc.cac_minor customer_cac_minor,
   ch.monthly_logo_churn,
   case when cb.contribution_minor>0 and ch.monthly_logo_churn>0
    then round(cb.contribution_minor/ch.monthly_logo_churn)::bigint else null end estimated_gross_profit_ltv_minor
  from customer_base cb
  left join channel_cac cc on cc.currency=cb.currency and cc.channel=cb.channel
   and cc.period_month=date_trunc('month',cb.acquired_at)::date
  left join churn ch on ch.currency=cb.currency
 )
 select jsonb_build_object(
  'generatedAt',now(),
  'periodMonth',(select snapshot_month from latest_month),
  'byCurrency',coalesce((select jsonb_agg(jsonb_build_object(
   'currency',currency,'paidCustomers',paid_customers,'mrrMinor',mrr_minor,
   'directCostMinor',direct_cost_minor,'grossContributionMinor',contribution_minor,
   'directGrossMarginPct',direct_gross_margin_pct
  ) order by currency) from currency_totals),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(jsonb_build_object(
   'ownerId',owner_id,'currency',currency,'mrrMinor',mrr_minor,'directCostMinor',direct_cost_minor,
   'grossContributionMinor',contribution_minor,
   'grossMarginPct',case when mrr_minor>0 then round(contribution_minor*100.0/mrr_minor,2) else null end,
   'channel',channel,'cacMinor',customer_cac_minor,'cacPaybackMonths',
    case when contribution_minor>0 and customer_cac_minor is not null then round(customer_cac_minor::numeric/contribution_minor,2) else null end,
   'estimatedGrossProfitLtvMinor',estimated_gross_profit_ltv_minor,
   'ltvCacRatio',case when customer_cac_minor>0 and estimated_gross_profit_ltv_minor is not null
    then round(estimated_gross_profit_ltv_minor::numeric/customer_cac_minor,2) else null end,
   'ltvAvailability',case when monthly_logo_churn is null then 'insufficient_monthly_snapshots'
    when monthly_logo_churn=0 then 'no_observed_churn_in_comparison_window' else 'modeled_from_latest_monthly_logo_churn' end
  ) order by gross_margin_pct asc nulls last,owner_id) from customer_rows),'[]'::jsonb),
  'sharedCosts',coalesce((select jsonb_agg(jsonb_build_object(
   'category',cost_category,'currency',currency,'amountMinor',amount_minor
  ) order by currency,cost_category) from shared_costs),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Direct gross margin subtracts only recorded costs assigned to a customer. Shared overhead is shown separately and is not arbitrarily allocated.',
   'Customer-level contribution is current monthly subscription MRR less direct costs recorded for the same snapshot month and currency.',
   'CAC uses recorded channel spend divided by explicitly attributed paid customers in the acquisition month and currency.',
   'LTV is a directional estimate using latest observed monthly logo churn and current gross contribution; it is withheld without a consecutive prior snapshot or observed churn.',
   'This report is management accounting, not statutory revenue recognition, tax accounting or audited financial statements.'
  )
 ) into v_result;
 return v_result;
end $$;

revoke all on function executive_visuals.record_financial_service_cost(uuid,date,uuid,text,text,text,bigint,text,text,text,uuid) from public,anon,authenticated;
revoke all on function executive_visuals.financial_profitability_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.record_financial_service_cost(uuid,date,uuid,text,text,text,bigint,text,text,text,uuid) to service_role;
grant execute on function executive_visuals.financial_profitability_overview(uuid) to service_role;

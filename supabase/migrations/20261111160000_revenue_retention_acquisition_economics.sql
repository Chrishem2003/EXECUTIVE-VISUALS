-- Batch 19: revenue retention, acquisition economics and forecast accountability.
-- Monthly snapshots are point-in-time evidence. No synthetic historical backfill is performed.

create table if not exists executive_visuals.subscription_revenue_snapshots(
 snapshot_month date not null check(snapshot_month=date_trunc('month',snapshot_month)::date),
 owner_id uuid not null references auth.users(id) on delete restrict,
 cohort_month date not null check(cohort_month=date_trunc('month',cohort_month)::date),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 mrr_minor bigint not null check(mrr_minor>=0),
 subscription_status text not null check(subscription_status in('active','past_due','inactive')),
 captured_at timestamptz not null default now(),
 primary key(snapshot_month,owner_id,currency)
);
create index if not exists subscription_revenue_snapshots_cohort_idx
 on executive_visuals.subscription_revenue_snapshots(snapshot_month,currency,cohort_month);

create table if not exists executive_visuals.customer_acquisition_spend_events(
 id uuid primary key default gen_random_uuid(),
 period_month date not null check(period_month=date_trunc('month',period_month)::date),
 channel text not null check(channel ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
 campaign text not null default '' check(length(campaign)<=120),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 amount_minor bigint not null check(amount_minor<>0),
 entry_type text not null check(entry_type in('spend','reversal')),
 reverses_event_id uuid references executive_visuals.customer_acquisition_spend_events(id) on delete restrict,
 description text not null check(length(btrim(description)) between 3 and 500),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 recorded_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 check((entry_type='spend' and amount_minor>0 and reverses_event_id is null)
    or (entry_type='reversal' and amount_minor<0 and reverses_event_id is not null))
);
create index if not exists customer_acquisition_spend_period_idx
 on executive_visuals.customer_acquisition_spend_events(period_month,currency,channel);

create table if not exists executive_visuals.customer_acquisition_attributions(
 owner_id uuid primary key references auth.users(id) on delete restrict,
 channel text not null check(channel ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
 campaign text not null default '' check(length(campaign)<=120),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 source_type text not null check(source_type in('self_reported','referral','partner','paid_campaign','organic','other')),
 acquired_at timestamptz not null,
 recorded_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now()
);
create index if not exists customer_acquisition_attributions_channel_idx
 on executive_visuals.customer_acquisition_attributions(acquired_at,currency,channel);

alter table executive_visuals.subscription_revenue_snapshots enable row level security;
alter table executive_visuals.customer_acquisition_spend_events enable row level security;
alter table executive_visuals.customer_acquisition_attributions enable row level security;
revoke all on executive_visuals.subscription_revenue_snapshots,
 executive_visuals.customer_acquisition_spend_events,
 executive_visuals.customer_acquisition_attributions from public,anon,authenticated;
grant select,insert on executive_visuals.subscription_revenue_snapshots to service_role;
grant select,insert on executive_visuals.customer_acquisition_spend_events to service_role;
grant select,insert on executive_visuals.customer_acquisition_attributions to service_role;

create or replace function executive_visuals.reject_revenue_intelligence_mutation()
returns trigger language plpgsql security definer
set search_path=pg_catalog,executive_visuals as $revenue$
begin
 raise exception 'Revenue intelligence evidence is append-only' using errcode='55000';
end $revenue$;
create trigger subscription_revenue_snapshots_immutable
 before update or delete on executive_visuals.subscription_revenue_snapshots
 for each row execute function executive_visuals.reject_revenue_intelligence_mutation();
create trigger customer_acquisition_spend_immutable
 before update or delete on executive_visuals.customer_acquisition_spend_events
 for each row execute function executive_visuals.reject_revenue_intelligence_mutation();
create trigger customer_acquisition_attributions_immutable
 before update or delete on executive_visuals.customer_acquisition_attributions
 for each row execute function executive_visuals.reject_revenue_intelligence_mutation();

create or replace function executive_visuals.capture_subscription_revenue_snapshot(
 p_actor_id uuid,p_snapshot_month date default date_trunc('month',now())::date
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_month date:=date_trunc('month',coalesce(p_snapshot_month,date_trunc('month',now())::date))::date;
 v_count integer:=0;
 v_inserted integer:=0;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
   where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if v_month<>date_trunc('month',now())::date then
  raise exception 'Only the current month can be captured; historical backfill is not supported' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtext('subscription-revenue-snapshot')::bigint,(v_month-date '2000-01-01')::bigint);
 if exists(select 1 from subscription_revenue_snapshots where snapshot_month=v_month) then
  select count(*) into v_count from subscription_revenue_snapshots where snapshot_month=v_month;
  return jsonb_build_object('snapshotMonth',v_month,'capturedCustomers',v_count,'insertedCustomers',0,'alreadyCaptured',true);
 end if;

 with first_paid as(
  select se.owner_id,min(se.created_at) first_paid_at
  from subscription_events se join customer_subscriptions cs on cs.id=se.subscription_id
  where se.event_type='activated' and cs.amount_minor>0
  group by se.owner_id
 ), fallback_paid as(
  select cs.owner_id,min(cs.created_at) first_paid_at
  from customer_subscriptions cs
  where cs.amount_minor>0 and cs.status in('active','past_due','cancelled','expired','suspended')
   and not exists(select 1 from subscription_events se join customer_subscriptions paid on paid.id=se.subscription_id
    where se.owner_id=cs.owner_id and se.event_type='activated' and paid.amount_minor>0)
  group by cs.owner_id
 ), paid_owners as(
  select owner_id,first_paid_at from first_paid
  union all
  select owner_id,first_paid_at from fallback_paid
 ), current_state as(
  select p.owner_id,date_trunc('month',p.first_paid_at)::date cohort_month,
   latest.currency,
   case when latest.status in('active','past_due') and latest.amount_minor>0
    then round(case when latest.billing_interval='yearly' then latest.amount_minor/12.0
      else latest.amount_minor::numeric end)::bigint else 0 end mrr_minor,
   case when latest.status in('active','past_due') and latest.amount_minor>0
    then latest.status else 'inactive' end subscription_status
  from paid_owners p
  join lateral(
   select cs.currency,cs.status,cs.amount_minor,cs.billing_interval
   from customer_subscriptions cs where cs.owner_id=p.owner_id
   order by cs.created_at desc limit 1
  ) latest on true
 )
 insert into subscription_revenue_snapshots(snapshot_month,owner_id,cohort_month,currency,mrr_minor,subscription_status)
 select v_month,owner_id,cohort_month,currency,mrr_minor,subscription_status
 from current_state
 on conflict(snapshot_month,owner_id,currency) do nothing;
 get diagnostics v_inserted=row_count;
 select count(*) into v_count from subscription_revenue_snapshots where snapshot_month=v_month;
 perform write_financial_admin_audit(p_actor_id,'revenue.snapshot.captured','subscription_revenue_snapshot',v_month::text,
  'Capture current-month customer subscription revenue evidence',null,
  jsonb_build_object('snapshotMonth',v_month,'capturedCustomers',v_count,'insertedCustomers',v_inserted));
 return jsonb_build_object('snapshotMonth',v_month,'capturedCustomers',v_count,'insertedCustomers',v_inserted,'alreadyCaptured',false);
end $$;

create or replace function executive_visuals.record_customer_acquisition_spend(
 p_actor_id uuid,p_period_month date,p_channel text,p_campaign text,p_currency text,
 p_amount_minor bigint,p_description text,p_idempotency_key text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_id uuid; v_existing customer_acquisition_spend_events%rowtype;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_period_month>date_trunc('month',now())::date
  or coalesce(p_channel,'') !~ '^[a-z0-9][a-z0-9_-]{1,39}$'
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$'
  or length(btrim(coalesce(p_description,''))) not between 3 and 500
  or length(coalesce(p_idempotency_key,'')) not between 8 and 160 then
  raise exception 'Invalid acquisition spend details' using errcode='22023';
 end if;
 insert into customer_acquisition_spend_events(period_month,channel,campaign,currency,amount_minor,entry_type,description,idempotency_key,recorded_by)
 values(p_period_month,p_channel,coalesce(p_campaign,''),p_currency,p_amount_minor,'spend',p_description,p_idempotency_key,p_actor_id)
 on conflict(idempotency_key) do nothing returning id into v_id;
 if v_id is null then
  select * into v_existing from customer_acquisition_spend_events where idempotency_key=p_idempotency_key;
  if v_existing.recorded_by<>p_actor_id or v_existing.amount_minor<>p_amount_minor
   or v_existing.currency<>p_currency or v_existing.channel<>p_channel
   or v_existing.period_month<>p_period_month or v_existing.campaign<>coalesce(p_campaign,'') or v_existing.description<>p_description then
   raise exception 'Idempotency key was already used with different spend details' using errcode='23505';
  end if;
  v_id:=v_existing.id;
 else
  perform write_financial_admin_audit(p_actor_id,'acquisition.spend.recorded','customer_acquisition_spend',v_id::text,
   'Record acquisition campaign spend',p_idempotency_key,
   jsonb_build_object('periodMonth',p_period_month,'channel',p_channel,'campaign',coalesce(p_campaign,''),'currency',p_currency,'amountMinor',p_amount_minor));
 end if;
 return jsonb_build_object('id',v_id,'periodMonth',p_period_month,'channel',p_channel,'currency',p_currency,'amountMinor',p_amount_minor,'idempotentReplay',v_existing.id is not null);
end $$;

create or replace function executive_visuals.record_customer_acquisition_attribution(
 p_actor_id uuid,p_owner_id uuid,p_channel text,p_campaign text,p_currency text,
 p_source_type text,p_acquired_at timestamptz
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_existing customer_acquisition_attributions%rowtype; v_inserted_owner uuid;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_owner_id is null or coalesce(p_channel,'') !~ '^[a-z0-9][a-z0-9_-]{1,39}$'
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$'
  or coalesce(p_source_type,'') not in('self_reported','referral','partner','paid_campaign','organic','other')
  or p_acquired_at is null or p_acquired_at>now() then
  raise exception 'Invalid customer acquisition attribution' using errcode='22023';
 end if;
 if not exists(select 1 from customer_subscriptions cs where cs.owner_id=p_owner_id and cs.amount_minor>0) then
  raise exception 'Attribution requires a customer with a paid subscription record' using errcode='22023';
 end if;
 insert into customer_acquisition_attributions(owner_id,channel,campaign,currency,source_type,acquired_at,recorded_by)
 values(p_owner_id,p_channel,coalesce(p_campaign,''),p_currency,p_source_type,p_acquired_at,p_actor_id)
 on conflict(owner_id) do nothing returning owner_id into v_inserted_owner;
 select * into v_existing from customer_acquisition_attributions where owner_id=p_owner_id;
 if v_existing.recorded_by<>p_actor_id or v_existing.channel<>p_channel
  or v_existing.currency<>p_currency then
  raise exception 'Customer acquisition attribution already exists and is immutable' using errcode='23505';
 end if;
 if v_inserted_owner is not null then
  perform write_financial_admin_audit(p_actor_id,'acquisition.attribution.recorded','customer_acquisition_attribution',p_owner_id::text,
   'Record first-touch acquisition attribution',null,
   jsonb_build_object('channel',p_channel,'campaign',coalesce(p_campaign,''),'currency',p_currency,'sourceType',p_source_type));
 end if;
 return jsonb_build_object('ownerId',p_owner_id,'channel',v_existing.channel,'currency',v_existing.currency,'alreadyAttributed',v_inserted_owner is null);
end $$;

create or replace function executive_visuals.financial_revenue_retention_overview(p_actor_id uuid)
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

 with months as(
  select distinct snapshot_month from subscription_revenue_snapshots
  order by snapshot_month desc limit 2
 ), month_pair as(
  select case when count(*)>=2 then min(snapshot_month) end prior_month,max(snapshot_month) current_month from months
 ), retention as(
  select p.prior_month,p.current_month,b.currency,b.cohort_month,
   count(*)::integer opening_customers,
   count(*) filter(where coalesce(c.mrr_minor,0)>0)::integer retained_customers,
   sum(b.mrr_minor)::bigint opening_mrr_minor,
   sum(coalesce(c.mrr_minor,0))::bigint ending_mrr_minor,
   sum(least(b.mrr_minor,coalesce(c.mrr_minor,0)))::bigint gross_retained_mrr_minor
  from month_pair p
  join subscription_revenue_snapshots b on b.snapshot_month=p.prior_month
  left join subscription_revenue_snapshots c on c.snapshot_month=p.current_month
   and c.owner_id=b.owner_id and c.currency=b.currency
  where p.prior_month is not null and p.current_month=(p.prior_month+interval '1 month')::date and b.mrr_minor>0
  group by p.prior_month,p.current_month,b.currency,b.cohort_month
 ), first_paid_for_cac as(
  select se.owner_id,min(se.created_at) first_paid_at
  from subscription_events se join customer_subscriptions cs on cs.id=se.subscription_id
  where se.event_type='activated' and cs.amount_minor>0
  group by se.owner_id
  union all
  select cs.owner_id,min(cs.created_at) first_paid_at
  from customer_subscriptions cs
  where cs.amount_minor>0 and cs.status in('active','past_due','cancelled','expired','suspended')
   and not exists(select 1 from subscription_events se join customer_subscriptions paid on paid.id=se.subscription_id
    where se.owner_id=cs.owner_id and se.event_type='activated' and paid.amount_minor>0)
  group by cs.owner_id
 ), acquisition as(
  select s.period_month,s.currency,s.channel,
   sum(s.amount_minor)::bigint net_spend_minor,
   count(distinct a.owner_id) filter(where paid.owner_id is not null)::integer attributed_new_customers,
   case when count(distinct a.owner_id) filter(where paid.owner_id is not null)>0
    then round(sum(s.amount_minor)::numeric/count(distinct a.owner_id) filter(where paid.owner_id is not null))::bigint else null end cac_minor
  from(
   select period_month,currency,channel,sum(amount_minor)::bigint amount_minor
   from customer_acquisition_spend_events
   group by period_month,currency,channel
  ) s
  left join customer_acquisition_attributions a
   on a.currency=s.currency and a.channel=s.channel
   and date_trunc('month',a.acquired_at)::date=s.period_month
  left join first_paid_for_cac paid on paid.owner_id=a.owner_id
   and date_trunc('month',paid.first_paid_at)::date=s.period_month
  where s.amount_minor is not null
  group by s.period_month,s.currency,s.channel
 ), forecast_errors as(
  select fs.id,fs.created_at,cur->>'currency' currency,
   (point->>'days')::integer horizon_days,
   (point->'base'->>'endMrrMinor')::numeric forecast_mrr,
   actual.snapshot_month,
   actual.actual_mrr
  from financial_forecast_snapshots fs
  cross join lateral jsonb_array_elements(fs.forecast_payload->'currencies') cur
  cross join lateral jsonb_array_elements(cur->'forecast') point
  join lateral(
   select s.snapshot_month,sum(s.mrr_minor)::numeric actual_mrr
   from subscription_revenue_snapshots s
   where s.currency=cur->>'currency'
    and s.snapshot_month between (fs.created_at::date+(point->>'days')::integer-15)
     and (fs.created_at::date+(point->>'days')::integer+15)
   group by s.snapshot_month
   order by abs(s.snapshot_month-(fs.created_at::date+(point->>'days')::integer))
   limit 1
  ) actual on true
 )
 select jsonb_build_object(
  'generatedAt',now(),
  'retention',coalesce((select jsonb_agg(jsonb_build_object(
   'priorMonth',prior_month,'currentMonth',current_month,'currency',currency,'cohortMonth',cohort_month,
   'openingCustomers',opening_customers,'retainedCustomers',retained_customers,
   'openingMrrMinor',opening_mrr_minor,'endingMrrMinor',ending_mrr_minor,
   'grossRetainedMrrMinor',gross_retained_mrr_minor,
   'grrPct',case when opening_mrr_minor>0 then round(gross_retained_mrr_minor*100.0/opening_mrr_minor,2) else null end,
   'nrrPct',case when opening_mrr_minor>0 then round(ending_mrr_minor*100.0/opening_mrr_minor,2) else null end
  ) order by prior_month desc,currency,cohort_month desc) from retention),'[]'::jsonb),
  'acquisition',coalesce((select jsonb_agg(jsonb_build_object(
   'periodMonth',period_month,'currency',currency,'channel',channel,
   'spendMinor',net_spend_minor,'attributedNewCustomers',attributed_new_customers,'cacMinor',cac_minor,
   'cacPaybackMonths',null,'paybackAvailability','gross_margin_not_instrumented'
  ) order by period_month desc,currency,channel) from acquisition),'[]'::jsonb),
  'forecastAccuracy',coalesce((select jsonb_agg(jsonb_build_object(
   'horizonDays',horizon_days,'currency',currency,'observations',count(*)::integer,
   'meanAbsolutePercentageError',case when sum(actual_mrr)>0
    then round(avg(abs(forecast_mrr-actual_mrr)/greatest(actual_mrr,1))*100,2) else null end,
   'meanAbsoluteErrorMinor',round(avg(abs(forecast_mrr-actual_mrr)))::bigint
  )) group by horizon_days,currency order by horizon_days,currency) from forecast_errors),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Retention comparisons begin only after two real monthly snapshots exist; earlier history is not reconstructed.',
   'CAC includes only acquisition spend and new paid customers with explicit channel attribution for the same currency and month.',
   'CAC payback is unavailable until subscription gross-margin and variable service costs are instrumented.',
   'Forecast accuracy appears only when an observed monthly snapshot falls within 15 days of a forecast horizon.'
  )
 ) into v_result;
 return v_result;
end $$;

revoke all on function executive_visuals.capture_subscription_revenue_snapshot(uuid,date) from public,anon,authenticated;
revoke all on function executive_visuals.record_customer_acquisition_spend(uuid,date,text,text,text,bigint,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.record_customer_acquisition_attribution(uuid,uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function executive_visuals.financial_revenue_retention_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.capture_subscription_revenue_snapshot(uuid,date) to service_role;
grant execute on function executive_visuals.record_customer_acquisition_spend(uuid,date,text,text,text,bigint,text,text) to service_role;
grant execute on function executive_visuals.record_customer_acquisition_attribution(uuid,uuid,text,text,text,text,timestamptz) to service_role;
grant execute on function executive_visuals.financial_revenue_retention_overview(uuid) to service_role;

-- Batch 17: subscription growth intelligence, paid cohorts, renewal watchlists,
-- customer-success interventions and controlled experiment assignment.
-- Forecasts are explicitly excluded: this migration reports measured snapshots only.

create table if not exists executive_visuals.customer_growth_experiments(
 id uuid primary key default gen_random_uuid(),
 experiment_key text not null unique check(experiment_key ~ '^[a-z0-9][a-z0-9_-]{2,59}$'),
 name text not null check(length(btrim(name)) between 3 and 120),
 hypothesis text not null check(length(btrim(hypothesis)) between 10 and 1000),
 primary_metric text not null check(primary_metric in(
  'activation_rate','first_renewal_rate','paid_retention','net_revenue_retention',
  'render_completion_rate','workflow_completion_rate','winback_conversion'
 )),
 status text not null default 'draft' check(status in('draft','running','paused','completed')),
 variants jsonb not null default '[{"key":"control","label":"Control"},{"key":"treatment","label":"Treatment"}]'::jsonb
  check(jsonb_typeof(variants)='array' and jsonb_array_length(variants) between 2 and 4),
 starts_at timestamptz,
 ends_at timestamptz,
 created_by uuid not null references auth.users(id) on delete restrict,
 updated_by uuid references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(ends_at is null or starts_at is null or ends_at>starts_at)
);
create index if not exists customer_growth_experiments_status_idx
 on executive_visuals.customer_growth_experiments(status,starts_at desc);

create table if not exists executive_visuals.customer_growth_experiment_assignments(
 id uuid primary key default gen_random_uuid(),
 experiment_id uuid not null references executive_visuals.customer_growth_experiments(id) on delete restrict,
 owner_id uuid not null references auth.users(id) on delete restrict,
 variant_key text not null check(variant_key ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
 assigned_at timestamptz not null default now(),
 unique(experiment_id,owner_id)
);
create index if not exists customer_growth_assignments_experiment_variant_idx
 on executive_visuals.customer_growth_experiment_assignments(experiment_id,variant_key,assigned_at);

alter table executive_visuals.customer_success_interventions
 add column if not exists outcome text,
 add column if not exists resolved_at timestamptz;
alter table executive_visuals.customer_success_interventions
 drop constraint if exists customer_success_interventions_outcome_check;
alter table executive_visuals.customer_success_interventions
 add constraint customer_success_interventions_outcome_check
 check(outcome is null or outcome in(
  'renewed','reactivated','expanded','engaged','no_change','declined','unreachable','not_applicable'
 ));

create or replace function executive_visuals.customer_growth_assign_experiment(
 p_owner_id uuid,p_experiment_key text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 exp_row customer_growth_experiments%rowtype;
 assignment_row customer_growth_experiment_assignments%rowtype;
 variants_count integer;
 chosen_index integer;
 chosen_key text;
begin
 if p_owner_id is null or p_experiment_key is null then
  raise exception 'Authenticated customer and experiment key required' using errcode='22023';
 end if;
 select * into exp_row from customer_growth_experiments
 where experiment_key=p_experiment_key and status='running'
  and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>now());
 if not found then return jsonb_build_object('assigned',false,'reason','experiment_not_active'); end if;
 select * into assignment_row from customer_growth_experiment_assignments
 where experiment_id=exp_row.id and owner_id=p_owner_id;
 if found then
  return jsonb_build_object('assigned',true,'experimentKey',exp_row.experiment_key,
   'variant',assignment_row.variant_key,'assignedAt',assignment_row.assigned_at,'existing',true);
 end if;
 variants_count:=jsonb_array_length(exp_row.variants);
 chosen_index:=(abs(hashtext(p_owner_id::text||':'||exp_row.experiment_key)::bigint) % variants_count)::integer;
 chosen_key:=exp_row.variants->chosen_index->>'key';
 if chosen_key is null or chosen_key !~ '^[a-z0-9][a-z0-9_-]{1,39}$' then
  raise exception 'Experiment variant configuration is invalid' using errcode='22023';
 end if;
 insert into customer_growth_experiment_assignments(experiment_id,owner_id,variant_key)
 values(exp_row.id,p_owner_id,chosen_key)
 on conflict(experiment_id,owner_id) do nothing
 returning * into assignment_row;
 if assignment_row.id is null then
  select * into assignment_row from customer_growth_experiment_assignments
   where experiment_id=exp_row.id and owner_id=p_owner_id;
 end if;
 return jsonb_build_object('assigned',true,'experimentKey',exp_row.experiment_key,
  'variant',assignment_row.variant_key,'assignedAt',assignment_row.assigned_at,'existing',false);
end $$;

create or replace function executive_visuals.customer_growth_create_experiment(
 p_admin_id uuid,p_experiment_key text,p_name text,p_hypothesis text,
 p_primary_metric text,p_variants jsonb,p_starts_at timestamptz default null,
 p_ends_at timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare exp_row customer_growth_experiments%rowtype;
begin
 if p_admin_id is null or p_experiment_key !~ '^[a-z0-9][a-z0-9_-]{2,59}$'
  or length(btrim(coalesce(p_name,''))) not between 3 and 120
  or length(btrim(coalesce(p_hypothesis,''))) not between 10 and 1000
  or p_primary_metric not in('activation_rate','first_renewal_rate','paid_retention',
    'net_revenue_retention','render_completion_rate','workflow_completion_rate','winback_conversion')
  or jsonb_typeof(p_variants)<>'array' or jsonb_array_length(p_variants) not between 2 and 4
  or (p_ends_at is not null and p_starts_at is not null and p_ends_at<=p_starts_at) then
  raise exception 'Experiment definition is invalid' using errcode='22023';
 end if;
 if exists(select 1 from customer_growth_experiments where experiment_key=p_experiment_key) then
  raise exception 'Experiment key already exists' using errcode='23505';
 end if;
 insert into customer_growth_experiments(experiment_key,name,hypothesis,primary_metric,variants,
  starts_at,ends_at,created_by,updated_by)
 values(p_experiment_key,btrim(p_name),btrim(p_hypothesis),p_primary_metric,p_variants,
  p_starts_at,p_ends_at,p_admin_id,p_admin_id) returning * into exp_row;
 return jsonb_build_object('id',exp_row.id,'experimentKey',exp_row.experiment_key,
  'name',exp_row.name,'status',exp_row.status,'primaryMetric',exp_row.primary_metric);
end $$;

create or replace function executive_visuals.customer_growth_set_experiment_status(
 p_admin_id uuid,p_experiment_id uuid,p_status text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare exp_row customer_growth_experiments%rowtype;
begin
 if p_status not in('draft','running','paused','completed') then
  raise exception 'Experiment status is invalid' using errcode='22023';
 end if;
 update customer_growth_experiments set status=p_status,updated_by=p_admin_id,updated_at=now()
 where id=p_experiment_id returning * into exp_row;
 if not found then raise exception 'Experiment not found' using errcode='P0002'; end if;
 return jsonb_build_object('id',exp_row.id,'experimentKey',exp_row.experiment_key,
  'status',exp_row.status,'updatedAt',exp_row.updated_at);
end $$;

create or replace function executive_visuals.customer_growth_record_intervention(
 p_admin_id uuid,p_owner_id uuid,p_type text,p_reason text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare item customer_success_interventions%rowtype;
begin
 if p_admin_id is null or p_owner_id is null
  or p_type not in('onboarding_help','first_value_nudge','usage_guidance','renewal_checkin','payment_recovery','winback')
  or length(btrim(coalesce(p_reason,''))) not between 3 and 500 then
  raise exception 'Intervention request is invalid' using errcode='22023';
 end if;
 insert into customer_success_interventions(owner_id,intervention_type,reason,created_by)
 values(p_owner_id,p_type,btrim(p_reason),p_admin_id) returning * into item;
 return jsonb_build_object('id',item.id,'ownerId',item.owner_id,'type',item.intervention_type,
  'status',item.status,'createdAt',item.created_at);
end $$;

create or replace function executive_visuals.customer_growth_update_intervention(
 p_admin_id uuid,p_intervention_id uuid,p_status text,p_outcome text default null
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare item customer_success_interventions%rowtype;
begin
 if p_admin_id is null or p_status not in('approved','dismissed','completed')
  or (p_status='completed' and p_outcome not in('renewed','reactivated','expanded','engaged','no_change','declined','unreachable','not_applicable'))
  or (p_status<>'completed' and p_outcome is not null) then
  raise exception 'Intervention update is invalid' using errcode='22023';
 end if;
 update customer_success_interventions set status=p_status,outcome=p_outcome,
  updated_by=p_admin_id,updated_at=now(),resolved_at=case when p_status in('completed','dismissed') then now() else null end
 where id=p_intervention_id returning * into item;
 if not found then raise exception 'Intervention not found' using errcode='P0002'; end if;
 return jsonb_build_object('id',item.id,'status',item.status,'outcome',item.outcome,
  'updatedAt',item.updated_at);
end $$;

create or replace function executive_visuals.customer_growth_admin_overview()
returns jsonb
language sql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
 with first_paid as(
  select owner_id,min(created_at) first_paid_at
  from customer_subscriptions
  where amount_minor>0 and status in('active','past_due','cancelled','expired','suspended')
  group by owner_id
 ), cohort_base as(
  select f.owner_id,date_trunc('month',f.first_paid_at)::date cohort_month,
   coalesce(s.status,'unknown') current_status
  from first_paid f
  left join lateral(
   select status from customer_subscriptions cs where cs.owner_id=f.owner_id
   order by cs.created_at desc limit 1
  ) s on true
 ), cohorts as(
  select cohort_month,count(*)::integer cohort_customers,
   count(*) filter(where current_status in('active','past_due'))::integer active_customers
  from cohort_base group by cohort_month
 ), renewals as(
  select cs.owner_id,cs.plan_code,cs.billing_interval,cs.amount_minor,cs.currency,
   cs.current_period_end,cs.status,u.email,
   executive_visuals.customer_success_health_for_owner(cs.owner_id) health
  from customer_subscriptions cs join auth.users u on u.id=cs.owner_id
  where cs.status in('active','past_due') and cs.current_period_end between now() and now()+interval '30 days'
 ), cancellation_reasons as(
  select coalesce(nullif(btrim(se.reason),''),'Reason not recorded') reason,count(*)::integer count
  from subscription_events se
  where se.event_type='cancelled' and se.created_at>=now()-interval '180 days'
  group by 1 order by count(*) desc limit 8
 ), interventions as(
  select count(*)::integer total,
   count(*) filter(where status='suggested')::integer suggested,
   count(*) filter(where status='approved')::integer approved,
   count(*) filter(where status='completed')::integer completed,
   count(*) filter(where outcome in('renewed','reactivated','expanded'))::integer positive_outcomes
  from customer_success_interventions
 ), experiment_rows as(
  select e.id,e.experiment_key,e.name,e.hypothesis,e.primary_metric,e.status,e.variants,
   e.starts_at,e.ends_at,e.created_at,
   count(a.id)::integer assigned_count,
   count(a.id) filter(where a.variant_key='control')::integer control_count,
   count(a.id) filter(where a.variant_key<>'control')::integer treatment_count
  from customer_growth_experiments e
  left join customer_growth_experiment_assignments a on a.experiment_id=e.id
  group by e.id order by e.created_at desc limit 20
 )
 select jsonb_build_object(
  'generatedAt',now(),
  'cohortDefinition','First paid subscription month; current paid status snapshot. Not a historical month-by-month survival curve.',
  'cohorts',coalesce((select jsonb_agg(jsonb_build_object(
   'cohortMonth',cohort_month,'customers',cohort_customers,'activeNow',active_customers,
   'currentRetentionPct',case when cohort_customers=0 then 0 else round(active_customers::numeric*100/cohort_customers,1) end,
   'ageMonths',greatest(0,((extract(year from age(date_trunc('month',now()),cohort_month))*12)
    +extract(month from age(date_trunc('month',now()),cohort_month)))::integer)
  ) order by cohort_month desc) from cohorts),'[]'::jsonb),
  'renewalWatchlist',coalesce((select jsonb_agg(jsonb_build_object(
   'ownerId',owner_id,'email',email,'planCode',plan_code,'billingInterval',billing_interval,
   'amountMinor',amount_minor,'currency',currency,'currentPeriodEnd',current_period_end,
   'status',status,'health',health,
   'attention',case when status='past_due' then 'payment_recovery'
    when coalesce((health->>'score')::integer,0)<50 then 'retention_checkin'
    else 'renewal_value_checkin' end
  ) order by current_period_end asc) from renewals),'[]'::jsonb),
  'cancellationReasons',coalesce((select jsonb_agg(jsonb_build_object('reason',reason,'count',count)) from cancellation_reasons),'[]'::jsonb),
  'interventions',(select to_jsonb(interventions) from interventions),
  'experiments',coalesce((select jsonb_agg(to_jsonb(experiment_rows) - 'id') from experiment_rows),'[]'::jsonb)
 )
$$;

revoke all on executive_visuals.customer_growth_experiments,
 executive_visuals.customer_growth_experiment_assignments from public,anon,authenticated;
grant select,insert,update on executive_visuals.customer_growth_experiments,
 executive_visuals.customer_growth_experiment_assignments to service_role;
revoke delete,truncate on executive_visuals.customer_growth_experiments,
 executive_visuals.customer_growth_experiment_assignments from service_role;
revoke all on function executive_visuals.customer_growth_assign_experiment(uuid,text),
 executive_visuals.customer_growth_create_experiment(uuid,text,text,text,text,jsonb,timestamptz,timestamptz),
 executive_visuals.customer_growth_set_experiment_status(uuid,uuid,text),
 executive_visuals.customer_growth_record_intervention(uuid,uuid,text,text),
 executive_visuals.customer_growth_update_intervention(uuid,uuid,text,text),
 executive_visuals.customer_growth_admin_overview() from public,anon,authenticated;
grant execute on function executive_visuals.customer_growth_assign_experiment(uuid,text) to service_role;
grant execute on function executive_visuals.customer_growth_create_experiment(uuid,text,text,text,text,jsonb,timestamptz,timestamptz) to service_role;
grant execute on function executive_visuals.customer_growth_set_experiment_status(uuid,uuid,text) to service_role;
grant execute on function executive_visuals.customer_growth_record_intervention(uuid,uuid,text,text) to service_role;
grant execute on function executive_visuals.customer_growth_update_intervention(uuid,uuid,text,text) to service_role;
grant execute on function executive_visuals.customer_growth_admin_overview() to service_role;

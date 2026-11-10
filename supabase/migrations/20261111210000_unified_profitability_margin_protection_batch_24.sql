-- Batch 24: evidence-backed margin policies, immutable alerts and an in-app notification outbox.
create table if not exists executive_visuals.financial_margin_policies(
 id uuid primary key default gen_random_uuid(),
 scope_type text not null check(scope_type in('global','customer')),
 owner_id uuid references auth.users(id) on delete restrict,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 min_gross_margin_pct numeric(6,2),
 min_contribution_minor bigint,
 effective_from date not null,
 effective_to date,
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 check((scope_type='global' and owner_id is null) or (scope_type='customer' and owner_id is not null)),
 check(min_gross_margin_pct is null or min_gross_margin_pct between 0 and 100),
 check(min_contribution_minor is null or min_contribution_minor>=0),
 check(min_gross_margin_pct is not null or min_contribution_minor is not null),
 check(effective_to is null or effective_to>effective_from)
);
create index if not exists financial_margin_policy_lookup_idx
 on executive_visuals.financial_margin_policies(currency,scope_type,owner_id,effective_from desc);
alter table executive_visuals.financial_margin_policies enable row level security;
revoke all on executive_visuals.financial_margin_policies from public,anon,authenticated;
grant select,insert on executive_visuals.financial_margin_policies to service_role;
create trigger financial_margin_policies_immutable before update or delete
 on executive_visuals.financial_margin_policies for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();

create table if not exists executive_visuals.financial_margin_alert_events(
 id uuid primary key default gen_random_uuid(),
 policy_id uuid not null references executive_visuals.financial_margin_policies(id) on delete restrict,
 period_month date not null check(period_month=date_trunc('month',period_month)::date),
 owner_id uuid not null references auth.users(id) on delete restrict,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 alert_type text not null check(alert_type in('margin_below_threshold','negative_contribution')),
 mrr_minor bigint not null,
 direct_cost_minor bigint not null,
 contribution_minor bigint not null,
 gross_margin_pct numeric(8,2),
 threshold_margin_pct numeric(6,2),
 threshold_contribution_minor bigint,
 idempotency_key text not null unique,
 evidence jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index if not exists financial_margin_alert_period_idx
 on executive_visuals.financial_margin_alert_events(period_month,currency,created_at desc);
create index if not exists financial_margin_alert_customer_idx
 on executive_visuals.financial_margin_alert_events(owner_id,period_month,created_at desc);
alter table executive_visuals.financial_margin_alert_events enable row level security;
revoke all on executive_visuals.financial_margin_alert_events from public,anon,authenticated;
grant select,insert on executive_visuals.financial_margin_alert_events to service_role;
create trigger financial_margin_alert_events_immutable before update or delete
 on executive_visuals.financial_margin_alert_events for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();

create table if not exists executive_visuals.financial_margin_notification_outbox(
 id uuid primary key default gen_random_uuid(),
 alert_id uuid not null unique references executive_visuals.financial_margin_alert_events(id) on delete restrict,
 channel text not null check(channel='in_app'),
 delivery_status text not null default 'pending' check(delivery_status in('pending','leased','sent','failed')),
 attempts integer not null default 0 check(attempts>=0),
 next_attempt_at timestamptz not null default now(),
 delivered_at timestamptz,
 last_error_code text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check((delivery_status='sent' and delivered_at is not null) or (delivery_status<>'sent' and delivered_at is null))
);
create index if not exists financial_margin_outbox_pending_idx
 on executive_visuals.financial_margin_notification_outbox(next_attempt_at,created_at)
 where delivery_status in('pending','failed');
alter table executive_visuals.financial_margin_notification_outbox enable row level security;
revoke all on executive_visuals.financial_margin_notification_outbox from public,anon,authenticated;
grant select,insert,update on executive_visuals.financial_margin_notification_outbox to service_role;

create or replace function executive_visuals.add_financial_margin_policy(
 p_actor_id uuid,p_scope_type text,p_owner_id uuid,p_currency text,
 p_min_gross_margin_pct numeric,p_min_contribution_minor bigint,
 p_effective_from date,p_effective_to date,p_idempotency_key text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_id uuid;v_existing financial_margin_policies%rowtype;v_duplicate boolean:=false;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_scope_type not in('global','customer')
  or (p_scope_type='global' and p_owner_id is not null)
  or (p_scope_type='customer' and p_owner_id is null)
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$'
  or (p_min_gross_margin_pct is null and p_min_contribution_minor is null)
  or (p_min_gross_margin_pct is not null and (p_min_gross_margin_pct<0 or p_min_gross_margin_pct>100))
  or (p_min_contribution_minor is not null and p_min_contribution_minor<0)
  or p_effective_from is null or p_effective_from<>date_trunc('month',p_effective_from)::date
  or (p_effective_to is not null and (p_effective_to<=p_effective_from or p_effective_to<>date_trunc('month',p_effective_to)::date))
  or coalesce(length(p_idempotency_key),0) not between 8 and 160 then
  raise exception 'Invalid financial margin policy' using errcode='22023';
 end if;
 select * into v_existing from financial_margin_policies where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.scope_type<>p_scope_type or v_existing.owner_id is distinct from p_owner_id
   or v_existing.currency<>p_currency
   or v_existing.min_gross_margin_pct is distinct from p_min_gross_margin_pct
   or v_existing.min_contribution_minor is distinct from p_min_contribution_minor
   or v_existing.effective_from<>p_effective_from
   or v_existing.effective_to is distinct from p_effective_to then
   raise exception 'Margin policy idempotency key conflicts with existing evidence' using errcode='23505';
  end if;
  return jsonb_build_object('policyId',v_existing.id,'duplicate',true);
 end if;
 perform pg_advisory_xact_lock(hashtext('financial-margin-policy:'||p_scope_type||':'||
  coalesce(p_owner_id::text,'global')||':'||p_currency));
 if exists(select 1 from financial_margin_policies p
  where p.scope_type=p_scope_type and p.owner_id is not distinct from p_owner_id
   and p.currency=p_currency
   and p.effective_from<coalesce(p_effective_to,'infinity'::date)
   and coalesce(p.effective_to,'infinity'::date)>p_effective_from) then
  raise exception 'Margin policy effective dates overlap an existing policy; create a non-overlapping version' using errcode='22023';
 end if;
 insert into financial_margin_policies(scope_type,owner_id,currency,min_gross_margin_pct,
  min_contribution_minor,effective_from,effective_to,idempotency_key,created_by)
 values(p_scope_type,p_owner_id,p_currency,p_min_gross_margin_pct,p_min_contribution_minor,
  p_effective_from,p_effective_to,p_idempotency_key,p_actor_id) returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.margin_policy.created',
  'financial_margin_policy',v_id::text,'Created versioned margin protection policy',
  p_idempotency_key,jsonb_build_object('scopeType',p_scope_type,'ownerId',p_owner_id,
   'currency',p_currency,'minGrossMarginPct',p_min_gross_margin_pct,
   'minContributionMinor',p_min_contribution_minor,'effectiveFrom',p_effective_from,
   'effectiveTo',p_effective_to));
 return jsonb_build_object('policyId',v_id,'duplicate',v_duplicate);
end $$;

create or replace function executive_visuals.evaluate_financial_margin_alerts(p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_report jsonb;v_period date;v_customer jsonb;v_owner uuid;v_currency text;
 v_margin numeric;v_contribution bigint;v_mrr bigint;v_direct_cost bigint;
 v_policy financial_margin_policies%rowtype;v_alert_id uuid;v_type text;
 v_created integer:=0;v_evaluated integer:=0;v_policy_count integer:=0;v_alerts jsonb:='[]'::jsonb;
 v_key text;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 v_report:=financial_profitability_overview(p_actor_id);
 v_period:=nullif(v_report->>'periodMonth','')::date;
 if v_period is null then
  return jsonb_build_object('periodMonth',null,'evaluatedCustomers',0,'policiesApplied',0,
   'alertsCreated',0,'alerts',jsonb_build_array(),
   'limitations',jsonb_build_array('No recorded subscription revenue snapshot is available.'));
 end if;
 for v_customer in
  select value from jsonb_array_elements(
   case when jsonb_typeof(v_report->'customers')='array' then v_report->'customers' else '[]'::jsonb end
  )
 loop
  v_evaluated:=v_evaluated+1;
  v_owner:=nullif(v_customer->>'ownerId','')::uuid;
  v_currency:=v_customer->>'currency';
  v_margin:=nullif(v_customer->>'grossMarginPct','')::numeric;
  v_contribution:=coalesce(nullif(v_customer->>'grossContributionMinor','')::bigint,0);
  v_mrr:=coalesce(nullif(v_customer->>'mrrMinor','')::bigint,0);
  v_direct_cost:=coalesce(nullif(v_customer->>'directCostMinor','')::bigint,0);
  if v_owner is null or v_currency is null then continue; end if;
  select * into v_policy from financial_margin_policies p
  where p.currency=v_currency and p.effective_from<=v_period
   and (p.effective_to is null or p.effective_to>v_period)
   and (p.scope_type='global' or (p.scope_type='customer' and p.owner_id=v_owner))
  order by case when p.scope_type='customer' then 0 else 1 end,p.effective_from desc
  limit 1;
  if not found then continue; end if;
  v_policy_count:=v_policy_count+1;
  if not ((v_policy.min_gross_margin_pct is not null and
      (v_margin is null or v_margin<v_policy.min_gross_margin_pct))
    or (v_policy.min_contribution_minor is not null and v_contribution<v_policy.min_contribution_minor)) then
   continue;
  end if;
  v_type:=case when v_contribution<0 then 'negative_contribution' else 'margin_below_threshold' end;
  v_key:='financial-margin:'||v_period::text||':'||v_owner::text||':'||v_currency||':'||v_policy.id::text||':'||v_type;
  insert into financial_margin_alert_events(policy_id,period_month,owner_id,currency,alert_type,
   mrr_minor,direct_cost_minor,contribution_minor,gross_margin_pct,threshold_margin_pct,
   threshold_contribution_minor,idempotency_key,evidence)
  values(v_policy.id,v_period,v_owner,v_currency,v_type,v_mrr,v_direct_cost,v_contribution,
   v_margin,v_policy.min_gross_margin_pct,v_policy.min_contribution_minor,v_key,
   jsonb_build_object('source','financial_profitability_overview','snapshotMonth',v_period,
    'policyScope',v_policy.scope_type,'revenueBasis','subscription_mrr',
    'costBasis','recorded_direct_service_cost_events',
    'sharedOverheadAllocated',false))
  on conflict(idempotency_key) do nothing returning id into v_alert_id;
  if v_alert_id is not null then
   v_created:=v_created+1;
   insert into financial_margin_notification_outbox(alert_id,channel,delivery_status)
   values(v_alert_id,'in_app','pending') on conflict(alert_id) do nothing;
   v_alerts:=v_alerts||jsonb_build_array(jsonb_build_object('alertId',v_alert_id,
    'ownerId',v_owner,'currency',v_currency,'alertType',v_type,
    'grossMarginPct',v_margin,'grossContributionMinor',v_contribution));
  end if;
 end loop;
 return jsonb_build_object('periodMonth',v_period,'evaluatedCustomers',v_evaluated,
  'policiesApplied',v_policy_count,'alertsCreated',v_created,'alerts',v_alerts,
  'limitations',jsonb_build_array(
   'Margin alerts use the latest recorded subscription revenue snapshot and Batch 20 direct service-cost ledger.',
   'AI usage and worker resource metering are not automatically added to this margin calculation until reconciled into the service-cost ledger; avoid double counting invoice costs.',
   'Shared overhead remains separate and is not arbitrarily allocated.',
   'Alerts create in-app outbox records only; external email, SMS and chat delivery are not enabled.'
  ));
end $$;

create or replace function executive_visuals.list_financial_margin_alerts(p_actor_id uuid,p_limit integer default 50)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_alerts jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_limit is null or p_limit<1 or p_limit>200 then
  raise exception 'Invalid financial alert limit' using errcode='22023';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'alertId',a.id,'periodMonth',a.period_month,'ownerId',a.owner_id,'currency',a.currency,
  'alertType',a.alert_type,'mrrMinor',a.mrr_minor,'directCostMinor',a.direct_cost_minor,
  'grossContributionMinor',a.contribution_minor,'grossMarginPct',a.gross_margin_pct,
  'thresholdMarginPct',a.threshold_margin_pct,'thresholdContributionMinor',a.threshold_contribution_minor,
  'createdAt',a.created_at,'notificationStatus',coalesce(o.delivery_status,'pending')
 ) order by a.created_at desc),'[]'::jsonb) into v_alerts
 from(
  select * from financial_margin_alert_events order by created_at desc limit p_limit
 ) a left join financial_margin_notification_outbox o on o.alert_id=a.id;
 return jsonb_build_object('alerts',v_alerts,'count',jsonb_array_length(v_alerts));
end $$;

revoke all on function executive_visuals.add_financial_margin_policy(uuid,text,uuid,text,numeric,bigint,date,date,text) from public,anon,authenticated;
revoke all on function executive_visuals.evaluate_financial_margin_alerts(uuid) from public,anon,authenticated;
revoke all on function executive_visuals.list_financial_margin_alerts(uuid,integer) from public,anon,authenticated;
grant execute on function executive_visuals.add_financial_margin_policy(uuid,text,uuid,text,numeric,bigint,date,date,text) to service_role;
grant execute on function executive_visuals.evaluate_financial_margin_alerts(uuid) to service_role;
grant execute on function executive_visuals.list_financial_margin_alerts(uuid,integer) to service_role;

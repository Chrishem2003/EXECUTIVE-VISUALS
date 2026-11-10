-- Batch 44: configurable treasury stress testing and contingency funding options.
create table if not exists executive_visuals.financial_liquidity_stress_scenarios(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references auth.users(id) on delete restrict,
 name text not null check(length(trim(name)) between 3 and 120),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 inflow_reduction_bps integer not null check(inflow_reduction_bps between 0 and 10000),
 outflow_increase_bps integer not null check(outflow_increase_bps between 0 and 30000),
 immediate_cash_shock_minor bigint not null default 0 check(immediate_cash_shock_minor>=0),
 source_reference text not null check(length(trim(source_reference)) between 3 and 240),
 rationale text not null check(length(trim(rationale)) between 3 and 1000),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 created_at timestamptz not null default now()
);
create index if not exists financial_liquidity_stress_scenarios_currency_idx
 on executive_visuals.financial_liquidity_stress_scenarios(currency,created_at desc);

create table if not exists executive_visuals.financial_liquidity_stress_runs(
 id uuid primary key default gen_random_uuid(),
 scenario_id uuid not null references executive_visuals.financial_liquidity_stress_scenarios(id) on delete restrict,
 actor_id uuid not null references auth.users(id) on delete restrict,
 result jsonb not null,
 created_at timestamptz not null default now()
);
create index if not exists financial_liquidity_stress_runs_latest_idx
 on executive_visuals.financial_liquidity_stress_runs(scenario_id,created_at desc);

create table if not exists executive_visuals.financial_contingency_options(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references auth.users(id) on delete restrict,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 title text not null check(length(trim(title)) between 3 and 160),
 category text not null check(category in('receivables_acceleration','discretionary_spend','supplier_terms','committed_facility','asset_monetization','owner_funding','other')),
 estimated_capacity_minor bigint not null check(estimated_capacity_minor>=0),
 lead_time_hours integer not null check(lead_time_hours between 0 and 8760),
 availability_status text not null check(availability_status in('validated','conditional','unverified')),
 source_reference text not null check(length(trim(source_reference)) between 3 and 240),
 rationale text not null check(length(trim(rationale)) between 3 and 1000),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 created_at timestamptz not null default now()
);
create index if not exists financial_contingency_options_currency_idx
 on executive_visuals.financial_contingency_options(currency,availability_status,lead_time_hours);

create or replace function executive_visuals.record_financial_liquidity_stress_scenario(p_actor_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_row financial_liquidity_stress_scenarios%rowtype; v_name text; v_currency text; v_inflow integer; v_outflow integer; v_shock bigint; v_ref text; v_rationale text; v_key text;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 v_name:=trim(p_payload->>'name');v_currency:=upper(p_payload->>'currency');
 v_inflow:=(p_payload->>'inflowReductionBps')::integer;v_outflow:=(p_payload->>'outflowIncreaseBps')::integer;
 v_shock:=(p_payload->>'immediateCashShockMinor')::bigint;v_ref:=trim(p_payload->>'sourceReference');
 v_rationale:=trim(p_payload->>'rationale');v_key:=p_payload->>'idempotencyKey';
 if v_name is null or length(v_name) not between 3 and 120 or v_currency is null or v_currency !~ '^[A-Z]{3}$' or
  v_inflow is null or v_inflow not between 0 and 10000 or v_outflow is null or v_outflow not between 0 and 30000 or
  v_shock is null or v_shock<0 or v_ref is null or length(v_ref) not between 3 and 240 or
  v_rationale is null or length(v_rationale) not between 3 and 1000 or v_key is null or length(v_key) not between 8 and 160 then
  raise exception 'Invalid treasury stress scenario assumptions or evidence' using errcode='22023';
 end if;
 insert into financial_liquidity_stress_scenarios(actor_id,name,currency,inflow_reduction_bps,outflow_increase_bps,immediate_cash_shock_minor,source_reference,rationale,idempotency_key)
 values(p_actor_id,v_name,v_currency,v_inflow,v_outflow,v_shock,v_ref,v_rationale,v_key) on conflict(idempotency_key) do nothing;
 select * into v_row from financial_liquidity_stress_scenarios where idempotency_key=v_key;
 if v_row.actor_id<>p_actor_id or v_row.name<>v_name or v_row.currency<>v_currency or v_row.inflow_reduction_bps<>v_inflow or
  v_row.outflow_increase_bps<>v_outflow or v_row.immediate_cash_shock_minor<>v_shock or v_row.source_reference<>v_ref or v_row.rationale<>v_rationale then
  raise exception 'Stress scenario idempotency key conflicts with existing assumptions' using errcode='23505';
 end if;
 return jsonb_build_object('id',v_row.id,'name',v_row.name,'currency',v_row.currency,'inflowReductionBps',v_row.inflow_reduction_bps,
  'outflowIncreaseBps',v_row.outflow_increase_bps,'immediateCashShockMinor',v_row.immediate_cash_shock_minor,
  'sourceReference',v_row.source_reference,'rationale',v_row.rationale,'createdAt',v_row.created_at);
end $$;

create or replace function executive_visuals.record_financial_contingency_option(p_actor_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_row financial_contingency_options%rowtype; v_currency text; v_capacity bigint; v_lead integer; v_key text;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 v_currency:=upper(p_payload->>'currency');v_capacity:=(p_payload->>'estimatedCapacityMinor')::bigint;
 v_lead:=(p_payload->>'leadTimeHours')::integer;v_key:=p_payload->>'idempotencyKey';
 if v_currency is null or v_currency !~ '^[A-Z]{3}$' or p_payload->>'title' is null or
  length(trim(p_payload->>'title')) not between 3 and 160 or
  p_payload->>'category' is null or p_payload->>'category' not in('receivables_acceleration','discretionary_spend','supplier_terms','committed_facility','asset_monetization','owner_funding','other') or
  v_capacity is null or v_capacity<0 or v_lead is null or v_lead not between 0 and 8760 or
  p_payload->>'availabilityStatus' is null or p_payload->>'availabilityStatus' not in('validated','conditional','unverified') or
  length(trim(p_payload->>'sourceReference')) not between 3 and 240 or length(trim(p_payload->>'rationale')) not between 3 and 1000 or
  v_key is null or length(v_key) not between 8 and 160 then raise exception 'Invalid contingency funding option or supporting evidence' using errcode='22023'; end if;
 insert into financial_contingency_options(actor_id,currency,title,category,estimated_capacity_minor,lead_time_hours,availability_status,source_reference,rationale,idempotency_key)
 values(p_actor_id,v_currency,trim(p_payload->>'title'),p_payload->>'category',v_capacity,v_lead,p_payload->>'availabilityStatus',
  trim(p_payload->>'sourceReference'),trim(p_payload->>'rationale'),v_key) on conflict(idempotency_key) do nothing;
 select * into v_row from financial_contingency_options where idempotency_key=v_key;
 if v_row.actor_id<>p_actor_id or v_row.currency<>v_currency or v_row.estimated_capacity_minor<>v_capacity or
  v_row.lead_time_hours<>v_lead or v_row.title<>trim(p_payload->>'title') then
  raise exception 'Contingency option idempotency key conflicts with existing evidence' using errcode='23505';
 end if;
 return jsonb_build_object('id',v_row.id,'currency',v_row.currency,'title',v_row.title,'category',v_row.category,
  'estimatedCapacityMinor',v_row.estimated_capacity_minor,'leadTimeHours',v_row.lead_time_hours,
  'availabilityStatus',v_row.availability_status,'sourceReference',v_row.source_reference,'createdAt',v_row.created_at);
end $$;

create or replace function executive_visuals.run_financial_liquidity_stress_test(p_actor_id uuid,p_scenario_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_scenario financial_liquidity_stress_scenarios%rowtype;v_forecast jsonb;v_base jsonb;v_policy jsonb;
 v_weekly jsonb;v_result jsonb;v_run_id uuid;v_opening bigint;v_floor bigint;v_shock bigint;v_lowest bigint;v_negative date;v_floor_breach date;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 select * into v_scenario from financial_liquidity_stress_scenarios where id=p_scenario_id;
 if not found then raise exception 'Treasury stress scenario not found' using errcode='P0002'; end if;
 v_forecast:=financial_cashflow_forecast_overview(p_actor_id);
 select value into v_base from jsonb_array_elements(coalesce(v_forecast->'scenarios','[]'::jsonb))
  where value->>'currency'=v_scenario.currency and value->>'scenario'='base' limit 1;
 if v_base is null then raise exception 'No captured cash position or baseline forecast exists for this currency' using errcode='22023'; end if;
 select value into v_policy from jsonb_array_elements(coalesce(financial_liquidity_guardrails_overview(p_actor_id)->'policies','[]'::jsonb))
  where value->>'currency'=v_scenario.currency limit 1;
 v_floor:=nullif(v_policy->>'minimumCashFloorMinor','')::bigint;
 v_opening:=(v_base->>'openingAvailableCashMinor')::bigint;v_shock:=v_scenario.immediate_cash_shock_minor;
 with weekly as(
  select (value->>'week')::integer week,(value->>'weekEnd')::date week_end,
   (value->>'expectedInflowsMinor')::bigint inflows,(value->>'expectedOutflowsMinor')::bigint outflows
  from jsonb_array_elements(coalesce(v_base->'weekly','[]'::jsonb))
 ), stressed as(
  select week,week_end,inflows,outflows,
   round(inflows::numeric*(10000-v_scenario.inflow_reduction_bps)/10000)::bigint stressed_inflows,
   round(outflows::numeric*(10000+v_scenario.outflow_increase_bps)/10000)::bigint stressed_outflows
  from weekly
 ), balances as(
  select *,v_opening-v_shock+sum(stressed_inflows-stressed_outflows) over(order by week) closing
  from stressed
 )
 select jsonb_agg(jsonb_build_object('week',week,'weekEnd',week_end,'baselineInflowsMinor',inflows,'baselineOutflowsMinor',outflows,
  'stressedInflowsMinor',stressed_inflows,'stressedOutflowsMinor',stressed_outflows,'projectedClosingMinor',closing,
  'belowMinimumCashFloor',case when v_floor is null then null else closing<v_floor end,'negativeCash',closing<0) order by week),
  min(closing),min(week_end) filter(where closing<0),min(week_end) filter(where v_floor is not null and closing<v_floor)
 into v_weekly, v_lowest, v_negative, v_floor_breach from balances;
 -- Recalculate summary values independently from the immutable weekly result.
 v_result:=jsonb_build_object('scenarioId',v_scenario.id,'scenarioName',v_scenario.name,'currency',v_scenario.currency,
  'baselineOpeningAvailableCashMinor',v_base->>'openingAvailableCashMinor','immediateCashShockMinor',v_scenario.immediate_cash_shock_minor,
  'inflowReductionBps',v_scenario.inflow_reduction_bps,'outflowIncreaseBps',v_scenario.outflow_increase_bps,
  'minimumCashFloorMinor',v_floor,'weekly',coalesce(v_weekly,'[]'::jsonb),
  'lowestProjectedCashMinor',v_lowest,'firstNegativeCashDate',v_negative,'firstFloorBreachDate',v_floor_breach,
  'contingencyOptions',coalesce((select jsonb_agg(jsonb_build_object('title',o.title,'category',o.category,
   'estimatedCapacityMinor',o.estimated_capacity_minor,'leadTimeHours',o.lead_time_hours,'availabilityStatus',o.availability_status,
   'sourceReference',o.source_reference,'rationale',o.rationale) order by case o.availability_status when 'validated' then 1 when 'conditional' then 2 else 3 end,o.lead_time_hours)
   from financial_contingency_options o where o.currency=v_scenario.currency),'[]'::jsonb),
  'limitations',jsonb_build_array('Stress test is a sensitivity overlay on the captured base forecast, not a probability-weighted prediction.',
   'Cash shocks are applied at the start of the horizon; weekly receipt and payment assumptions are stressed uniformly.',
   'Contingency capacities are user-entered gross estimates, not committed or immediately available cash. Unverified and conditional options must not be treated as funding.',
   'No facility drawdown, asset sale, supplier deferral, payment or transfer is executed. Management approval and legal/operational readiness are required.'));
 v_result:=v_result||jsonb_build_object('runAt',now());
 insert into financial_liquidity_stress_runs(scenario_id,actor_id,result) values(p_scenario_id,p_actor_id,v_result) returning id into v_run_id;
 return v_result||jsonb_build_object('runId',v_run_id);
end $$;

create or replace function executive_visuals.financial_liquidity_stress_overview(p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 select jsonb_build_object(
  'scenarios',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'currency',s.currency,
   'inflowReductionBps',s.inflow_reduction_bps,'outflowIncreaseBps',s.outflow_increase_bps,
   'immediateCashShockMinor',s.immediate_cash_shock_minor,'sourceReference',s.source_reference,'rationale',s.rationale,'createdAt',s.created_at)
   order by s.created_at desc) from financial_liquidity_stress_scenarios s),'[]'::jsonb),
  'runs',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'scenarioId',r.scenario_id,'createdAt',r.created_at,'result',r.result)
   order by r.created_at desc) from (select * from financial_liquidity_stress_runs order by created_at desc limit 30) r),'[]'::jsonb),
  'contingencyOptions',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'currency',o.currency,'title',o.title,'category',o.category,
   'estimatedCapacityMinor',o.estimated_capacity_minor,'leadTimeHours',o.lead_time_hours,'availabilityStatus',o.availability_status,
   'sourceReference',o.source_reference,'rationale',o.rationale) order by o.currency,o.lead_time_hours)
   from financial_contingency_options o),'[]'::jsonb)
 ) into v_result;
 return v_result;
end $$;

create or replace function executive_visuals.prevent_financial_liquidity_stress_mutation()
returns trigger language plpgsql set search_path=pg_catalog,executive_visuals
as $$ begin raise exception 'Treasury stress scenarios, runs and contingency options are append-only.' using errcode='55000'; end $$;
drop trigger if exists financial_liquidity_stress_scenario_immutable on executive_visuals.financial_liquidity_stress_scenarios;
create trigger financial_liquidity_stress_scenario_immutable before update or delete on executive_visuals.financial_liquidity_stress_scenarios for each row execute function executive_visuals.prevent_financial_liquidity_stress_mutation();
drop trigger if exists financial_liquidity_stress_run_immutable on executive_visuals.financial_liquidity_stress_runs;
create trigger financial_liquidity_stress_run_immutable before update or delete on executive_visuals.financial_liquidity_stress_runs for each row execute function executive_visuals.prevent_financial_liquidity_stress_mutation();
drop trigger if exists financial_contingency_option_immutable on executive_visuals.financial_contingency_options;
create trigger financial_contingency_option_immutable before update or delete on executive_visuals.financial_contingency_options for each row execute function executive_visuals.prevent_financial_liquidity_stress_mutation();

revoke all on table executive_visuals.financial_liquidity_stress_scenarios,executive_visuals.financial_liquidity_stress_runs,executive_visuals.financial_contingency_options from public,anon,authenticated;
grant all on table executive_visuals.financial_liquidity_stress_scenarios,executive_visuals.financial_liquidity_stress_runs,executive_visuals.financial_contingency_options to service_role;
revoke all on function executive_visuals.record_financial_liquidity_stress_scenario(uuid,jsonb),executive_visuals.record_financial_contingency_option(uuid,jsonb),executive_visuals.run_financial_liquidity_stress_test(uuid,uuid),executive_visuals.financial_liquidity_stress_overview(uuid),executive_visuals.prevent_financial_liquidity_stress_mutation() from public,anon,authenticated;
grant execute on function executive_visuals.record_financial_liquidity_stress_scenario(uuid,jsonb),executive_visuals.record_financial_contingency_option(uuid,jsonb),executive_visuals.run_financial_liquidity_stress_test(uuid,uuid),executive_visuals.financial_liquidity_stress_overview(uuid),executive_visuals.prevent_financial_liquidity_stress_mutation() to service_role;

-- Batch 42: configurable currency-specific minimum cash floors and reserve targets.
create table if not exists executive_visuals.financial_liquidity_policies(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references auth.users(id) on delete restrict,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 minimum_cash_floor_minor bigint not null check(minimum_cash_floor_minor>=0),
 reserve_target_minor bigint not null check(reserve_target_minor>=minimum_cash_floor_minor),
 effective_from date not null,
 source_reference text not null check(length(trim(source_reference)) between 3 and 240),
 rationale text not null check(length(trim(rationale)) between 3 and 1000),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 created_at timestamptz not null default now()
);
create index if not exists financial_liquidity_policy_currency_effective_idx
 on executive_visuals.financial_liquidity_policies(currency,effective_from desc,created_at desc);

create or replace function executive_visuals.record_financial_liquidity_policy(p_actor_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_row financial_liquidity_policies%rowtype;
 v_currency text;
 v_floor bigint;
 v_reserve bigint;
 v_effective date;
 v_reference text;
 v_rationale text;
 v_key text;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 v_currency:=upper(p_payload->>'currency');
 v_floor:=(p_payload->>'minimumCashFloorMinor')::bigint;
 v_reserve:=(p_payload->>'reserveTargetMinor')::bigint;
 v_effective:=(p_payload->>'effectiveFrom')::date;
 v_reference:=trim(p_payload->>'sourceReference');
 v_rationale:=trim(p_payload->>'rationale');
 v_key:=p_payload->>'idempotencyKey';
 if v_currency !~ '^[A-Z]{3}$' or v_floor is null or v_floor<0 or v_reserve is null or v_reserve<v_floor or
  v_effective is null or v_effective<current_date or length(v_reference) not between 3 and 240 or
  length(v_rationale) not between 3 and 1000 or length(v_key) not between 8 and 160 then
  raise exception 'Valid currency, non-negative floor, reserve target at least the floor, non-backdated effective date and policy evidence are required' using errcode='22023';
 end if;
 insert into financial_liquidity_policies(actor_id,currency,minimum_cash_floor_minor,reserve_target_minor,effective_from,source_reference,rationale,idempotency_key)
 values(p_actor_id,v_currency,v_floor,v_reserve,v_effective,v_reference,v_rationale,v_key)
 on conflict(idempotency_key) do nothing;
 select * into v_row from financial_liquidity_policies where idempotency_key=v_key;
 if v_row.actor_id<>p_actor_id or v_row.currency<>v_currency or v_row.minimum_cash_floor_minor<>v_floor or
  v_row.reserve_target_minor<>v_reserve or v_row.effective_from<>v_effective or
  v_row.source_reference<>v_reference or v_row.rationale<>v_rationale then
  raise exception 'Liquidity policy idempotency key conflicts with existing policy evidence' using errcode='23505';
 end if;
 return jsonb_build_object('id',v_row.id,'currency',v_row.currency,'minimumCashFloorMinor',v_row.minimum_cash_floor_minor,
  'reserveTargetMinor',v_row.reserve_target_minor,'effectiveFrom',v_row.effective_from,'sourceReference',v_row.source_reference,
  'rationale',v_row.rationale,'createdAt',v_row.created_at);
end $$;

create or replace function executive_visuals.prevent_financial_liquidity_policy_mutation()
returns trigger language plpgsql
set search_path=pg_catalog,executive_visuals
as $$
begin
 raise exception 'Liquidity policies are append-only; create a new effective-dated policy instead.' using errcode='55000';
end $$;
drop trigger if exists financial_liquidity_policy_immutable on executive_visuals.financial_liquidity_policies;
create trigger financial_liquidity_policy_immutable before update or delete on executive_visuals.financial_liquidity_policies
 for each row execute function executive_visuals.prevent_financial_liquidity_policy_mutation();

create or replace function executive_visuals.financial_liquidity_guardrails_overview(p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 with latest_policies as(
  select distinct on(p.currency) p.currency,p.minimum_cash_floor_minor,p.reserve_target_minor,p.effective_from,p.source_reference,p.rationale,p.created_at
  from financial_liquidity_policies p where p.effective_from<=current_date
  order by p.currency,p.effective_from desc,p.created_at desc
 ), forecast as(
  select executive_visuals.financial_cashflow_forecast_overview(p_actor_id) data
 ), scenario_rows as(
  select s.value->>'currency' currency,s.value->>'scenario' scenario,s.value->'weekly' weekly
  from forecast f cross join lateral jsonb_array_elements(coalesce(f.data->'scenarios','[]'::jsonb)) s(value)
 ), weekly_rows as(
  select s.currency,s.scenario,p.minimum_cash_floor_minor,p.reserve_target_minor,
   (w.value->>'weekEnd')::date week_end,(w.value->>'projectedClosingMinor')::bigint projected_closing_minor,
   case when p.minimum_cash_floor_minor is not null then (w.value->>'projectedClosingMinor')::bigint-p.minimum_cash_floor_minor else null end headroom_minor,
   case when p.reserve_target_minor is not null then greatest(p.reserve_target_minor-(w.value->>'projectedClosingMinor')::bigint,0) else null end reserve_gap_minor
  from scenario_rows s cross join lateral jsonb_array_elements(coalesce(s.weekly,'[]'::jsonb)) w(value)
  left join latest_policies p on p.currency=s.currency
 ), scenario_summary as(
  select w.currency,w.scenario,w.minimum_cash_floor_minor,w.reserve_target_minor,
   min(w.projected_closing_minor)::bigint lowest_projected_closing_minor,
   min(w.headroom_minor)::bigint lowest_headroom_minor,
   min(w.week_end) filter(where w.headroom_minor<0) first_floor_breach_date,
   max(w.reserve_gap_minor)::bigint maximum_reserve_gap_minor,
   jsonb_agg(jsonb_build_object('weekEnd',w.week_end,'projectedClosingMinor',w.projected_closing_minor,
    'headroomMinor',w.headroom_minor,'reserveGapMinor',w.reserve_gap_minor,'belowMinimumCashFloor',coalesce(w.headroom_minor<0,false),
    'belowReserveTarget',coalesce(w.projected_closing_minor<w.reserve_target_minor,false)) order by w.week_end) weekly
  from weekly_rows w group by w.currency,w.scenario,w.minimum_cash_floor_minor,w.reserve_target_minor
 )
 select jsonb_build_object(
  'generatedAt',now(),
  'policies',coalesce((select jsonb_agg(jsonb_build_object('currency',p.currency,'minimumCashFloorMinor',p.minimum_cash_floor_minor,
   'reserveTargetMinor',p.reserve_target_minor,'effectiveFrom',p.effective_from,'sourceReference',p.source_reference,
   'rationale',p.rationale) order by p.currency) from latest_policies p),'[]'::jsonb),
  'scenarios',coalesce((select jsonb_agg(jsonb_build_object('currency',s.currency,'scenario',s.scenario,
   'minimumCashFloorMinor',s.minimum_cash_floor_minor,'reserveTargetMinor',s.reserve_target_minor,
   'lowestProjectedClosingMinor',s.lowest_projected_closing_minor,'lowestHeadroomMinor',s.lowest_headroom_minor,
   'firstFloorBreachDate',s.first_floor_breach_date,'maximumReserveGapMinor',s.maximum_reserve_gap_minor,'weekly',s.weekly)
   order by s.currency,case s.scenario when 'base' then 1 when 'downside' then 2 else 3 end) from scenario_summary s),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Liquidity floors and reserve targets are policy thresholds, not forecasts, guarantees or cash availability.',
   'Policies are currency-specific, effective-dated and append-only; a new record supersedes an earlier policy from its effective date.',
   'Headroom is projected closing available cash minus the configured minimum cash floor. Restricted cash remains excluded.',
   'A reserve gap measures the amount below the reserve target; it is not automatically a funding requirement or payment instruction.',
   'Forecast scenarios inherit the evidence, freshness and assumption limitations of the cashflow forecast.'
  )
 ) into v_result;
 return v_result;
end $$;

revoke all on table executive_visuals.financial_liquidity_policies from public,anon,authenticated;
grant all on table executive_visuals.financial_liquidity_policies to service_role;
revoke all on function executive_visuals.prevent_financial_liquidity_policy_mutation() from public,anon,authenticated;
grant execute on function executive_visuals.prevent_financial_liquidity_policy_mutation() to service_role;
revoke all on function executive_visuals.record_financial_liquidity_policy(uuid,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.financial_liquidity_guardrails_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.record_financial_liquidity_policy(uuid,jsonb) to service_role;
grant execute on function executive_visuals.financial_liquidity_guardrails_overview(uuid) to service_role;

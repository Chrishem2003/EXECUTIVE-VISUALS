-- Batch 42: policy-backed liquidity floor and reserve headroom.
reset role;
set role service_role;
do $batch42$
declare
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
 v_policy jsonb;
 v_replay jsonb;
 v_report jsonb;
 v_base jsonb;
 v_downside jsonb;
 v_upside jsonb;
 v_unconfigured jsonb;
begin
 v_policy:=executive_visuals.record_financial_liquidity_policy(v_actor,jsonb_build_object(
  'currency','ZZZ','minimumCashFloorMinor',800000,'reserveTargetMinor',1200000,'effectiveFrom',current_date,
  'sourceReference','batch42-board-policy','rationale','Protect operating cash and essential payroll reserve',
  'idempotencyKey','batch42-policy-001'));
 if (v_policy->>'minimumCashFloorMinor')::bigint<>800000 then raise exception 'Liquidity policy not recorded: %',v_policy; end if;
 v_replay:=executive_visuals.record_financial_liquidity_policy(v_actor,jsonb_build_object(
  'currency','ZZZ','minimumCashFloorMinor',800000,'reserveTargetMinor',1200000,'effectiveFrom',current_date,
  'sourceReference','batch42-board-policy','rationale','Protect operating cash and essential payroll reserve',
  'idempotencyKey','batch42-policy-001'));
 if v_replay->>'id'<>v_policy->>'id' then raise exception 'Idempotent policy replay created a duplicate: %',v_replay; end if;
 v_report:=executive_visuals.financial_liquidity_guardrails_overview(v_actor);
 select scenario_row.value into v_base from jsonb_array_elements(v_report->'scenarios') scenario_row(value)
  where scenario_row.value->>'currency'='ZZZ' and scenario_row.value->>'scenario'='base';
 select scenario_row.value into v_downside from jsonb_array_elements(v_report->'scenarios') scenario_row(value)
  where scenario_row.value->>'currency'='ZZZ' and scenario_row.value->>'scenario'='downside';
 select scenario_row.value into v_upside from jsonb_array_elements(v_report->'scenarios') scenario_row(value)
  where scenario_row.value->>'currency'='ZZZ' and scenario_row.value->>'scenario'='upside';
 if (v_base->>'minimumCashFloorMinor')::bigint<>800000 or (v_base->>'reserveTargetMinor')::bigint<>1200000 then
  raise exception 'Configured liquidity thresholds missing: %',v_base;
 end if;
 if (v_base->>'lowestHeadroomMinor')::bigint<>-1250000 or (v_base->>'firstFloorBreachDate')::date<>current_date+35 then
  raise exception 'Base scenario floor headroom or breach date incorrect: %',v_base;
 end if;
 if (v_downside->>'lowestHeadroomMinor')::bigint<>(-1320000) then
  raise exception 'Downside floor headroom incorrect: %',v_downside;
 end if;
 if (v_upside->>'lowestHeadroomMinor')::bigint<>(-1235000) then
  raise exception 'Upside floor headroom incorrect: %',v_upside;
 end if;
 if (v_base->>'maximumReserveGapMinor')::bigint<>1650000 then
  raise exception 'Reserve gap at projected trough incorrect: %',v_base;
 end if;
 select scenario_row.value into v_unconfigured from jsonb_array_elements(v_report->'scenarios') scenario_row(value)
  where scenario_row.value->>'currency'='AAA' and scenario_row.value->>'scenario'='base';
 if v_unconfigured->>'minimumCashFloorMinor' is not null or v_unconfigured->>'firstFloorBreachDate' is not null then
  raise exception 'Unconfigured currency should not inherit another currency policy: %',v_unconfigured;
 end if;
 begin
  perform executive_visuals.record_financial_liquidity_policy(v_actor,jsonb_build_object(
   'currency','ZZZ','minimumCashFloorMinor',900000,'reserveTargetMinor',800000,'effectiveFrom',current_date,
   'sourceReference','invalid-policy','rationale','Reserve below minimum floor','idempotencyKey','batch42-policy-bad'));
  raise exception 'Reserve target below minimum floor was accepted';
 exception when sqlstate '22023' then null;
 end;
 begin
  perform executive_visuals.record_financial_liquidity_policy(v_actor,jsonb_build_object(
   'currency','ZZZ','minimumCashFloorMinor',700000,'reserveTargetMinor',1100000,'effectiveFrom',current_date,
   'sourceReference','conflicting-policy','rationale','Conflicting idempotency replay','idempotencyKey','batch42-policy-001'));
  raise exception 'Conflicting policy idempotency replay was accepted';
 exception when sqlstate '23505' then null;
 end;
 begin
  update executive_visuals.financial_liquidity_policies set minimum_cash_floor_minor=0 where id=(v_policy->>'id')::uuid;
  raise exception 'Append-only liquidity policy accepted an update';
 exception when sqlstate '55000' then null;
 end;
 begin
  perform executive_visuals.financial_liquidity_guardrails_overview('88888888-8888-4888-8888-888888888888'::uuid);
  raise exception 'Unauthorized guardrail read was accepted';
 exception when sqlstate '42501' then null;
 end;
end $batch42$;
reset role;

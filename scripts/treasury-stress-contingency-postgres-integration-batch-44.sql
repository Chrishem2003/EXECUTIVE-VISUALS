-- Batch 44: treasury stress sensitivities, run snapshots and contingency readiness.
reset role;
set role service_role;
do $batch44$
declare
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
 v_scenario jsonb;v_replay jsonb;v_run jsonb;v_option jsonb;v_option_replay jsonb;v_overview jsonb;
 v_base jsonb;v_run_id uuid;v_capacity bigint;
begin
 v_scenario:=executive_visuals.record_financial_liquidity_stress_scenario(v_actor,jsonb_build_object(
  'name','Combined collections and supplier shock','currency','ZZZ','inflowReductionBps',5000,
  'outflowIncreaseBps',5000,'immediateCashShockMinor',100000,'sourceReference','batch44-risk-register',
  'rationale','Stress delayed receipts, supplier repricing and a one-off operating shock.','idempotencyKey','batch44-scenario-001'));
 if v_scenario->>'currency'<>'ZZZ' or (v_scenario->>'inflowReductionBps')::integer<>5000 then raise exception 'Stress scenario was not persisted: %',v_scenario; end if;
 v_replay:=executive_visuals.record_financial_liquidity_stress_scenario(v_actor,jsonb_build_object(
  'name','Combined collections and supplier shock','currency','ZZZ','inflowReductionBps',5000,
  'outflowIncreaseBps',5000,'immediateCashShockMinor',100000,'sourceReference','batch44-risk-register',
  'rationale','Stress delayed receipts, supplier repricing and a one-off operating shock.','idempotencyKey','batch44-scenario-001'));
 if v_replay->>'id'<>v_scenario->>'id' then raise exception 'Scenario idempotency replay created a duplicate'; end if;
 v_option:=executive_visuals.record_financial_contingency_option(v_actor,jsonb_build_object(
  'currency','ZZZ','title','Accelerate confirmed customer receivables','category','receivables_acceleration',
  'estimatedCapacityMinor',250000,'leadTimeHours',48,'availabilityStatus','conditional',
  'sourceReference','batch44-ar-aging','rationale','Subject to customer confirmation and collection team capacity.',
  'idempotencyKey','batch44-option-001'));
 if v_option->>'availabilityStatus'<>'conditional' then raise exception 'Contingency readiness status missing: %',v_option; end if;
 v_option_replay:=executive_visuals.record_financial_contingency_option(v_actor,jsonb_build_object(
  'currency','ZZZ','title','Accelerate confirmed customer receivables','category','receivables_acceleration',
  'estimatedCapacityMinor',250000,'leadTimeHours',48,'availabilityStatus','conditional',
  'sourceReference','batch44-ar-aging','rationale','Subject to customer confirmation and collection team capacity.',
  'idempotencyKey','batch44-option-001'));
 if v_option_replay->>'id'<>v_option->>'id' then raise exception 'Contingency option idempotency replay created a duplicate'; end if;
 begin
  perform executive_visuals.record_financial_contingency_option(v_actor,jsonb_build_object(
   'currency','ZZZ','title','Accelerate confirmed customer receivables','category','receivables_acceleration',
   'estimatedCapacityMinor',250000,'leadTimeHours',72,'availabilityStatus','conditional',
   'sourceReference','batch44-ar-aging','rationale','Subject to customer confirmation and collection team capacity.',
   'idempotencyKey','batch44-option-001'));
  raise exception 'Conflicting contingency option idempotency replay was accepted';
 exception when sqlstate '23505' then null;
 end;
 v_run:=executive_visuals.run_financial_liquidity_stress_test(v_actor,(v_scenario->>'id')::uuid);
 if jsonb_array_length(v_run->'weekly')<>13 then raise exception 'Expected 13 weekly stress results: %',v_run; end if;
 if (v_run->>'lowestProjectedCashMinor')::bigint>=1000000 then raise exception 'Stress test did not reduce baseline liquidity: %',v_run; end if;
 if (v_run->>'immediateCashShockMinor')::bigint<>100000 or (v_run->>'minimumCashFloorMinor')::bigint<>800000 then
  raise exception 'Stress assumptions or policy threshold not carried into run: %',v_run;
 end if;
 if v_run->>'firstFloorBreachDate' is null then raise exception 'Expected stressed minimum cash floor breach: %',v_run; end if;
 if jsonb_array_length(v_run->'contingencyOptions')<1 then raise exception 'Contingency options missing from stress result'; end if;
 v_run_id:=(v_run->>'runId')::uuid;
 v_overview:=executive_visuals.financial_liquidity_stress_overview(v_actor);
 if not exists(select 1 from jsonb_array_elements(v_overview->'runs') r where r->>'id'=v_run_id::text) then
  raise exception 'Stress run snapshot missing from overview: %',v_overview;
 end if;
 select (r->'result'->>'lowestProjectedCashMinor')::bigint into v_capacity from jsonb_array_elements(v_overview->'runs') r where r->>'id'=v_run_id::text;
 if v_capacity is null then raise exception 'Persisted stress run result missing'; end if;
 begin
  perform executive_visuals.run_financial_liquidity_stress_test('88888888-8888-4888-8888-888888888888'::uuid,(v_scenario->>'id')::uuid);
  raise exception 'Unauthorized stress run was accepted';
 exception when sqlstate '42501' then null;
 end;
 begin
  update executive_visuals.financial_liquidity_stress_scenarios set name='tampered' where id=(v_scenario->>'id')::uuid;
  raise exception 'Append-only stress scenario accepted an update';
 exception when sqlstate '55000' then null;
 end;
 begin
  delete from executive_visuals.financial_liquidity_stress_runs where id=v_run_id;
  raise exception 'Append-only stress run accepted deletion';
 exception when sqlstate '55000' then null;
 end;
 begin
  update executive_visuals.financial_contingency_options set estimated_capacity_minor=999999 where id=(v_option->>'id')::uuid;
  raise exception 'Append-only contingency option accepted an update';
 exception when sqlstate '55000' then null;
 end;
 begin
  perform executive_visuals.record_financial_liquidity_stress_scenario(v_actor,jsonb_build_object(
   'name','Invalid stress','currency','ZZZ','inflowReductionBps',10001,'outflowIncreaseBps',0,'immediateCashShockMinor',0,
   'sourceReference','bad-input','rationale','Invalid receipt shock above one hundred percent.','idempotencyKey','batch44-invalid'));
  raise exception 'Invalid stress multiplier was accepted';
 exception when sqlstate '22023' then null;
 end;
end $batch44$;
reset role;

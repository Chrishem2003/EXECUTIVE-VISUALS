-- Batch 46: verify protected, append-only scenario snapshot persistence and idempotency.
reset role;
set role service_role;
do $batch46$
declare
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
 v_input jsonb:='{"monthlyRevenueMinor":1000000,"monthlyVariableCostMinor":400000,"monthlyFixedCostMinor":300000}'::jsonb;
 v_result jsonb:='{"base":{"endingCashMinor":300000}}'::jsonb;
 v_evidence jsonb:='[{"kind":"management_input","reference":"budget-approved-2026-11"}]'::jsonb;
 v_first jsonb;v_replay jsonb;v_list jsonb;v_baseline jsonb;v_count integer;
begin
 if not exists(select 1 from executive_visuals.platform_admins where user_id=v_actor and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Batch 46 fixture requires finance administrator actor.';
 end if;
 v_first:=executive_visuals.create_financial_scenario_snapshot(
  v_actor,'November base plan',date_trunc('month',now())::date,'UGX',
  'deterministic_monthly_scenario_v1',v_input,v_result,v_evidence,
  repeat('a',64),repeat('b',64),'batch46-scenario-snapshot-001');
 v_replay:=executive_visuals.create_financial_scenario_snapshot(
  v_actor,'November base plan',date_trunc('month',now())::date,'UGX',
  'deterministic_monthly_scenario_v1',v_input,v_result,v_evidence,
  repeat('a',64),repeat('b',64),'batch46-scenario-snapshot-001');
 if v_first->'snapshot'->>'id' is distinct from v_replay->'snapshot'->>'id'
  or v_replay->>'idempotentReplay'<>'true' then
  raise exception 'Batch 46 idempotency did not return the original immutable snapshot: % / %',v_first,v_replay;
 end if;
 begin
  perform executive_visuals.create_financial_scenario_snapshot(
   v_actor,'Changed payload',date_trunc('month',now())::date,'UGX',
   'deterministic_monthly_scenario_v1',v_input,v_result,v_evidence,
   repeat('c',64),repeat('d',64),'batch46-scenario-snapshot-001');
  raise exception 'Reusing an idempotency key with different content must fail.';
 exception when unique_violation then null;
 end;
 v_baseline:=executive_visuals.financial_scenario_baseline(v_actor,date_trunc('month',now())::date);
 if jsonb_typeof(v_baseline->'byCurrency')<>'array' or jsonb_typeof(v_baseline->'limitations')<>'array' then
  raise exception 'Verified scenario baseline must return currency-separated evidence and explicit limitations: %',v_baseline;
 end if;
 v_list:=executive_visuals.list_financial_scenario_snapshots(v_actor,10);
 if not exists(select 1 from jsonb_array_elements(v_list->'snapshots') s where s->>'id'=v_first->'snapshot'->>'id') then
  raise exception 'Saved scenario snapshot is missing from the finance-admin list.';
 end if;
 if v_list->>'immutable'<>'true' then raise exception 'Snapshot list must declare immutable evidence.'; end if;
 select count(*) into v_count from executive_visuals.financial_scenario_snapshots
  where actor_id=v_actor and idempotency_key='batch46-scenario-snapshot-001';
 if v_count<>1 then raise exception 'Expected one immutable snapshot, found %',v_count; end if;
end $batch46$;
reset role;

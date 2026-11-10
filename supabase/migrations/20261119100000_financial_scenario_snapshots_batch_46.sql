-- Batch 46: immutable, evidence-linked financial scenario snapshots.
create table if not exists executive_visuals.financial_scenario_snapshots (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null,
 scenario_name text not null,
 period_month date not null,
 currency char(3) not null,
 model_version text not null,
 input_payload jsonb not null,
 result_payload jsonb not null,
 evidence_references jsonb not null default '[]'::jsonb,
 input_sha256 text not null,
 result_sha256 text not null,
 idempotency_key text not null,
 created_at timestamptz not null default now(),
 constraint financial_scenario_name_length check (length(btrim(scenario_name)) between 1 and 100),
 constraint financial_scenario_period_month check (period_month=date_trunc('month',period_month)::date),
 constraint financial_scenario_currency check (currency ~ '^[A-Z]{3}$'),
 constraint financial_scenario_model_version check (model_version='deterministic_monthly_scenario_v1'),
 constraint financial_scenario_input_object check (jsonb_typeof(input_payload)='object'),
 constraint financial_scenario_result_object check (jsonb_typeof(result_payload)='object'),
 constraint financial_scenario_evidence_array check (jsonb_typeof(evidence_references)='array'),
 constraint financial_scenario_hashes check (input_sha256 ~ '^[0-9a-f]{64}$' and result_sha256 ~ '^[0-9a-f]{64}$'),
 constraint financial_scenario_idempotency_length check (length(idempotency_key) between 8 and 128),
 constraint financial_scenario_actor_idempotency unique(actor_id,idempotency_key)
);
create index if not exists financial_scenario_snapshots_created_idx
 on executive_visuals.financial_scenario_snapshots(created_at desc,id desc);
create index if not exists financial_scenario_snapshots_period_idx
 on executive_visuals.financial_scenario_snapshots(period_month desc,currency,created_at desc);
alter table executive_visuals.financial_scenario_snapshots enable row level security;
revoke all on executive_visuals.financial_scenario_snapshots from public,anon,authenticated;
revoke all on executive_visuals.financial_scenario_snapshots from service_role;

create or replace function executive_visuals.reject_financial_scenario_snapshot_mutation()
returns trigger language plpgsql set search_path=pg_catalog,executive_visuals
as $$ begin raise exception 'Financial scenario snapshots are immutable.' using errcode='55000'; end $$;
drop trigger if exists financial_scenario_snapshots_immutable on executive_visuals.financial_scenario_snapshots;
create trigger financial_scenario_snapshots_immutable before update or delete
 on executive_visuals.financial_scenario_snapshots
 for each row execute function executive_visuals.reject_financial_scenario_snapshot_mutation();

create or replace function executive_visuals.create_financial_scenario_snapshot(
 p_actor_id uuid,p_scenario_name text,p_period_month date,p_currency text,
 p_model_version text,p_input_payload jsonb,p_result_payload jsonb,
 p_evidence_references jsonb,p_input_sha256 text,p_result_sha256 text,p_idempotency_key text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_row executive_visuals.financial_scenario_snapshots%rowtype;v_inserted boolean:=false;v_rows integer:=0;
begin
 if p_actor_id is null or not exists(select 1 from executive_visuals.platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_scenario_name is null or length(btrim(p_scenario_name)) not between 1 and 100
  or p_currency is null or p_model_version is null or p_input_payload is null or p_result_payload is null or p_evidence_references is null
  or p_input_sha256 is null or p_result_sha256 is null
  or p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_currency !~ '^[A-Z]{3}$'
  or p_model_version <> 'deterministic_monthly_scenario_v1'
  or jsonb_typeof(p_input_payload) <> 'object'
  or jsonb_typeof(p_result_payload) <> 'object'
  or jsonb_typeof(p_evidence_references) <> 'array'
  or p_input_sha256 !~ '^[0-9a-f]{64}$'
  or p_result_sha256 !~ '^[0-9a-f]{64}$'
  or p_idempotency_key is null or length(p_idempotency_key) not between 8 and 128 then
  raise exception 'Invalid financial scenario snapshot payload' using errcode='22023';
 end if;
 insert into executive_visuals.financial_scenario_snapshots(
  actor_id,scenario_name,period_month,currency,model_version,input_payload,result_payload,
  evidence_references,input_sha256,result_sha256,idempotency_key
 ) values(p_actor_id,btrim(p_scenario_name),p_period_month,p_currency,p_model_version,
  p_input_payload,p_result_payload,p_evidence_references,p_input_sha256,p_result_sha256,p_idempotency_key)
 on conflict(actor_id,idempotency_key) do nothing;
 get diagnostics v_rows=row_count;
 v_inserted:=v_rows>0;
 select * into v_row from executive_visuals.financial_scenario_snapshots
  where actor_id=p_actor_id and idempotency_key=p_idempotency_key;
 if v_row.id is null then raise exception 'Scenario snapshot could not be persisted' using errcode='P0001'; end if;
 if v_row.input_sha256<>p_input_sha256 or v_row.result_sha256<>p_result_sha256 then
  raise exception 'Idempotency key was already used for a different scenario payload' using errcode='23505';
 end if;
 return jsonb_build_object('snapshot',jsonb_build_object(
  'id',v_row.id,'scenarioName',v_row.scenario_name,'periodMonth',v_row.period_month,
  'currency',v_row.currency,'modelVersion',v_row.model_version,
  'input',v_row.input_payload,'result',v_row.result_payload,
  'evidenceReferences',v_row.evidence_references,'inputSha256',v_row.input_sha256,
  'resultSha256',v_row.result_sha256,'createdAt',v_row.created_at),
  'idempotentReplay',not v_inserted);
end $$;

create or replace function executive_visuals.list_financial_scenario_snapshots(
 p_actor_id uuid,p_limit integer default 25
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from executive_visuals.platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_limit is null or p_limit not between 1 and 100 then
  raise exception 'Scenario snapshot limit must be between 1 and 100' using errcode='22023';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'scenarioName',scenario_name,'periodMonth',period_month,'currency',currency,
  'modelVersion',model_version,'input',input_payload,'result',result_payload,
  'evidenceReferences',evidence_references,'inputSha256',input_sha256,
  'resultSha256',result_sha256,'createdAt',created_at) order by created_at desc,id desc),'[]'::jsonb)
 into v_result from (
  select * from executive_visuals.financial_scenario_snapshots
  order by created_at desc,id desc limit p_limit
 ) s;
 return jsonb_build_object('snapshots',v_result,'count',jsonb_array_length(v_result),'immutable',true);
end $$;


create or replace function executive_visuals.financial_scenario_baseline(
 p_actor_id uuid,p_period_month date
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from executive_visuals.platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date then
  raise exception 'Scenario baseline period must be the first day of a month' using errcode='22023';
 end if;
 with currencies as(
  select currency from executive_visuals.financial_cash_position_snapshots
   where as_of_date<(p_period_month+interval '1 month')::date
  union
  select currency from executive_visuals.subscription_revenue_snapshots where snapshot_month=p_period_month
  union
  select currency from executive_visuals.financial_service_cost_events where period_month=p_period_month
 ), cash as(
  select distinct on(currency) id,currency,available_cash_minor,as_of_date,source_reference
  from executive_visuals.financial_cash_position_snapshots
  where as_of_date<(p_period_month+interval '1 month')::date
  order by currency,as_of_date desc,created_at desc
 ), revenue as(
  select s.currency,sum(s.mrr_minor)::bigint monthly_mrr_minor,count(*)::integer snapshot_count
  from executive_visuals.subscription_revenue_snapshots s where s.snapshot_month=p_period_month
  group by s.currency
 ), revenue_evidence as(
  select currency,jsonb_agg(jsonb_build_object('kind','subscription_revenue_snapshot','ownerId',owner_id,'currency',currency,'periodMonth',snapshot_month)
    order by owner_id) evidence
  from (
   select owner_id,currency,snapshot_month from executive_visuals.subscription_revenue_snapshots
   where snapshot_month=p_period_month order by owner_id limit 100
  ) e group by currency
 ), costs as(
  select c.currency,sum(c.amount_minor)::bigint direct_service_cost_minor,count(*)::integer event_count
  from executive_visuals.financial_service_cost_events c where c.period_month=p_period_month
  group by c.currency
 ), cost_evidence as(
  select currency,jsonb_agg(jsonb_build_object('kind','financial_service_cost_event','id',id,'periodMonth',period_month)
    order by created_at desc) evidence
  from (
   select id,currency,period_month,created_at from executive_visuals.financial_service_cost_events
   where period_month=p_period_month order by created_at desc limit 100
  ) e group by currency
 ), baseline_rows as(
  select cur.currency,ca.available_cash_minor opening_cash_minor,ca.as_of_date cash_as_of_date,
   ca.id cash_snapshot_id,r.monthly_mrr_minor,r.snapshot_count revenue_snapshot_count,
   co.direct_service_cost_minor,co.event_count direct_cost_event_count,
   case when ca.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('kind','cash_position_snapshot','id',ca.id,'asOfDate',ca.as_of_date,'sourceReference',ca.source_reference)) end
   ||coalesce(re.evidence,'[]'::jsonb)||coalesce(ce.evidence,'[]'::jsonb) evidence_references
  from currencies cur left join cash ca on ca.currency=cur.currency
  left join revenue r on r.currency=cur.currency
  left join revenue_evidence re on re.currency=cur.currency
  left join costs co on co.currency=cur.currency
  left join cost_evidence ce on ce.currency=cur.currency
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'currency',currency,'openingCashMinor',opening_cash_minor,'cashAsOfDate',cash_as_of_date,
  'cashPositionSnapshotId',cash_snapshot_id,'monthlyMrrMinor',monthly_mrr_minor,
  'revenueSnapshotCount',coalesce(revenue_snapshot_count,0),
  'monthlyDirectServiceCostMinor',direct_service_cost_minor,
  'directCostEventCount',coalesce(direct_cost_event_count,0),
  'evidenceReferences',evidence_references
 ) order by currency),'[]'::jsonb) into v_result from baseline_rows;
 return jsonb_build_object('periodMonth',p_period_month,'byCurrency',v_result,
  'limitations',jsonb_build_array(
   'Subscription MRR is recurring revenue evidence, not cash collected or total business revenue.',
   'Direct service-cost events are not a complete variable-cost or cost-of-goods-sold ledger and are not automatically mapped into the scenario cost assumptions.',
   'Opening cash is the latest recorded available-cash snapshot on or before the selected month end; it may not be a live bank balance.',
   'Fixed operating costs and capital expenditure are not inferred from these sources and must be supplied from approved records.',
   'Currencies are kept separate. Missing source records remain null and are never converted to zero.'
  ));
end $$;

revoke all on function executive_visuals.reject_financial_scenario_snapshot_mutation() from public,anon,authenticated;
revoke all on function executive_visuals.create_financial_scenario_snapshot(uuid,text,date,text,text,jsonb,jsonb,jsonb,text,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.list_financial_scenario_snapshots(uuid,integer) from public,anon,authenticated;
revoke all on function executive_visuals.financial_scenario_baseline(uuid,date) from public,anon,authenticated;
grant execute on function executive_visuals.create_financial_scenario_snapshot(uuid,text,date,text,text,jsonb,jsonb,jsonb,text,text,text) to service_role;
grant execute on function executive_visuals.list_financial_scenario_snapshots(uuid,integer) to service_role;
grant execute on function executive_visuals.financial_scenario_baseline(uuid,date) to service_role;

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
grant select,insert on executive_visuals.financial_scenario_snapshots to service_role;

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
  or p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_currency !~ '^[A-Z]{3}$'
  or p_model_version<>'deterministic_monthly_scenario_v1'
  or jsonb_typeof(p_input_payload)<>'object' or jsonb_typeof(p_result_payload)<>'object'
  or jsonb_typeof(p_evidence_references)<>'array'
  or octet_length(p_input_payload::text)>32768 or octet_length(p_result_payload::text)>131072
  or jsonb_array_length(p_evidence_references)>50
  or p_input_sha256 !~ '^[0-9a-f]{64}$' or p_result_sha256 !~ '^[0-9a-f]{64}$'
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

revoke all on function executive_visuals.reject_financial_scenario_snapshot_mutation() from public,anon,authenticated;
revoke all on function executive_visuals.create_financial_scenario_snapshot(uuid,text,date,text,text,jsonb,jsonb,jsonb,text,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.list_financial_scenario_snapshots(uuid,integer) from public,anon,authenticated;
grant execute on function executive_visuals.create_financial_scenario_snapshot(uuid,text,date,text,text,jsonb,jsonb,jsonb,text,text,text) to service_role;
grant execute on function executive_visuals.list_financial_scenario_snapshots(uuid,integer) to service_role;

-- Batch 96: append-only, approved FX evidence for settlement-cost comparisons.
-- Official tax/reference rates are deliberately not accepted as settlement conversion evidence.

create table if not exists executive_visuals.financial_fx_rate_evidence (
 id uuid primary key default gen_random_uuid(),
 source_currency text not null check(source_currency ~ '^[A-Z]{3}$'),
 target_currency text not null check(target_currency ~ '^[A-Z]{3}$'),
 period_month date not null check(period_month=date_trunc('month',period_month)::date),
 rate_scaled bigint not null check(rate_scaled between 1 and 100000000000000),
 rate_scale bigint not null default 100000000 check(rate_scale=100000000),
 effective_date date not null,
 source_type text not null check(source_type in('processor_settlement','bank_statement','official_reference','tax_reference','other')),
 purpose text not null check(purpose in('settlement_cost','financial_reporting','tax_reporting','reference_only')),
 source_reference text not null check(length(btrim(source_reference)) between 3 and 240),
 evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
 evidence_note text not null check(length(btrim(evidence_note)) between 3 and 1000),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 recorded_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 check(source_currency<>target_currency)
);
create index if not exists financial_fx_rate_evidence_pair_period_idx
 on executive_visuals.financial_fx_rate_evidence(source_currency,target_currency,period_month,effective_date desc);

create table if not exists executive_visuals.financial_fx_rate_decisions (
 id uuid primary key default gen_random_uuid(),
 evidence_id uuid not null references executive_visuals.financial_fx_rate_evidence(id) on delete restrict,
 decision text not null check(decision in('approved','rejected','revoked')),
 decision_reason text not null check(length(btrim(decision_reason)) between 3 and 500),
 decided_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now()
);
create index if not exists financial_fx_rate_decisions_latest_idx
 on executive_visuals.financial_fx_rate_decisions(evidence_id,created_at desc,id desc);

alter table executive_visuals.financial_fx_rate_evidence enable row level security;
alter table executive_visuals.financial_fx_rate_decisions enable row level security;
revoke all on executive_visuals.financial_fx_rate_evidence,executive_visuals.financial_fx_rate_decisions from public,anon,authenticated;
grant select,insert on executive_visuals.financial_fx_rate_evidence to service_role;
grant select,insert on executive_visuals.financial_fx_rate_decisions to service_role;

create or replace function executive_visuals.reject_financial_fx_mutation() returns trigger
language plpgsql set search_path=pg_catalog,executive_visuals as $$
begin raise exception 'FX evidence and decisions are append-only' using errcode='55000'; end $$;
drop trigger if exists financial_fx_evidence_immutable on executive_visuals.financial_fx_rate_evidence;
create trigger financial_fx_evidence_immutable before update or delete on executive_visuals.financial_fx_rate_evidence
 for each row execute function executive_visuals.reject_financial_fx_mutation();
drop trigger if exists financial_fx_decisions_immutable on executive_visuals.financial_fx_rate_decisions;
create trigger financial_fx_decisions_immutable before update or delete on executive_visuals.financial_fx_rate_decisions
 for each row execute function executive_visuals.reject_financial_fx_mutation();

create or replace function executive_visuals.record_financial_fx_rate_evidence(
 p_actor_id uuid,p_source_currency text,p_target_currency text,p_period_month date,p_rate_scaled bigint,p_effective_date date,
 p_source_type text,p_purpose text,p_source_reference text,p_evidence_sha256 text,p_evidence_note text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,executive_visuals,auth as $$
declare v_row financial_fx_rate_evidence%rowtype; v_id uuid;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if coalesce(p_source_currency,'') !~ '^[A-Z]{3}$' or coalesce(p_target_currency,'') !~ '^[A-Z]{3}$'
  or p_source_currency=p_target_currency or p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_period_month>date_trunc('month',current_date)::date or p_rate_scaled not between 1 and 100000000000000
  or p_effective_date is null or p_effective_date>current_date
  or coalesce(p_source_type,'') not in('processor_settlement','bank_statement','official_reference','tax_reference','other')
  or coalesce(p_purpose,'') not in('settlement_cost','financial_reporting','tax_reporting','reference_only')
  or length(btrim(coalesce(p_source_reference,''))) not between 3 and 240
  or (p_evidence_sha256 is not null and p_evidence_sha256 !~ '^[a-f0-9]{64}$')
  or length(btrim(coalesce(p_evidence_note,''))) not between 3 and 1000
  or length(coalesce(p_idempotency_key,'')) not between 8 and 160 then
  raise exception 'Invalid FX evidence details' using errcode='22023';
 end if;
 if p_purpose='settlement_cost' and p_source_type not in('processor_settlement','bank_statement') then
  raise exception 'Settlement-cost conversion requires processor settlement or bank statement evidence' using errcode='22023';
 end if;
 select * into v_row from financial_fx_rate_evidence where idempotency_key=p_idempotency_key;
 if found then
  if v_row.recorded_by<>p_actor_id or v_row.source_currency<>p_source_currency or v_row.target_currency<>p_target_currency
   or v_row.period_month<>p_period_month or v_row.rate_scaled<>p_rate_scaled or v_row.effective_date<>p_effective_date
   or v_row.source_type<>p_source_type or v_row.purpose<>p_purpose or v_row.source_reference<>p_source_reference
   or v_row.evidence_sha256 is distinct from p_evidence_sha256 or v_row.evidence_note<>p_evidence_note then
   raise exception 'FX idempotency key reused with different evidence' using errcode='23505';
  end if;
  return jsonb_build_object('id',v_row.id,'status','pending_review','idempotentReplay',true);
 end if;
 insert into financial_fx_rate_evidence(source_currency,target_currency,period_month,rate_scaled,effective_date,source_type,purpose,source_reference,evidence_sha256,evidence_note,idempotency_key,recorded_by)
 values(p_source_currency,p_target_currency,p_period_month,p_rate_scaled,p_effective_date,p_source_type,p_purpose,p_source_reference,p_evidence_sha256,p_evidence_note,p_idempotency_key,p_actor_id)
 returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.fx_rate.recorded','financial_fx_rate_evidence',v_id::text,p_evidence_note,p_idempotency_key,
  jsonb_build_object('sourceCurrency',p_source_currency,'targetCurrency',p_target_currency,'periodMonth',p_period_month,'rateScaled',p_rate_scaled,'effectiveDate',p_effective_date,'sourceType',p_source_type,'purpose',p_purpose,'sourceReference',p_source_reference));
 return jsonb_build_object('id',v_id,'status','pending_review','idempotentReplay',false);
end $$;

create or replace function executive_visuals.decide_financial_fx_rate_evidence(
 p_actor_id uuid,p_evidence_id uuid,p_decision text,p_decision_reason text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,executive_visuals,auth as $$
declare v_evidence financial_fx_rate_evidence%rowtype; v_latest financial_fx_rate_decisions%rowtype; v_id uuid;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator role required' using errcode='42501';
 end if;
 if p_decision not in('approved','rejected','revoked') or length(btrim(coalesce(p_decision_reason,''))) not between 3 and 500 then
  raise exception 'Invalid FX evidence decision' using errcode='22023';
 end if;
 select * into v_evidence from financial_fx_rate_evidence where id=p_evidence_id;
 if not found then raise exception 'FX evidence not found' using errcode='P0002'; end if;
 if v_evidence.recorded_by=p_actor_id then raise exception 'FX evidence maker cannot approve their own evidence' using errcode='42501'; end if;
 select * into v_latest from financial_fx_rate_decisions where evidence_id=p_evidence_id order by created_at desc,id desc limit 1;
 if v_latest.decision='revoked' then raise exception 'Revoked FX evidence cannot be re-approved' using errcode='55000'; end if;
 if v_latest.decision=p_decision then raise exception 'The same FX decision is already current' using errcode='23505'; end if;
 insert into financial_fx_rate_decisions(evidence_id,decision,decision_reason,decided_by) values(p_evidence_id,p_decision,p_decision_reason,p_actor_id) returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.fx_rate.'||p_decision,'financial_fx_rate_evidence',p_evidence_id::text,p_decision_reason,
  'fx-decision-'||v_id::text,jsonb_build_object('decisionId',v_id,'decision',p_decision,'sourceCurrency',v_evidence.source_currency,'targetCurrency',v_evidence.target_currency,'periodMonth',v_evidence.period_month,'effectiveDate',v_evidence.effective_date));
 return jsonb_build_object('id',v_id,'evidenceId',p_evidence_id,'decision',p_decision);
end $$;

revoke all on function executive_visuals.record_financial_fx_rate_evidence(uuid,text,text,date,bigint,date,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.decide_financial_fx_rate_evidence(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.record_financial_fx_rate_evidence(uuid,text,text,date,bigint,date,text,text,text,text,text,text) to service_role;
grant execute on function executive_visuals.decide_financial_fx_rate_evidence(uuid,uuid,text,text) to service_role;

create or replace view executive_visuals.financial_fx_rate_evidence_current as
select e.id as evidence_id,e.source_currency,e.target_currency,e.period_month,e.rate_scaled,e.rate_scale,e.effective_date,
 e.source_type,e.purpose,e.source_reference,e.evidence_sha256,e.evidence_note,e.recorded_by,e.created_at as evidence_created_at,
 d.decision,d.decision_reason,d.decided_by,d.created_at as decision_created_at
from executive_visuals.financial_fx_rate_evidence e
left join lateral (select x.decision,x.decision_reason,x.decided_by,x.created_at
 from executive_visuals.financial_fx_rate_decisions x where x.evidence_id=e.id
 order by x.created_at desc,x.id desc limit 1) d on true;
grant select on executive_visuals.financial_fx_rate_evidence_current to service_role;

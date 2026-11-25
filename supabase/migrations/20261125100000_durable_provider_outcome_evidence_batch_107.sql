-- Batch 107: durable append-only provider outcome evidence.
-- This records adapter-verified provider billing outcomes against durable video tasks.
-- It deliberately does not settle or release customer credits; Batch 105 guards remain.

create table if not exists executive_visuals.provider_outcome_evidence (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references executive_visuals.video_generation_tasks(id) on delete restrict,
  provider text not null check (provider in ('runway','fal')),
  provider_task_id text not null check (char_length(provider_task_id) between 1 and 180),
  provider_account_id text not null check (char_length(provider_account_id) between 1 and 180),
  model text not null check (char_length(model) between 1 and 180),
  route text not null check (char_length(route) between 1 and 180),
  evidence_id text not null check (char_length(evidence_id) between 1 and 180),
  outcome text not null check (outcome in ('charged','no_charge','unknown')),
  final_state text not null check (final_state in ('succeeded','failed','cancelled')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  actual_cost_micros bigint,
  estimated_cost_micros bigint not null check (estimated_cost_micros >= 0),
  variance_micros bigint,
  billable_seconds integer not null check (billable_seconds between 0 and 604800),
  input_reference_count integer not null check (input_reference_count between 0 and 1000),
  audio_enabled boolean not null,
  source_reference text not null check (char_length(source_reference) between 1 and 240),
  observed_at timestamptz not null,
  signature_algorithm text not null check (signature_algorithm = 'HMAC-SHA256'),
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  adapter_id text not null check (char_length(adapter_id) between 1 and 100),
  adapter_version text not null check (char_length(adapter_version) between 1 and 80),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint ev_provider_outcome_amount_state_check check (
    (outcome='charged' and actual_cost_micros is not null and actual_cost_micros > 0)
    or (outcome='no_charge' and actual_cost_micros = 0 and billable_seconds = 0)
    or (outcome='unknown' and actual_cost_micros is null)
  ),
  constraint ev_provider_outcome_variance_check check (
    variance_micros is not distinct from (actual_cost_micros - estimated_cost_micros)
    or (outcome='unknown' and variance_micros is null)
  ),
  unique(provider,provider_task_id,evidence_id)
);

create index if not exists ev_provider_outcome_task_history
  on executive_visuals.provider_outcome_evidence(task_id,observed_at desc,recorded_at desc);
create index if not exists ev_provider_outcome_provider_period
  on executive_visuals.provider_outcome_evidence(provider,provider_account_id,observed_at desc);

alter table executive_visuals.provider_outcome_evidence enable row level security;
revoke all on executive_visuals.provider_outcome_evidence from public,anon,authenticated,service_role;
grant select on executive_visuals.provider_outcome_evidence to service_role;

create or replace function executive_visuals.reject_provider_outcome_evidence_mutation()
returns trigger
language plpgsql
set search_path=pg_catalog
as $reject_provider_outcome_evidence_mutation$
begin
  raise exception 'PROVIDER_OUTCOME_EVIDENCE_IS_APPEND_ONLY' using errcode='55000';
end;
$reject_provider_outcome_evidence_mutation$;
revoke all on function executive_visuals.reject_provider_outcome_evidence_mutation()
  from public,anon,authenticated,service_role;
drop trigger if exists ev_provider_outcome_evidence_immutable
  on executive_visuals.provider_outcome_evidence;
create trigger ev_provider_outcome_evidence_immutable
before update or delete on executive_visuals.provider_outcome_evidence
for each row execute function executive_visuals.reject_provider_outcome_evidence_mutation();

create or replace function executive_visuals.record_provider_outcome_evidence(
  p_task_id uuid,
  p_provider text,
  p_provider_task_id text,
  p_provider_account_id text,
  p_model text,
  p_route text,
  p_evidence_id text,
  p_outcome text,
  p_final_state text,
  p_currency text,
  p_actual_cost_micros bigint,
  p_billable_seconds integer,
  p_input_reference_count integer,
  p_audio_enabled boolean,
  p_source_reference text,
  p_observed_at timestamptz,
  p_signature_algorithm text,
  p_evidence_digest text,
  p_adapter_id text,
  p_adapter_version text
)
returns table(evidence_row_id uuid,replayed boolean,actual_cost_micros bigint,
              estimated_cost_micros bigint,variance_micros bigint)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $record_provider_outcome_evidence$
declare
  task_row executive_visuals.video_generation_tasks%rowtype;
  approval_row executive_visuals.video_generation_approvals%rowtype;
  saved executive_visuals.provider_outcome_evidence%rowtype;
  v_variance bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'PROVIDER_OUTCOME_SERVICE_ROLE_REQUIRED' using errcode='42501';
  end if;
  if p_task_id is null
     or p_provider is null or p_provider not in ('runway','fal')
     or p_provider_task_id is null or char_length(p_provider_task_id) not between 1 and 180
     or p_provider_account_id is null or char_length(p_provider_account_id) not between 1 and 180
     or p_model is null or char_length(p_model) not between 1 and 180
     or p_route is null or char_length(p_route) not between 1 and 180
     or p_evidence_id is null or char_length(p_evidence_id) not between 1 and 180
     or p_outcome is null or p_outcome not in ('charged','no_charge','unknown')
     or p_final_state is null or p_final_state not in ('succeeded','failed','cancelled')
     or p_currency is null or p_currency !~ '^[A-Z]{3}$'
     or p_billable_seconds is null or p_billable_seconds not between 0 and 604800
     or p_input_reference_count is null or p_input_reference_count not between 0 and 1000
     or p_audio_enabled is null
     or p_source_reference is null or char_length(p_source_reference) not between 1 and 240
     or p_observed_at is null
     or p_observed_at > clock_timestamp()+interval '5 minutes'
     or p_observed_at < clock_timestamp()-interval '90 days'
     or p_signature_algorithm is distinct from 'HMAC-SHA256'
     or p_evidence_digest is null or p_evidence_digest !~ '^[a-f0-9]{64}$'
     or p_adapter_id is null or char_length(p_adapter_id) not between 1 and 100
     or p_adapter_version is null or char_length(p_adapter_version) not between 1 and 80 then
    raise exception 'PROVIDER_OUTCOME_EVIDENCE_ARGUMENTS_INVALID' using errcode='22023';
  end if;
  if (p_outcome='charged' and (p_actual_cost_micros is null or p_actual_cost_micros<=0))
     or (p_outcome='no_charge' and (p_actual_cost_micros is distinct from 0 or p_billable_seconds<>0))
     or (p_outcome='unknown' and p_actual_cost_micros is not null) then
    raise exception 'PROVIDER_OUTCOME_AMOUNT_STATE_INVALID' using errcode='22023';
  end if;

  select * into task_row from executive_visuals.video_generation_tasks
   where id=p_task_id for update;
  if not found or task_row.provider_task_id is null then
    raise exception 'PROVIDER_OUTCOME_TASK_NOT_SUBMITTED' using errcode='P0002';
  end if;
  select * into approval_row from executive_visuals.video_generation_approvals
   where id=task_row.approval_id and owner_id=task_row.owner_id
     and project_id=task_row.project_id;
  if not found
     or task_row.provider is distinct from p_provider
     or task_row.provider_task_id is distinct from p_provider_task_id
     or task_row.model is distinct from p_model
     or approval_row.currency is distinct from p_currency
     or task_row.state is distinct from p_final_state then
    raise exception 'PROVIDER_OUTCOME_TASK_IDENTITY_OR_STATE_MISMATCH' using errcode='55000';
  end if;

  select * into saved from executive_visuals.provider_outcome_evidence
   where provider=p_provider and provider_task_id=p_provider_task_id
     and evidence_id=p_evidence_id;
  if found then
    if saved.task_id is distinct from p_task_id
       or saved.evidence_digest is distinct from p_evidence_digest then
      raise exception 'PROVIDER_OUTCOME_EVIDENCE_IDEMPOTENCY_CONFLICT' using errcode='23505';
    end if;
    return query select saved.id,true,saved.actual_cost_micros,
      saved.estimated_cost_micros,saved.variance_micros;
    return;
  end if;

  v_variance := case when p_actual_cost_micros is null then null
    else p_actual_cost_micros-task_row.estimated_cost_micros end;

  insert into executive_visuals.provider_outcome_evidence(
    task_id,provider,provider_task_id,provider_account_id,model,route,evidence_id,
    outcome,final_state,currency,actual_cost_micros,estimated_cost_micros,variance_micros,
    billable_seconds,input_reference_count,audio_enabled,source_reference,observed_at,
    signature_algorithm,evidence_digest,adapter_id,adapter_version
  ) values(
    p_task_id,p_provider,p_provider_task_id,p_provider_account_id,p_model,p_route,p_evidence_id,
    p_outcome,p_final_state,p_currency,p_actual_cost_micros,task_row.estimated_cost_micros,v_variance,
    p_billable_seconds,p_input_reference_count,p_audio_enabled,p_source_reference,p_observed_at,
    p_signature_algorithm,p_evidence_digest,p_adapter_id,p_adapter_version
  ) returning * into saved;

  return query select saved.id,false,saved.actual_cost_micros,
    saved.estimated_cost_micros,saved.variance_micros;
end;
$record_provider_outcome_evidence$;

revoke all on function executive_visuals.record_provider_outcome_evidence(
  uuid,text,text,text,text,text,text,text,text,text,bigint,integer,integer,boolean,text,
  timestamptz,text,text,text,text
) from public,anon,authenticated;
grant execute on function executive_visuals.record_provider_outcome_evidence(
  uuid,text,text,text,text,text,text,text,text,text,bigint,integer,integer,boolean,text,
  timestamptz,text,text,text,text
) to service_role;

comment on table executive_visuals.provider_outcome_evidence is
  'Append-only adapter-verified provider billing evidence. Evidence does not itself authorize customer credit settlement or release.';
comment on function executive_visuals.record_provider_outcome_evidence(
  uuid,text,text,text,text,text,text,text,text,text,bigint,integer,integer,boolean,text,
  timestamptz,text,text,text,text
) is
  'Service-role-only durable evidence ingestion. It binds the evidence to the stored task and records actual-vs-estimated provider cost; it never settles or releases customer credits.';

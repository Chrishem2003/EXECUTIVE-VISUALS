-- Batch 112: represent unknown provider billing metrics as unknown, not zero.
-- This does not change existing evidence rows or release/settle customer credits.

alter table executive_visuals.provider_outcome_evidence
 alter column billable_seconds drop not null,
 alter column input_reference_count drop not null,
 alter column audio_enabled drop not null;

alter table executive_visuals.provider_outcome_evidence drop constraint if exists ev_provider_outcome_amount_state_check;
alter table executive_visuals.provider_outcome_evidence add constraint ev_provider_outcome_amount_state_check check (
 (outcome='charged' and actual_cost_micros is not null and actual_cost_micros>0 and billable_seconds is not null)
 or (outcome='no_charge' and actual_cost_micros=0 and billable_seconds=0)
 or (outcome='unknown' and actual_cost_micros is null)
);
alter table executive_visuals.provider_outcome_evidence add constraint ev_provider_outcome_billable_seconds_check
 check (billable_seconds is null or billable_seconds between 0 and 604800);
alter table executive_visuals.provider_outcome_evidence add constraint ev_provider_outcome_reference_count_check
 check (input_reference_count is null or input_reference_count between 0 and 1000);
alter table executive_visuals.provider_outcome_evidence add constraint ev_provider_outcome_known_metrics_check
 check (outcome='unknown' or (billable_seconds is not null and input_reference_count is not null and audio_enabled is not null));

create or replace function executive_visuals.record_provider_outcome_evidence(
 p_task_id uuid,p_provider text,p_provider_task_id text,p_provider_account_id text,
 p_model text,p_route text,p_evidence_id text,p_outcome text,p_final_state text,
 p_currency text,p_actual_cost_micros bigint,p_billable_seconds integer,
 p_input_reference_count integer,p_audio_enabled boolean,p_source_reference text,
 p_observed_at timestamptz,p_signature_algorithm text,p_evidence_digest text,
 p_adapter_id text,p_adapter_version text
)
returns table(evidence_row_id uuid,replayed boolean,actual_cost_micros bigint,estimated_cost_micros bigint,variance_micros bigint)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $record_provider_outcome_evidence_batch112$
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
  or (p_billable_seconds is null and p_outcome<>'unknown')
  or (p_billable_seconds is not null and p_billable_seconds not between 0 and 604800)
  or (p_input_reference_count is null and p_outcome<>'unknown')
  or (p_input_reference_count is not null and p_input_reference_count not between 0 and 1000)
  or (p_audio_enabled is null and p_outcome<>'unknown')
  or p_source_reference is null or char_length(p_source_reference) not between 1 and 240
  or p_observed_at is null
  or p_observed_at>clock_timestamp()+interval '5 minutes'
  or p_observed_at<clock_timestamp()-interval '90 days'
  or p_signature_algorithm is distinct from 'HMAC-SHA256'
  or p_evidence_digest is null or p_evidence_digest !~ '^[a-f0-9]{64}$'
  or p_adapter_id is null or char_length(p_adapter_id) not between 1 and 100
  or p_adapter_version is null or char_length(p_adapter_version) not between 1 and 80 then
  raise exception 'PROVIDER_OUTCOME_EVIDENCE_ARGUMENTS_INVALID' using errcode='22023';
 end if;
 if (p_outcome='charged' and (p_actual_cost_micros is null or p_actual_cost_micros<=0))
  or (p_outcome='no_charge' and (p_actual_cost_micros is distinct from 0 or p_billable_seconds is distinct from 0))
  or (p_outcome='unknown' and p_actual_cost_micros is not null) then
  raise exception 'PROVIDER_OUTCOME_AMOUNT_STATE_INVALID' using errcode='22023';
 end if;
 select * into task_row from executive_visuals.video_generation_tasks where id=p_task_id for update;
 if not found or task_row.provider_task_id is null then
  raise exception 'PROVIDER_OUTCOME_TASK_NOT_SUBMITTED' using errcode='P0002';
 end if;
 select * into approval_row from executive_visuals.video_generation_approvals
  where id=task_row.approval_id and owner_id=task_row.owner_id and project_id=task_row.project_id;
 if not found or task_row.provider is distinct from p_provider
  or task_row.provider_task_id is distinct from p_provider_task_id
  or task_row.model is distinct from p_model or approval_row.currency is distinct from p_currency
  or task_row.state is distinct from p_final_state then
  raise exception 'PROVIDER_OUTCOME_TASK_IDENTITY_OR_STATE_MISMATCH' using errcode='55000';
 end if;
 select * into saved from executive_visuals.provider_outcome_evidence
  where provider=p_provider and provider_task_id=p_provider_task_id and evidence_id=p_evidence_id;
 if found then
  if saved.task_id is distinct from p_task_id or saved.evidence_digest is distinct from p_evidence_digest then
   raise exception 'PROVIDER_OUTCOME_EVIDENCE_IDEMPOTENCY_CONFLICT' using errcode='23505';
  end if;
  return query select saved.id,true,saved.actual_cost_micros,saved.estimated_cost_micros,saved.variance_micros;
  return;
 end if;
 v_variance:=case when p_actual_cost_micros is null then null else p_actual_cost_micros-task_row.estimated_cost_micros end;
 insert into executive_visuals.provider_outcome_evidence(
  task_id,provider,provider_task_id,provider_account_id,model,route,evidence_id,outcome,final_state,
  currency,actual_cost_micros,estimated_cost_micros,variance_micros,billable_seconds,
  input_reference_count,audio_enabled,source_reference,observed_at,signature_algorithm,
  evidence_digest,adapter_id,adapter_version
 ) values(
  p_task_id,p_provider,p_provider_task_id,p_provider_account_id,p_model,p_route,p_evidence_id,
  p_outcome,p_final_state,p_currency,p_actual_cost_micros,task_row.estimated_cost_micros,v_variance,
  p_billable_seconds,p_input_reference_count,p_audio_enabled,p_source_reference,p_observed_at,
  p_signature_algorithm,p_evidence_digest,p_adapter_id,p_adapter_version
 ) returning * into saved;
 return query select saved.id,false,saved.actual_cost_micros,saved.estimated_cost_micros,saved.variance_micros;
end;
$record_provider_outcome_evidence_batch112$;

revoke all on function executive_visuals.record_provider_outcome_evidence(
 uuid,text,text,text,text,text,text,text,text,text,bigint,integer,integer,boolean,text,timestamptz,text,text,text,text
) from public,anon,authenticated;
grant execute on function executive_visuals.record_provider_outcome_evidence(
 uuid,text,text,text,text,text,text,text,text,text,bigint,integer,integer,boolean,text,timestamptz,text,text,text,text
) to service_role;

comment on column executive_visuals.provider_outcome_evidence.billable_seconds is 'Nullable only for unknown provider outcomes; null means the provider has not supplied this metric.';
comment on column executive_visuals.provider_outcome_evidence.input_reference_count is 'Nullable only for unknown provider outcomes; null means the provider has not supplied this metric.';
comment on column executive_visuals.provider_outcome_evidence.audio_enabled is 'Nullable only for unknown provider outcomes; null means the provider has not supplied this metric.';

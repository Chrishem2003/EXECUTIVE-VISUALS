-- Settle the customer credit reservation against authoritative provider evidence.
-- The worker calls this only for workflow-quoted jobs; service-role only.
create or replace function executive_visuals.settle_generation_credits_for_job(
  p_job_id uuid,
  p_owner_id uuid,
  p_provider text,
  p_actual_credits bigint,
  p_evidence jsonb
)
returns table(balance bigint, adjustment bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $settle_generation_credits_for_job$
declare
  job_row executive_visuals.jobs;
  reservation_id uuid;
begin
  if p_job_id is null or p_owner_id is null
     or p_provider is null or char_length(p_provider) not between 1 and 100
     or p_actual_credits is null or p_actual_credits < 0 or p_actual_credits > 1000000000
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
     or p_evidence->>'provider' is distinct from p_provider
     or coalesce(p_evidence->>'evidenceType','') not in
       ('provider_task_receipt','provider_invoice','provider_usage_reconciliation')
     or coalesce(p_evidence->>'evidenceId','') = ''
     or coalesce(p_evidence->>'evidenceReference','') = '' then
    raise exception 'BILLING_CREDIT_JOB_SETTLEMENT_ARGUMENTS_INVALID';
  end if;

  select * into job_row from executive_visuals.jobs j
  where j.id=p_job_id and j.owner_id=p_owner_id and j.job_type='video.generate';
  if job_row.id is null then raise exception 'BILLING_CREDIT_JOB_OWNER_MISMATCH'; end if;
  if coalesce(job_row.input->>'provider','') <> p_provider then
    raise exception 'BILLING_CREDIT_PROVIDER_MISMATCH';
  end if;

  select r.id into reservation_id
  from executive_visuals.billing_credit_reservations r
  where r.job_id=p_job_id and r.owner_id=p_owner_id;
  if reservation_id is null then raise exception 'BILLING_CREDIT_JOB_RESERVATION_NOT_FOUND'; end if;

  return query
  select s.balance,s.adjustment,s.replayed
  from executive_visuals.settle_generation_credit_reservation(
    reservation_id,p_actual_credits,p_evidence
  ) s;
end;
$settle_generation_credits_for_job$;

revoke all on function executive_visuals.settle_generation_credits_for_job(uuid,uuid,text,bigint,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.settle_generation_credits_for_job(uuid,uuid,text,bigint,jsonb)
  to service_role;

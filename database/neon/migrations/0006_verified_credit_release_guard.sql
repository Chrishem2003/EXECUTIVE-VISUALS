-- Executive Visuals: database-enforced evidence for releasing reserved generation credits.
-- Source-controlled only. Requires migrations 0001-0005.
-- This migration has NOT been applied to any Neon branch.
begin;

create or replace function executive_visuals.guard_video_generation_credit_release_v1()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare submission executive_visuals.video_generation_submissions;
  evidence_type text;
begin
  -- Only guard generation-credit releases; ordinary purchased-credit refunds
  -- and measured post-generation settlements retain their existing pathways.
  if new.event_type<>'generation_refund'
     or new.idempotency_key not like 'credit-release:%' then
    return new;
  end if;

  if new.reference_id is null
     or jsonb_typeof(coalesce(new.evidence,'{}'::jsonb))<>'object' then
    raise exception 'VIDEO_CREDIT_RELEASE_EVIDENCE_INVALID';
  end if;

  evidence_type:=coalesce(new.evidence->>'evidenceType','');
  select * into submission
  from executive_visuals.video_generation_submissions
  where job_id=new.reference_id
  for key share;

  if submission.job_id is null
     or coalesce(new.evidence->>'provider','')<>submission.provider
     or coalesce(new.evidence->>'evidenceId','')=''
     or coalesce(new.evidence->>'evidenceReference','')='' then
    raise exception 'VIDEO_CREDIT_RELEASE_SUBMISSION_EVIDENCE_MISSING';
  end if;

  if evidence_type='verified_no_submission' then
    -- Only a prepared/terminal submission with no provider task proves that
    -- the provider was never reached. 'submitting' and 'unknown' fail closed.
    if submission.state not in ('prepared','failed','cancelled')
       or submission.provider_task_id is not null then
      raise exception 'VIDEO_CREDIT_RELEASE_NO_SUBMISSION_NOT_PROVEN';
    end if;
  elsif evidence_type='verified_no_charge_cancellation' then
    -- A submitted task is refundable only when the provider cancellation
    -- receipt was persisted with the submission before the credit release.
    if submission.state<>'cancelled'
       or submission.provider_task_id is null
       or coalesce(new.evidence->>'providerTaskId','')<>submission.provider_task_id
       or coalesce(submission.metadata->>'noChargeConfirmed','')<>'true'
       or coalesce(submission.metadata->>'noChargeEvidenceId','')<>new.evidence->>'evidenceId'
       or coalesce(submission.metadata->>'noChargeEvidenceReference','')<>new.evidence->>'evidenceReference' then
      raise exception 'VIDEO_CREDIT_RELEASE_PROVIDER_NO_CHARGE_NOT_PROVEN';
    end if;
  else
    raise exception 'VIDEO_CREDIT_RELEASE_EVIDENCE_TYPE_INVALID';
  end if;

  return new;
end
$$;

drop trigger if exists ev_neon_video_credit_release_evidence on executive_visuals.billing_credit_ledger;
create trigger ev_neon_video_credit_release_evidence
before insert on executive_visuals.billing_credit_ledger
for each row execute function executive_visuals.guard_video_generation_credit_release_v1();

revoke all on function executive_visuals.guard_video_generation_credit_release_v1() from public;

commit;

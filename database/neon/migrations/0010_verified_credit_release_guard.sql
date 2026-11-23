-- Executive Visuals: database-enforced evidence for releasing reserved generation credits.
-- Source-controlled only. Requires migrations 0001-0009.
-- This migration has NOT been applied to any Neon branch.
begin;

create or replace function executive_visuals.guard_video_generation_credit_release_v1()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  job_row executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
  evidence_type text;
begin
  -- Only guard generation reservation releases; ordinary purchased-credit
  -- refunds and measured post-generation settlements keep their existing paths.
  if new.event_type<>'generation_refund'
     or new.idempotency_key not like 'credit-release:%' then
    return new;
  end if;

  if new.reference_id is null
     or jsonb_typeof(coalesce(new.evidence,'{}'::jsonb))<>'object' then
    raise exception 'VIDEO_CREDIT_RELEASE_EVIDENCE_INVALID';
  end if;

  evidence_type:=coalesce(new.evidence->>'evidenceType','');
  select * into job_row
  from executive_visuals.jobs
  where id=new.reference_id and job_type='video.generate'
  for key share;

  if job_row.id is null
     or coalesce(new.evidence->>'provider','')<>coalesce(job_row.input->>'provider','')
     or coalesce(new.evidence->>'evidenceId','')=''
     or coalesce(new.evidence->>'evidenceReference','')='' then
    raise exception 'VIDEO_CREDIT_RELEASE_JOB_EVIDENCE_INVALID';
  end if;

  select * into submission
  from executive_visuals.video_generation_submissions
  where job_id=new.reference_id
  for key share;

  if submission.job_id is null then
    -- The dedicated queued-cancellation RPC locks the queued job, proves that
    -- no submission row exists, and writes this deterministic proof atomically.
    if evidence_type='verified_no_submission'
       and job_row.status='queued'
       and new.evidence->>'evidenceId'='neon-queued-cancel:'||new.reference_id::text
       and new.evidence->>'evidenceReference'='neon-queue:verified-no-submission:'||new.reference_id::text
       and new.evidence->>'source'='atomic-queued-job-cancellation' then
      return new;
    end if;
    raise exception 'VIDEO_CREDIT_RELEASE_SUBMISSION_EVIDENCE_MISSING';
  end if;

  if submission.owner_id<>new.owner_id
     or submission.provider<>new.evidence->>'provider' then
    raise exception 'VIDEO_CREDIT_RELEASE_SUBMISSION_SCOPE_MISMATCH';
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

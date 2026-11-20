-- Safe user cancellation for queued Neon video jobs.
-- Source-controlled only; apply only to an isolated, reviewed staging database.
-- A queued job is cancellable only when no provider-submission ledger row exists.
-- Processing/submitted/ambiguous jobs require provider-specific reconciliation.
begin;

create or replace function executive_visuals.cancel_queued_video_generation_job_v1(
 p_job_id uuid,
 p_owner_id uuid
) returns table(
 cancelled boolean,
 job_status text,
 balance bigint,
 credit_adjustment bigint,
 replayed boolean,
 reason text
)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals as $cancel_queued_video_generation_job_v1$
declare
 job_row executive_visuals.jobs;
 budget_row executive_visuals.video_generation_budget_reservations;
 credit_row executive_visuals.billing_credit_reservations;
 financial_receipt record;
 proof jsonb;
 current_balance bigint;
begin
 if p_job_id is null or p_owner_id is null then
  raise exception 'VIDEO_CANCEL_ARGUMENTS_INVALID';
 end if;

 select * into job_row
 from executive_visuals.jobs
 where id=p_job_id and owner_id=p_owner_id and job_type='video.generate'
 for update;

 if job_row.id is null then
  return query select false,null::text,0::bigint,0::bigint,false,'not_found'::text;
  return;
 end if;

 -- Idempotent replay is allowed only for a cancellation previously finalized
 -- by this exact verified-no-submission path.
 if job_row.status='cancelled' then
  select * into credit_row
  from executive_visuals.billing_credit_reservations
  where job_id=p_job_id and owner_id=p_owner_id;
  if credit_row.state='released'
     and credit_row.evidence->>'evidenceType'='verified_no_submission'
     and credit_row.evidence->>'evidenceId'='neon-queued-cancel:'||p_job_id::text then
   select coalesce(sum(amount),0) into current_balance
   from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
   return query select true,'cancelled'::text,current_balance,
     credit_row.reserved_credits,true,'already_cancelled'::text;
   return;
  end if;
  return query select false,'cancelled'::text,0::bigint,0::bigint,false,'terminal_job'::text;
  return;
 end if;

 if job_row.status<>'queued' then
  return query select false,job_row.status,0::bigint,0::bigint,false,'provider_submission_possible'::text;
  return;
 end if;

 -- Any ledger row, including prepared or unknown, prevents a refund. The
 -- existence of a submission record means the worker crossed its boundary.
 if exists(
  select 1 from executive_visuals.video_generation_submissions
  where job_id=p_job_id and owner_id=p_owner_id
 ) then
  return query select false,job_row.status,0::bigint,0::bigint,false,'submission_record_exists'::text;
  return;
 end if;

 select * into budget_row
 from executive_visuals.video_generation_budget_reservations
 where job_id=p_job_id and owner_id=p_owner_id
 for update;
 select * into credit_row
 from executive_visuals.billing_credit_reservations
 where job_id=p_job_id and owner_id=p_owner_id
 for update;

 if budget_row.id is null or credit_row.id is null
    or budget_row.state<>'reserved' or credit_row.state<>'reserved'
    or coalesce(job_row.input->>'provider','')<>budget_row.provider then
  return query select false,job_row.status,0::bigint,0::bigint,false,'financial_reservation_not_active'::text;
  return;
 end if;

 proof:=jsonb_build_object(
  'provider',budget_row.provider,
  'evidenceType','verified_no_submission',
  'evidenceId','neon-queued-cancel:'||p_job_id::text,
  'evidenceReference','neon-queue:verified-no-submission:'||p_job_id::text,
  'source','atomic-queued-job-cancellation',
  'jobId',p_job_id
 );

 -- This RPC verifies the active reservations and appends the credit refund.
 -- Its locks and all following job/event writes share this transaction.
 select * into financial_receipt
 from executive_visuals.finalize_video_generation_financials_v1(
  p_job_id,p_owner_id,'cancelled',null,null,proof
 );

 update executive_visuals.jobs
 set status='cancelled',
     cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),
     error=jsonb_build_object(
       'code','VIDEO_CANCELLED_BEFORE_SUBMISSION',
       'message','Cancelled while queued; no provider submission was recorded.'
     ),
     completed_at=clock_timestamp(),
     updated_at=clock_timestamp(),
     available_at=null,
     lease_owner=null,lease_token=null,lease_expires_at=null,lease_heartbeat_at=null
 where id=p_job_id and owner_id=p_owner_id and status='queued';

 if not found then
  raise exception 'VIDEO_CANCEL_RACE_REJECTED';
 end if;

 insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
 values(p_job_id,p_owner_id,'job.cancelled_before_submission',
  jsonb_build_object('status','cancelled','financialFinalized',true,
   'creditAdjustment',coalesce(financial_receipt.credit_adjustment,0),
   'evidenceType','verified_no_submission'));

 return query select true,'cancelled'::text,
  coalesce(financial_receipt.balance,0),
  coalesce(financial_receipt.credit_adjustment,0),
  coalesce(financial_receipt.replayed,false),
  'cancelled_before_submission'::text;
end;
$cancel_queued_video_generation_job_v1$;

revoke all on function executive_visuals.cancel_queued_video_generation_job_v1(uuid,uuid) from public;
commit;

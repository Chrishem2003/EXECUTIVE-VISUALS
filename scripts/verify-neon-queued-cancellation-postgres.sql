-- Disposable PostgreSQL integration for safe queued Neon video cancellation.
-- Run after Neon migrations 0001-0009. Never run against a user or production DB.
\set ON_ERROR_STOP on

insert into executive_visuals.jobs(id,owner_id,job_type,status,input,idempotency_key)
values
 ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','video.generate','queued',
  '{"provider":"runway","model":"gen4.5","requestHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}','ci-queued-cancel'),
 ('55555555-5555-4555-8555-555555555555','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','video.generate','queued',
  '{"provider":"runway","model":"gen4.5","requestHash":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}','ci-cancel-with-submission');

select * from executive_visuals.grant_generation_credits_v1(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',500,'ci-queued-cancel-credit-grant',
 '{"source":"disposable-postgres-queued-cancellation-test"}'::jsonb
);

select executive_visuals.configure_video_budget_policy_v1(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',null,'runway','gen4.5','USD',20,5,10,true
) as policy_id \gset

select executive_visuals.issue_video_budget_approval_v1(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',null,'runway','gen4.5',
 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','USD',4,
 'CI queued cancellation approval',300
) as cancel_approval \gset

select * from executive_visuals.reserve_video_generation_financials_v1(
 '44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 :'cancel_approval',4,100,'ci-queued-cancel-reservation'
);

-- The second queued job deliberately has a submission record. It must not be
-- cancelled or refunded, even though no provider task ID has been recorded.
insert into executive_visuals.video_generation_submissions(job_id,owner_id,provider,model,request_hash,state)
values('55555555-5555-4555-8555-555555555555','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'runway','gen4.5','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','prepared');

do $neon_cancel$
declare first_result record; replay_result record; blocked_result record;
       job_state text; credit_state text; budget_state text; balance_now bigint; event_count integer;
begin
 select * into first_result from executive_visuals.cancel_queued_video_generation_job_v1(
  '44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 );
 if not first_result.cancelled or first_result.job_status<>'cancelled'
    or first_result.credit_adjustment<>100 or first_result.replayed
    or first_result.reason<>'cancelled_before_submission' then
  raise exception 'first queued cancellation receipt mismatch: %',row_to_json(first_result);
 end if;

 select * into replay_result from executive_visuals.cancel_queued_video_generation_job_v1(
  '44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 );
 if not replay_result.cancelled or not replay_result.replayed
    or replay_result.balance<>500 or replay_result.credit_adjustment<>100 then
  raise exception 'queued cancellation replay mismatch: %',row_to_json(replay_result);
 end if;

 select * into blocked_result from executive_visuals.cancel_queued_video_generation_job_v1(
  '55555555-5555-4555-8555-555555555555','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 );
 if blocked_result.cancelled or blocked_result.reason<>'submission_record_exists' then
  raise exception 'job with a submission record was incorrectly cancellable: %',row_to_json(blocked_result);
 end if;

 select status into job_state from executive_visuals.jobs where id='44444444-4444-4444-8444-444444444444';
 select state into credit_state from executive_visuals.billing_credit_reservations where job_id='44444444-4444-4444-8444-444444444444';
 select state into budget_state from executive_visuals.video_generation_budget_reservations where job_id='44444444-4444-4444-8444-444444444444';
 select coalesce(sum(amount),0) into balance_now from executive_visuals.billing_credit_ledger where owner_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 select count(*) into event_count from executive_visuals.job_events where job_id='44444444-4444-4444-8444-444444444444' and event_type='job.cancelled_before_submission';
 if job_state<>'cancelled' or credit_state<>'released' or budget_state<>'released'
    or balance_now<>500 or event_count<>1 then
  raise exception 'queued cancellation accounting/event mismatch: job %, credit %, budget %, balance %, events %',
   job_state,credit_state,budget_state,balance_now,event_count;
 end if;
end $neon_cancel$;

select 'NEON_SAFE_QUEUED_CANCELLATION_OK' as result;

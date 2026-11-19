-- Disposable PostgreSQL integration test for atomic video admission.
-- Run after Neon migrations 0001-0006; never run against production.
\set ON_ERROR_STOP on
do $atomic_video_enqueue$
declare
 owner_id uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 project_id uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 request_hash text:='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
 failed_hash text:='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
 approval_id uuid; failed_approval uuid; first_result record; replay_result record;
 job_count integer; budget_count integer; credit_count integer; ledger_count integer;
 jobs_before integer; jobs_after integer;
begin
 perform * from executive_visuals.grant_generation_credits_v1(
  owner_id,1000,'ci-atomic-video-enqueue-credit-grant',
  '{"source":"disposable-atomic-enqueue-test"}'::jsonb
 );
 perform executive_visuals.configure_video_budget_policy_v1(
  owner_id,project_id,'runway','gen4.5','USD',20,5,20,true
 );
 approval_id:=executive_visuals.issue_video_budget_approval_v1(
  owner_id,project_id,'runway','gen4.5',request_hash,'USD',4,
  'Atomic enqueue integration test',300
 );
 select * into first_result from executive_visuals.enqueue_video_generation_job_v1(
  owner_id,project_id,'ci-video-request-1',
  jsonb_build_object('provider','runway','model','gen4.5','requestHash',request_hash,'prompt','CI atomic enqueue'),
  approval_id,4,150,2
 );
 if first_result.job_id is null or first_result.idempotent_replay then
  raise exception 'first atomic enqueue did not create a fresh job';
 end if;
 select count(*) into job_count from executive_visuals.jobs where id=first_result.job_id and status='queued';
 select count(*) into budget_count from executive_visuals.video_generation_budget_reservations where job_id=first_result.job_id and state='reserved';
 select count(*) into credit_count from executive_visuals.billing_credit_reservations where job_id=first_result.job_id and state='reserved';
 select count(*) into ledger_count from executive_visuals.billing_credit_ledger where reference_id=first_result.job_id and event_type='generation_reserve';
 if job_count<>1 or budget_count<>1 or credit_count<>1 or ledger_count<>1 then
  raise exception 'atomic enqueue did not persist exactly one job, budget, credit reservation and ledger event';
 end if;

 select * into replay_result from executive_visuals.enqueue_video_generation_job_v1(
  owner_id,project_id,'ci-video-request-1',
  jsonb_build_object('provider','runway','model','gen4.5','requestHash',request_hash,'prompt','CI atomic enqueue'),
  approval_id,4,150,2
 );
 select count(*) into ledger_count from executive_visuals.billing_credit_ledger where reference_id=replay_result.job_id and event_type='generation_reserve';
 if replay_result.job_id<>first_result.job_id or not replay_result.idempotent_replay or ledger_count<>1 then
  raise exception 'atomic enqueue replay created duplicate reservations or changed the job';
 end if;

 begin
  perform * from executive_visuals.enqueue_video_generation_job_v1(
   owner_id,project_id,'ci-video-request-1',
   jsonb_build_object('provider','runway','model','gen4.5','requestHash',request_hash,'prompt','CI atomic enqueue'),
   approval_id,4,151,2
  );
  raise exception 'changed reservation unexpectedly replayed';
 exception when others then
  if sqlerrm<>'VIDEO_FINANCIAL_RESERVATION_CONFLICT' then raise; end if;
 end;

 failed_approval:=executive_visuals.issue_video_budget_approval_v1(
  owner_id,project_id,'runway','gen4.5',failed_hash,'USD',4,
  'Atomic rollback integration test',300
 );
 select count(*) into jobs_before from executive_visuals.jobs where owner_id=owner_id and idempotency_key='ci-video-request-insufficient-credits';
 begin
  perform * from executive_visuals.enqueue_video_generation_job_v1(
   owner_id,project_id,'ci-video-request-insufficient-credits',
   jsonb_build_object('provider','runway','model','gen4.5','requestHash',failed_hash,'prompt','must rollback'),
   failed_approval,4,5000,2
  );
  raise exception 'insufficient credit reservation unexpectedly succeeded';
 exception when others then
  if sqlerrm<>'BILLING_INSUFFICIENT_CREDITS' then raise; end if;
 end;
 select count(*) into jobs_after from executive_visuals.jobs j where j.owner_id=owner_id and j.idempotency_key='ci-video-request-insufficient-credits';
 if jobs_before<>jobs_after or jobs_after<>0 then raise exception 'failed financial reservation left a queue job behind'; end if;
end $atomic_video_enqueue$;
select 'NEON_ATOMIC_VIDEO_ENQUEUE_POSTGRES_INTEGRATION_OK' as result;

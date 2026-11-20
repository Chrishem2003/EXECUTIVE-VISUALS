-- Disposable PostgreSQL integration test for atomic video admission.
-- Run after Neon migrations 0001-0006; never run against production.
\set ON_ERROR_STOP on
do $atomic_video_enqueue$
declare
 v_owner_id uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 v_project_id uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 v_request_hash text:='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
 v_failed_hash text:='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
 v_approval_id uuid; v_failed_approval uuid; v_first_result record; v_replay_result record;
 v_job_count integer; v_budget_count integer; v_credit_count integer; v_ledger_count integer;
 v_jobs_before integer; v_jobs_after integer;
begin
 perform * from executive_visuals.grant_generation_credits_v1(
  v_owner_id,1000,'ci-atomic-video-enqueue-credit-grant',
  '{"source":"disposable-atomic-enqueue-test"}'::jsonb
 );
 perform executive_visuals.configure_video_budget_policy_v1(
  v_owner_id,v_project_id,'runway','gen4.5','USD',20,5,20,true
 );
 v_approval_id:=executive_visuals.issue_video_budget_approval_v1(
  v_owner_id,v_project_id,'runway','gen4.5',v_request_hash,'USD',4,
  'Atomic enqueue integration test',300
 );
 select * into v_first_result from executive_visuals.enqueue_video_generation_job_v1(
  v_owner_id,v_project_id,'ci-video-request-1',
  jsonb_build_object('provider','runway','model','gen4.5','requestHash',v_request_hash,'prompt','CI atomic enqueue'),
  v_approval_id,4,150,2
 );
 if v_first_result.job_id is null or v_first_result.idempotent_replay then
  raise exception 'first atomic enqueue did not create a fresh job';
 end if;
 select count(*) into v_job_count from executive_visuals.jobs where id=v_first_result.job_id and status='queued';
 select count(*) into v_budget_count from executive_visuals.video_generation_budget_reservations where job_id=v_first_result.job_id and state='reserved';
 select count(*) into v_credit_count from executive_visuals.billing_credit_reservations where job_id=v_first_result.job_id and state='reserved';
 select count(*) into v_ledger_count from executive_visuals.billing_credit_ledger where reference_id=v_first_result.job_id and event_type='generation_reserve';
 if v_job_count<>1 or v_budget_count<>1 or v_credit_count<>1 or v_ledger_count<>1 then
  raise exception 'atomic enqueue did not persist exactly one job, budget, credit reservation and ledger event';
 end if;

 select * into v_replay_result from executive_visuals.enqueue_video_generation_job_v1(
  v_owner_id,v_project_id,'ci-video-request-1',
  jsonb_build_object('provider','runway','model','gen4.5','requestHash',v_request_hash,'prompt','CI atomic enqueue'),
  v_approval_id,4,150,2
 );
 select count(*) into v_ledger_count from executive_visuals.billing_credit_ledger where reference_id=v_replay_result.job_id and event_type='generation_reserve';
 if v_replay_result.job_id<>v_first_result.job_id or not v_replay_result.idempotent_replay or v_ledger_count<>1 then
  raise exception 'atomic enqueue replay created duplicate reservations or changed the job';
 end if;

 begin
  perform * from executive_visuals.enqueue_video_generation_job_v1(
   v_owner_id,v_project_id,'ci-video-request-1',
   jsonb_build_object('provider','runway','model','gen4.5','requestHash',v_request_hash,'prompt','CI atomic enqueue'),
   v_approval_id,4,151,2
  );
  raise exception 'changed reservation unexpectedly replayed';
 exception when others then
  if sqlerrm<>'VIDEO_FINANCIAL_RESERVATION_CONFLICT' then raise; end if;
 end;

 v_failed_approval:=executive_visuals.issue_video_budget_approval_v1(
  v_owner_id,v_project_id,'runway','gen4.5',v_failed_hash,'USD',4,
  'Atomic rollback integration test',300
 );
 select count(*) into v_jobs_before from executive_visuals.jobs where owner_id=v_owner_id and idempotency_key='ci-video-request-insufficient-credits';
 begin
  perform * from executive_visuals.enqueue_video_generation_job_v1(
   v_owner_id,v_project_id,'ci-video-request-insufficient-credits',
   jsonb_build_object('provider','runway','model','gen4.5','requestHash',v_failed_hash,'prompt','must rollback'),
   v_failed_approval,4,5000,2
  );
  raise exception 'insufficient credit reservation unexpectedly succeeded';
 exception when others then
  if sqlerrm<>'BILLING_INSUFFICIENT_CREDITS' then raise; end if;
 end;
 select count(*) into v_jobs_after from executive_visuals.jobs j where j.owner_id=v_owner_id and j.idempotency_key='ci-video-request-insufficient-credits';
 if v_jobs_before<>v_jobs_after or v_jobs_after<>0 then raise exception 'failed financial reservation left a queue job behind'; end if;
end $atomic_video_enqueue$;
select 'NEON_ATOMIC_VIDEO_ENQUEUE_POSTGRES_INTEGRATION_OK' as result;

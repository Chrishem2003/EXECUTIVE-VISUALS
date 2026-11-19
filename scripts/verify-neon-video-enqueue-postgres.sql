-- Disposable PostgreSQL integration test for atomic video admission.
-- Run after Neon migrations 0001-0006; never run against production.
\set ON_ERROR_STOP on
\set owner_id 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
\set project_id 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
\set request_hash 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
\set failed_hash 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'

select * from executive_visuals.grant_generation_credits_v1(
 :'owner_id'::uuid,1000,'ci-atomic-video-enqueue-credit-grant',
 '{"source":"disposable-atomic-enqueue-test"}'::jsonb
);

select executive_visuals.configure_video_budget_policy_v1(
 :'owner_id'::uuid,:'project_id'::uuid,'runway','gen4.5','USD',20,5,20,true
) as policy_id \gset

select executive_visuals.issue_video_budget_approval_v1(
 :'owner_id'::uuid,:'project_id'::uuid,'runway','gen4.5',:'request_hash','USD',4,
 'Atomic enqueue integration test',300
) as approval_id \gset

select * from executive_visuals.enqueue_video_generation_job_v1(
 :'owner_id'::uuid,:'project_id'::uuid,'ci-video-request-1',
 jsonb_build_object('provider','runway','model','gen4.5','requestHash',:'request_hash','prompt','CI atomic enqueue'),
 :'approval_id'::uuid,4,150,2
) \gset

do $atomic_enqueue$
declare r record; job_count integer; budget_count integer; credit_count integer; ledger_count integer;
begin
 if :'job_id' is null then raise exception 'atomic enqueue did not return a job id'; end if;
 select count(*) into job_count from executive_visuals.jobs where id=:'job_id'::uuid and status='queued';
 select count(*) into budget_count from executive_visuals.video_generation_budget_reservations where job_id=:'job_id'::uuid and state='reserved';
 select count(*) into credit_count from executive_visuals.billing_credit_reservations where job_id=:'job_id'::uuid and state='reserved';
 select count(*) into ledger_count from executive_visuals.billing_credit_ledger where reference_id=:'job_id'::uuid and event_type='generation_reserve';
 if job_count<>1 or budget_count<>1 or credit_count<>1 or ledger_count<>1 then
  raise exception 'atomic enqueue did not persist exactly one job, budget, credit reservation and ledger event';
 end if;
end $atomic_enqueue$;

-- Exact replay returns the original job and reservations without double charging.
select * from executive_visuals.enqueue_video_generation_job_v1(
 :'owner_id'::uuid,:'project_id'::uuid,'ci-video-request-1',
 jsonb_build_object('provider','runway','model','gen4.5','requestHash',:'request_hash','prompt','CI atomic enqueue'),
 :'approval_id'::uuid,4,150,2
) \gset replay_

do $atomic_replay$
declare r record; reserve_count integer; ledger_count integer;
begin
 select count(*) into reserve_count from executive_visuals.billing_credit_reservations where job_id=:'replay_job_id'::uuid;
 select count(*) into ledger_count from executive_visuals.billing_credit_ledger where reference_id=:'replay_job_id'::uuid and event_type='generation_reserve';
 if :'replay_job_id'<>:'job_id' or :'replay_idempotent_replay'<>'t' or reserve_count<>1 or ledger_count<>1 then
  raise exception 'atomic enqueue replay created duplicate reservations or changed the job';
 end if;
end $atomic_replay$;

-- Changed financial terms for the same idempotency key are rejected.
do $atomic_conflict$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job_v1(
   :'owner_id'::uuid,:'project_id'::uuid,'ci-video-request-1',
   jsonb_build_object('provider','runway','model','gen4.5','requestHash',:'request_hash','prompt','CI atomic enqueue'),
   :'approval_id'::uuid,4,151,2
  );
  raise exception 'changed reservation unexpectedly replayed';
 exception when others then
  if sqlerrm<>'VIDEO_FINANCIAL_RESERVATION_CONFLICT' then raise; end if;
 end;
end $atomic_conflict$;

-- A failed reservation must roll back the queue row and its enqueue event.
select executive_visuals.issue_video_budget_approval_v1(
 :'owner_id'::uuid,:'project_id'::uuid,'runway','gen4.5',:'failed_hash','USD',4,
 'Atomic rollback integration test',300
) as failed_approval \gset

do $atomic_rollback$
declare jobs_before integer; jobs_after integer;
begin
 select count(*) into jobs_before from executive_visuals.jobs where owner_id=:'owner_id'::uuid and idempotency_key='ci-video-request-insufficient-credits';
 begin
  perform * from executive_visuals.enqueue_video_generation_job_v1(
   :'owner_id'::uuid,:'project_id'::uuid,'ci-video-request-insufficient-credits',
   jsonb_build_object('provider','runway','model','gen4.5','requestHash',:'failed_hash','prompt','must rollback'),
   :'failed_approval'::uuid,4,5000,2
  );
  raise exception 'insufficient credit reservation unexpectedly succeeded';
 exception when others then
  if sqlerrm<>'BILLING_INSUFFICIENT_CREDITS' then raise; end if;
 end;
 select count(*) into jobs_after from executive_visuals.jobs where owner_id=:'owner_id'::uuid and idempotency_key='ci-video-request-insufficient-credits';
 if jobs_before<>jobs_after or jobs_after<>0 then raise exception 'failed financial reservation left a queue job behind'; end if;
end $atomic_rollback$;

select 'NEON_ATOMIC_VIDEO_ENQUEUE_POSTGRES_INTEGRATION_OK' as result;

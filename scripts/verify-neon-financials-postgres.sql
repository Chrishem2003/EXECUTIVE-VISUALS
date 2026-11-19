-- Disposable PostgreSQL integration test for Neon-native financial migrations.
-- Run only against a throwaway CI database after migrations 0001-0003.
\set ON_ERROR_STOP on

insert into executive_visuals.jobs(id,owner_id,job_type,status,input,idempotency_key)
values
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','video.generate','queued',
  '{"provider":"runway","model":"gen4.5","requestHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}','neon-financial-success'),
 ('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','video.generate','queued',
  '{"provider":"runway","model":"gen4.5","requestHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}','neon-financial-failure');

select * from executive_visuals.grant_generation_credits_v1(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1000,'ci-neon-credit-grant',
 '{"source":"disposable-postgres-integration-test"}'::jsonb
);

select executive_visuals.configure_video_budget_policy_v1(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,'runway','gen4.5','USD',20,5,10,true
) as policy_id \gset

select executive_visuals.issue_video_budget_approval_v1(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,'runway','gen4.5',
 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','USD',4,
 'CI approved test generation',300
) as success_approval \gset

select * from executive_visuals.reserve_video_generation_financials_v1(
 '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 :'success_approval',4,100,'ci-success-reservation'
);

-- Replaying after the one-use approval was consumed must return the same reservation.
do $$
declare r record; approval_id uuid;
begin
 select id into approval_id from executive_visuals.video_generation_budget_approvals where owner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and request_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' order by created_at desc limit 1;
 select * into r from executive_visuals.reserve_video_generation_financials_v1(
  '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  approval_id,4,100,'ci-success-reservation'
 );
 if not r.replayed then raise exception 'reservation replay was not idempotent'; end if;
end $$;

select lease_token as success_lease from executive_visuals.claim_next_job_v2('ci-worker',90,array['video.generate'])
where id='11111111-1111-4111-8111-111111111111' \gset

do $$
declare ok boolean; lease_value uuid;
begin
 select lease_token into lease_value from executive_visuals.jobs where id='11111111-1111-4111-8111-111111111111';
 select executive_visuals.finish_video_generation_job_v1(
  '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'ci-worker', lease_value,'succeeded',
  '{"provider":"runway","model":"gen4.5","providerTaskId":"ci-task-success","costEvidenceReference":"ci-receipt-success","actualAmount":3,"currency":"USD"}'::jsonb,
  null,3,75,
  '{"provider":"runway","model":"gen4.5","providerTaskId":"ci-task-success","evidenceType":"provider_task_receipt","evidenceId":"ci-event-success","evidenceReference":"ci-receipt-success"}'::jsonb
 ) into ok;
 if not ok then raise exception 'valid success finalization rejected'; end if;
end $$;

do $$
declare balance_now bigint; spent numeric; reserved numeric; cost_count integer; job_status text;
begin
 select sum(amount) into balance_now from executive_visuals.billing_credit_ledger where owner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 select spent_amount,reserved_amount into spent,reserved from executive_visuals.video_generation_budget_policies where owner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and project_id is null and provider='runway' and model='gen4.5';
 select count(*) into cost_count from executive_visuals.video_generation_cost_ledger where job_id='11111111-1111-4111-8111-111111111111';
 select status into job_status from executive_visuals.jobs where id='11111111-1111-4111-8111-111111111111';
 if balance_now<>925 or spent<>3 or reserved<>0 or cost_count<>1 or job_status<>'succeeded' then
  raise exception 'success accounting mismatch: balance %, spent %, reserved %, costs %, status %',balance_now,spent,reserved,cost_count,job_status;
 end if;
end $$;

select executive_visuals.issue_video_budget_approval_v1(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,'runway','gen4.5',
 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','USD',4,
 'CI approved non-billable failure',300
) as failure_approval \gset
select * from executive_visuals.reserve_video_generation_financials_v1(
 '22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 :'failure_approval',4,50,'ci-failure-reservation'
);
select lease_token as failure_lease from executive_visuals.claim_next_job_v2('ci-worker',90,array['video.generate'])
where id='22222222-2222-4222-8222-222222222222' \gset

-- A failure without proof that the provider did not charge must not release credits.
do $$
declare lease_value uuid;
begin
 select lease_token into lease_value from executive_visuals.jobs where id='22222222-2222-4222-8222-222222222222';
 begin
  perform executive_visuals.finish_video_generation_job_v1(
   '22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'ci-worker', lease_value,'failed',null,'{"code":"PROVIDER_ERROR"}'::jsonb,null,null,'{}'::jsonb
  );
  raise exception 'unverified failure release unexpectedly succeeded';
 exception when others then
  if sqlerrm<>'VIDEO_FAILURE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE' then raise; end if;
 end;
end $$;

do $$
declare ok boolean; lease_value uuid;
begin
 select lease_token into lease_value from executive_visuals.jobs where id='22222222-2222-4222-8222-222222222222';
 select executive_visuals.finish_video_generation_job_v1(
  '22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'ci-worker', lease_value,'failed',null,'{"code":"VERIFIED_NO_SUBMISSION"}'::jsonb,null,null,
  '{"provider":"runway","evidenceType":"verified_no_submission","evidenceId":"ci-no-submit","evidenceReference":"ci-provider-lookup"}'::jsonb
 ) into ok;
 if not ok then raise exception 'verified non-billable failure finalization rejected'; end if;
end $$;

do $$
declare balance_now bigint; reserved bigint; released_count integer; job_status text;
begin
 select sum(amount) into balance_now from executive_visuals.billing_credit_ledger where owner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 select sum(reserved_credits) into reserved from executive_visuals.billing_credit_reservations where owner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and state='reserved';
 select count(*) into released_count from executive_visuals.billing_credit_reservations where job_id='22222222-2222-4222-8222-222222222222' and state='released';
 select status into job_status from executive_visuals.jobs where id='22222222-2222-4222-8222-222222222222';
 if balance_now<>925 or coalesce(reserved,0)<>0 or released_count<>1 or job_status<>'failed' then
  raise exception 'failure release mismatch: balance %, reserved %, released %, status %',balance_now,reserved,released_count,job_status;
 end if;
end $$;

select 'NEON_FINANCIAL_POSTGRES_INTEGRATION_OK' as result;

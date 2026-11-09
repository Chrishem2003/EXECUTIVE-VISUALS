-- Disposable PostgreSQL integration tests for atomic customer credit accounting.
\set ON_ERROR_STOP on

insert into auth.users(id) values('66666666-6666-4666-8666-666666666666') on conflict(id) do nothing;
insert into executive_visuals.projects(id,owner_id,name)
values('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','Customer credit integration')
on conflict(id) do nothing;

insert into executive_visuals.billing_credit_accounts(owner_id)
values('66666666-6666-4666-8666-666666666666') on conflict(owner_id) do nothing;

select * from executive_visuals.grant_generation_credits(
 '66666666-6666-4666-8666-666666666666',100,'integration-credit-grant-001',
 'Postgres integration seed','{"source":"ci_fixture"}'::jsonb
) \gset grant_

do $credit_grant_replay$
declare r record;
begin
 select * into r from executive_visuals.grant_generation_credits(
  '66666666-6666-4666-8666-666666666666',100,'integration-credit-grant-001',
  'Replay','{"source":"ci_fixture"}'::jsonb
 );
 if r.replayed is distinct from true or r.balance is distinct from 100 then raise exception 'credit grant idempotency failed: replayed %, balance %',r.replayed,r.balance; end if;
end
$credit_grant_replay$;

insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input)
values(
 '44444444-4444-4444-8444-444444444444',
 '66666666-6666-4666-8666-666666666666',
 '77777777-7777-4777-8777-777777777777',
 'video.generate','queued','{"provider":"runway","workflowQuoteId":"88888888-8888-4888-8888-888888888888"}'::jsonb
);

select * from executive_visuals.reserve_generation_credits(
 '66666666-6666-4666-8666-666666666666',
 '44444444-4444-4444-8444-444444444444',30,'integration-credit-reserve-001'
) \gset reserve_

do $credit_reservation_assertions$
declare r record; current_balance bigint;
begin
 select coalesce(sum(amount),0) into current_balance
 from executive_visuals.billing_credit_ledger
 where owner_id='66666666-6666-4666-8666-666666666666';
 if current_balance<>70 then raise exception 'reservation did not debit 30 credits'; end if;
 select * into r from executive_visuals.reserve_generation_credits(
  '66666666-6666-4666-8666-666666666666',
  '44444444-4444-4444-8444-444444444444',30,'integration-credit-reserve-001'
 );
 if not r.replayed or r.balance<>70 then raise exception 'reservation replay was not idempotent'; end if;
 begin
  perform * from executive_visuals.reserve_generation_credits(
   '66666666-6666-4666-8666-666666666666',
   '44444444-4444-4444-8444-444444444444',31,'integration-credit-reserve-001'
  );
  raise exception 'conflicting reservation replay unexpectedly succeeded';
 exception when others then
  if sqlerrm='conflicting reservation replay unexpectedly succeeded' then raise; end if;
  if sqlerrm<>'BILLING_CREDIT_IDEMPOTENCY_CONFLICT' then raise; end if;
 end;
end
$credit_reservation_assertions$;

select * from executive_visuals.settle_generation_credit_reservation(
 (select id from executive_visuals.billing_credit_reservations where idempotency_key='integration-credit-reserve-001'),18,
 '{"provider":"runway","evidenceType":"provider_task_receipt","evidenceId":"task-credit-001","providerTaskId":"task-credit-001","evidenceReference":"provider-invoice:task-credit-001"}'::jsonb
) \gset settlement_

do $credit_settlement_assertions$
declare r record; current_balance bigint;
begin
 select coalesce(sum(amount),0) into current_balance
 from executive_visuals.billing_credit_ledger
 where owner_id='66666666-6666-4666-8666-666666666666';
 if current_balance<>82 then raise exception 'settlement did not refund unused 12 credits'; end if;
 select * into r from executive_visuals.settle_generation_credit_reservation(
  (select id from executive_visuals.billing_credit_reservations where idempotency_key='integration-credit-reserve-001'),18,
  '{"provider":"runway","evidenceType":"provider_task_receipt","evidenceId":"task-credit-001","providerTaskId":"task-credit-001"}'::jsonb
 );
 if not r.replayed or r.balance<>82 or r.adjustment<>12 then
  raise exception 'identical settlement replay failed';
 end if;
 select * into r from executive_visuals.settle_generation_credits_for_job(
  '44444444-4444-4444-8444-444444444444',
  '66666666-6666-4666-8666-666666666666',
  'runway',18,
  '{"provider":"runway","evidenceType":"provider_task_receipt","evidenceId":"task-credit-001","evidenceReference":"provider-invoice:task-credit-001"}'::jsonb
 );
 if not r.replayed or r.balance<>82 or r.adjustment<>12 then
  raise exception 'job-scoped provider credit settlement replay failed';
 end if;
 begin
  perform * from executive_visuals.settle_generation_credits_for_job(
   '44444444-4444-4444-8444-444444444444',
   '66666666-6666-4666-8666-666666666666',
   'fal',18,
   '{"provider":"fal","evidenceType":"provider_task_receipt","evidenceId":"task-credit-001","evidenceReference":"provider-invoice:task-credit-001"}'::jsonb
  );
  raise exception 'provider mismatch unexpectedly settled customer credits';
 exception when others then
  if sqlerrm='provider mismatch unexpectedly settled customer credits' then raise; end if;
  if sqlerrm<>'BILLING_CREDIT_PROVIDER_MISMATCH' then raise; end if;
 end;
 begin
  perform * from executive_visuals.settle_generation_credit_reservation(
   (select id from executive_visuals.billing_credit_reservations where idempotency_key='integration-credit-reserve-001'),19,
   '{"provider":"runway","evidenceType":"provider_task_receipt","evidenceId":"task-credit-001"}'::jsonb
  );
  raise exception 'conflicting settlement unexpectedly succeeded';
 exception when others then
  if sqlerrm='conflicting settlement unexpectedly succeeded' then raise; end if;
  if sqlerrm<>'BILLING_CREDIT_SETTLEMENT_CONFLICT' then raise; end if;
 end;
end
$credit_settlement_assertions$;

insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input)
values(
 '55555555-5555-4555-8555-555555555555',
 '66666666-6666-4666-8666-666666666666',
 '77777777-7777-4777-8777-777777777777',
 'video.generate','queued','{}'::jsonb
);
select * from executive_visuals.reserve_generation_credits(
 '66666666-6666-4666-8666-666666666666',
 '55555555-5555-4555-8555-555555555555',20,'integration-credit-reserve-release'
) \gset release_

do $credit_release_assertions$
declare r record;
begin
 select * into r from executive_visuals.release_generation_credit_reservation(
  (select id from executive_visuals.billing_credit_reservations where idempotency_key='integration-credit-reserve-release'),'Provider submission was cancelled before dispatch'
 );
 if r.balance<>82 then raise exception 'reservation release did not restore credits'; end if;
end
$credit_release_assertions$;

do $credit_ledger_immutable$
begin
 begin
  update executive_visuals.billing_credit_ledger
  set description='tampered'
  where id=(select id from executive_visuals.billing_credit_ledger where idempotency_key='integration-credit-grant-001');
  raise exception 'credit ledger unexpectedly allowed mutation';
 exception when others then
  if sqlerrm='credit ledger unexpectedly allowed mutation' then raise; end if;
  if sqlerrm<>'BILLING_CREDIT_LEDGER_IS_APPEND_ONLY' then raise; end if;
 end;
end
$credit_ledger_immutable$;

do $credit_insufficient_balance$
begin
 begin
  perform * from executive_visuals.reserve_generation_credits(
   '66666666-6666-4666-8666-666666666666',
   '55555555-5555-4555-8555-555555555555',1000,'integration-credit-insufficient'
  );
  raise exception 'insufficient customer balance unexpectedly accepted';
 exception when others then
  if sqlerrm='insufficient customer balance unexpectedly accepted' then raise; end if;
  if sqlerrm<>'BILLING_INSUFFICIENT_CREDITS' then raise; end if;
 end;
end
$credit_insufficient_balance$;

select 'cloud customer credit integration passed' as result;

-- Disposable PostgreSQL integration for project-scoped shared credit pools.
-- Run after cloud-video-postgres-integration.sql and the shared-pool migration.
set role service_role;

select * from executive_visuals.configure_project_credit_pool(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',2000
);
select * from executive_visuals.fund_project_credit_pool(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',1000,'project-pool-topup-0001'
);
-- Same top-up key is a replay, not a second debit or grant.
do $pool_topup_replay$
declare result record; personal_balance bigint; pool_balance bigint;
begin
 select * into result from executive_visuals.fund_project_credit_pool(
  '123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',1000,'project-pool-topup-0001'
 );
 if not result.replayed or result.pool_balance<>1000 or result.personal_balance<>99000 then
  raise exception 'Project pool top-up replay changed either wallet balance';
 end if;
 select coalesce(sum(amount),0) into personal_balance from executive_visuals.billing_credit_ledger
  where owner_id='123e4567-e89b-42d3-a456-426614174000';
 select coalesce(sum(amount),0) into pool_balance from executive_visuals.project_credit_pool_ledger
  where project_id='323e4567-e89b-42d3-a456-426614174000';
 if personal_balance<>99000 or pool_balance<>1000 then
  raise exception 'Project pool transfer was not balanced across personal and shared ledgers';
 end if;
end
$pool_topup_replay$;

-- A project-owned job is charged to the shared pool through the existing
-- reserve_generation_credits RPC used by the production approval/enqueue path.
insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
values('e23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'pool-integration-job-01');
create temporary table project_pool_reservation_result as
select * from executive_visuals.reserve_generation_credits(
 '123e4567-e89b-42d3-a456-426614174000',
 'e23e4567-e89b-42d3-a456-426614174001',100,'project-pool-job-key-0001'
);
do $pool_reservation$
declare result record; pool_balance bigint; personal_balance bigint; mirror_count integer;
begin
 select * into result from project_pool_reservation_result;
 select coalesce(sum(amount),0) into pool_balance from executive_visuals.project_credit_pool_ledger
  where project_id='323e4567-e89b-42d3-a456-426614174000';
 select coalesce(sum(amount),0) into personal_balance from executive_visuals.billing_credit_ledger
  where owner_id='123e4567-e89b-42d3-a456-426614174000';
 select count(*) into mirror_count from executive_visuals.billing_credit_reservations
  where id=result.reservation_id and job_id='e23e4567-e89b-42d3-a456-426614174001';
 if result.balance<>900 or result.replayed or pool_balance<>900 or personal_balance<>99000 or mirror_count<>1 then
  raise exception 'Generation reservation did not use the project wallet and compatibility mirror';
 end if;
end
$pool_reservation$;

-- Retry of the same approval reservation is idempotent.
do $pool_reservation_replay$
declare result record;
begin
 select * into result from executive_visuals.reserve_generation_credits(
  '123e4567-e89b-42d3-a456-426614174000',
  'e23e4567-e89b-42d3-a456-426614174001',100,'project-pool-job-key-0001'
 );
 if not result.replayed or result.balance<>900 then
  raise exception 'Project pool reservation replay was not idempotent';
 end if;
end
$pool_reservation_replay$;

select * from executive_visuals.settle_generation_credits_for_job(
 'e23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000','runway',80,
 jsonb_build_object('provider','runway','evidenceType','provider_task_receipt',
  'evidenceId','pool-provider-task-01','evidenceReference','receipt:pool-provider-task-01')
);
do $pool_settlement$
declare pool_balance bigint; personal_balance bigint; state text; actual bigint;
begin
 select coalesce(sum(amount),0) into pool_balance from executive_visuals.project_credit_pool_ledger
  where project_id='323e4567-e89b-42d3-a456-426614174000';
 select coalesce(sum(amount),0) into personal_balance from executive_visuals.billing_credit_ledger
  where owner_id='123e4567-e89b-42d3-a456-426614174000';
 select r.state,r.actual_credits into state,actual from executive_visuals.project_credit_pool_reservations r
  where r.job_id='e23e4567-e89b-42d3-a456-426614174001';
 if pool_balance<>920 or personal_balance<>99000 or state<>'settled' or actual<>80 then
  raise exception 'Verified provider settlement did not reconcile the shared project wallet';
 end if;
 if not exists(select 1 from executive_visuals.billing_credit_reservations
  where job_id='e23e4567-e89b-42d3-a456-426614174001' and state='settled' and actual_credits=80) then
  raise exception 'Compatibility reservation mirror did not settle';
 end if;
end
$pool_settlement$;

-- A configured pool is authoritative: insufficient pool funds cannot silently
-- fall back to the owner's much larger personal balance.
insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
values('e23e4567-e89b-42d3-a456-426614174002',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'pool-integration-job-02');
do $pool_no_personal_fallback$
begin
 begin
  perform * from executive_visuals.reserve_generation_credits(
   '123e4567-e89b-42d3-a456-426614174000',
   'e23e4567-e89b-42d3-a456-426614174002',1000,'project-pool-job-key-0002'
  );
  raise exception 'Project pool unexpectedly fell back to personal credits';
 exception when others then
  if sqlerrm='Project pool unexpectedly fell back to personal credits' then raise; end if;
  if sqlerrm<>'BILLING_INSUFFICIENT_PROJECT_CREDITS' then raise; end if;
 end;
end
$pool_no_personal_fallback$;

-- Release returns unused credits to the same pool, not to the personal wallet.
insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
values('e23e4567-e89b-42d3-a456-426614174003',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'pool-integration-job-03');
create temporary table project_pool_release_result as
select * from executive_visuals.reserve_generation_credits(
 '123e4567-e89b-42d3-a456-426614174000',
 'e23e4567-e89b-42d3-a456-426614174003',50,'project-pool-job-key-0003'
);
select * from executive_visuals.release_generation_credit_reservation(
 (select reservation_id from project_pool_release_result),'User cancelled before provider submission'
);
do $pool_release$
declare pool_balance bigint; state text;
begin
 select coalesce(sum(amount),0) into pool_balance from executive_visuals.project_credit_pool_ledger
  where project_id='323e4567-e89b-42d3-a456-426614174000';
 select r.state into state from executive_visuals.project_credit_pool_reservations r
  where r.job_id='e23e4567-e89b-42d3-a456-426614174003';
 if pool_balance<>920 or state<>'released' then
  raise exception 'Released generation reservation did not return credits to the project pool';
 end if;
end
$pool_release$;

-- Monthly spend caps serialize with reservations and reject excess spend.
select * from executive_visuals.configure_project_credit_pool(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',150
);
insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
values('e23e4567-e89b-42d3-a456-426614174004',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'pool-integration-job-04');
do $pool_monthly_cap$
begin
 begin
  perform * from executive_visuals.reserve_generation_credits(
   '123e4567-e89b-42d3-a456-426614174000',
   'e23e4567-e89b-42d3-a456-426614174004',100,'project-pool-job-key-0004'
  );
  raise exception 'Project monthly spend cap unexpectedly allowed excess usage';
 exception when others then
  if sqlerrm='Project monthly spend cap unexpectedly allowed excess usage' then raise; end if;
  if sqlerrm<>'PROJECT_CREDIT_POOL_MONTHLY_LIMIT_REACHED' then raise; end if;
 end;
end
$pool_monthly_cap$;

-- Only the actual project owner may configure the shared wallet.
do $pool_owner_scope$
begin
 begin
  perform executive_visuals.configure_project_credit_pool(
   '223e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',0
  );
  raise exception 'Non-owner unexpectedly configured the project credit pool';
 exception when others then
  if sqlerrm='Non-owner unexpectedly configured the project credit pool' then raise; end if;
  if sqlstate<>'42501' then raise; end if;
 end;
end
$pool_owner_scope$;

reset role;
select 'project shared credit pool PostgreSQL integration checks passed' as result;

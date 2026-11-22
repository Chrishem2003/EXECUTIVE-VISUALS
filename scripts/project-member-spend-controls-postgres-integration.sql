-- Disposable PostgreSQL integration for project member spend policies.
-- Run after cloud-video-postgres-integration.sql, shared pools and member controls.
set role service_role;

reset role;
insert into executive_visuals.project_members(project_id,member_id,role,invited_by)
values('323e4567-e89b-42d3-a456-426614174000',
 '223e4567-e89b-42d3-a456-426614174000','editor',
 '123e4567-e89b-42d3-a456-426614174000')
on conflict(project_id,member_id) do update set role='editor';
set role service_role;

select * from executive_visuals.configure_project_credit_pool(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',500
);
select executive_visuals.configure_project_credit_pool_member_policy(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 '223e4567-e89b-42d3-a456-426614174000',100,'active'
);

insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
values('e23e4567-e89b-42d3-a456-426614174005',
 '223e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'member-pool-job-05');
create temporary table member_pool_reservation_result as
select * from executive_visuals.reserve_generation_credits(
 '223e4567-e89b-42d3-a456-426614174000',
 'e23e4567-e89b-42d3-a456-426614174005',70,'project-member-reserve-0005'
);

do $member_attribution$
declare result record; pool_owner uuid; actor uuid; mirror_owner uuid; balance bigint;
begin
 select * into result from member_pool_reservation_result;
 select owner_id,actor_id into pool_owner,actor
  from executive_visuals.project_credit_pool_ledger
  where reference_id='e23e4567-e89b-42d3-a456-426614174005'
   and event_type='generation_reserve';
 select owner_id into mirror_owner from executive_visuals.billing_credit_reservations
  where id=result.reservation_id;
 select coalesce(sum(amount),0) into balance from executive_visuals.project_credit_pool_ledger
  where project_id='323e4567-e89b-42d3-a456-426614174000';
 if result.balance<>850 or result.replayed or pool_owner<>'123e4567-e89b-42d3-a456-426614174000'
    or actor<>'223e4567-e89b-42d3-a456-426614174000'
    or mirror_owner<>'223e4567-e89b-42d3-a456-426614174000' or balance<>850 then
  raise exception 'Member generation was not attributed to the actor and charged to the project owner pool';
 end if;
end
$member_attribution$;

do $member_reservation_replay$
declare result record;
begin
 select * into result from executive_visuals.reserve_generation_credits(
  '223e4567-e89b-42d3-a456-426614174000',
  'e23e4567-e89b-42d3-a456-426614174005',70,'project-member-reserve-0005'
 );
 if not result.replayed or result.balance<>850 then
  raise exception 'Member reservation replay charged the shared wallet twice';
 end if;
end
$member_reservation_replay$;

do $member_limit_blocks_excess$
begin
 insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
 values('e23e4567-e89b-42d3-a456-426614174006',
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'member-pool-job-06');
 begin
  perform * from executive_visuals.reserve_generation_credits(
   '223e4567-e89b-42d3-a456-426614174000',
   'e23e4567-e89b-42d3-a456-426614174006',40,'project-member-reserve-0006'
  );
  raise exception 'Project member monthly spend limit unexpectedly allowed 110 credits';
 exception when others then
  if sqlerrm='Project member monthly spend limit unexpectedly allowed 110 credits' then raise; end if;
  if sqlerrm<>'PROJECT_CREDIT_POOL_MEMBER_LIMIT_REACHED' then raise; end if;
 end;
end
$member_limit_blocks_excess$;

select * from executive_visuals.settle_generation_credits_for_job(
 'e23e4567-e89b-42d3-a456-426614174005',
 '223e4567-e89b-42d3-a456-426614174000','runway',50,
 jsonb_build_object('provider','runway','evidenceType','provider_task_receipt',
  'evidenceId','member-pool-provider-task-05','evidenceReference','receipt:member-pool-provider-task-05')
);

insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
values('e23e4567-e89b-42d3-a456-426614174007',
 '223e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'member-pool-job-07');
create temporary table member_pool_release_result as
select * from executive_visuals.reserve_generation_credits(
 '223e4567-e89b-42d3-a456-426614174000',
 'e23e4567-e89b-42d3-a456-426614174007',40,'project-member-reserve-0007'
);
select * from executive_visuals.release_generation_credit_reservation(
 (select reservation_id from member_pool_release_result),'Member cancelled before provider submission'
);

do $member_release_and_usage$
declare usage record; reservation_state text; pool_balance bigint;
begin
 select * into usage from executive_visuals.list_project_credit_pool_member_usage(
  '123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000'
 ) where member_id='223e4567-e89b-42d3-a456-426614174000';
 select state into reservation_state from executive_visuals.project_credit_pool_reservations
  where job_id='e23e4567-e89b-42d3-a456-426614174007';
 select coalesce(sum(amount),0) into pool_balance from executive_visuals.project_credit_pool_ledger
  where project_id='323e4567-e89b-42d3-a456-426614174000';
 if usage.used_this_month<>50 or usage.monthly_limit_credits<>100 or usage.remaining_this_month<>50
    or reservation_state<>'released' or pool_balance<>870 then
  raise exception 'Member settlement, release or usage reporting did not reconcile';
 end if;
end
$member_release_and_usage$;

select executive_visuals.configure_project_credit_pool_member_policy(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 '223e4567-e89b-42d3-a456-426614174000',100,'paused'
);

do $member_pause_blocks_dispatch$
begin
 insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
 values('e23e4567-e89b-42d3-a456-426614174008',
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'member-pool-job-08');
 begin
  perform * from executive_visuals.reserve_generation_credits(
   '223e4567-e89b-42d3-a456-426614174000',
   'e23e4567-e89b-42d3-a456-426614174008',1,'project-member-reserve-0008'
  );
  raise exception 'Paused project member unexpectedly reserved credits';
 exception when others then
  if sqlerrm='Paused project member unexpectedly reserved credits' then raise; end if;
  if sqlerrm<>'PROJECT_CREDIT_POOL_MEMBER_PAUSED' then raise; end if;
 end;
end
$member_pause_blocks_dispatch$;

do $member_role_gate$
begin
 update executive_visuals.project_members set role='viewer'
  where project_id='323e4567-e89b-42d3-a456-426614174000'
   and member_id='223e4567-e89b-42d3-a456-426614174000';
 insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
 values('e23e4567-e89b-42d3-a456-426614174009',
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  'video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'member-pool-job-09');
 begin
  perform * from executive_visuals.reserve_generation_credits(
   '223e4567-e89b-42d3-a456-426614174000',
   'e23e4567-e89b-42d3-a456-426614174009',1,'project-member-reserve-0009'
  );
  raise exception 'Viewer unexpectedly reserved project credits';
 exception when others then
  if sqlerrm='Viewer unexpectedly reserved project credits' then raise; end if;
  if sqlerrm<>'PROJECT_CREDIT_POOL_MEMBER_NOT_ALLOWED' then raise; end if;
 end;
end
$member_role_gate$;

do $member_policy_owner_scope$
begin
 begin
  perform executive_visuals.configure_project_credit_pool_member_policy(
   '223e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   '123e4567-e89b-42d3-a456-426614174000',10,'active'
  );
  raise exception 'Non-owner unexpectedly changed a member spend policy';
 exception when others then
  if sqlerrm='Non-owner unexpectedly changed a member spend policy' then raise; end if;
  if sqlstate<>'42501' then raise; end if;
 end;
end
$member_policy_owner_scope$;

reset role;
select 'project member spend controls PostgreSQL integration checks passed' as result;

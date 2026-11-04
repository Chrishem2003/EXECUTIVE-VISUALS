\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('123e4567-e89b-42d3-a456-426614174000'),
 ('223e4567-e89b-42d3-a456-426614174000');
insert into executive_visuals.projects(id,owner_id) values
 ('323e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000');

select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);
set role authenticated;

-- Owner can configure limits, but cannot write accounting counters.
insert into executive_visuals.video_generation_budget_policies(
 id,owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '423e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5','USD',10,5,10,true
);
do $column_guard$
begin
 if has_column_privilege('authenticated','executive_visuals.video_generation_budget_policies','reserved_amount','UPDATE')
    or has_column_privilege('authenticated','executive_visuals.video_generation_budget_policies','spent_amount','UPDATE') then
   raise exception 'authenticated unexpectedly has budget counter update privileges';
 end if;
 if not has_column_privilege('authenticated','executive_visuals.video_generation_budget_policies','spend_limit_amount','UPDATE') then
   raise exception 'authenticated cannot update permitted budget configuration';
 end if;
end
$column_guard$;

-- Only the project owner can create an approval; it is short-lived and single-use.
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values (
 '523e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5',repeat('a',64),'USD',2,'integration test',clock_timestamp()+interval '10 minutes'
);
do $owner_guard$
begin
 begin
  insert into executive_visuals.video_generation_budget_approvals(
   id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,expires_at
  ) values (
   '623e4567-e89b-42d3-a456-426614174000',
   '223e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'runway','gen4.5',repeat('b',64),'USD',1,clock_timestamp()+interval '10 minutes'
  );
  raise exception 'approval owner spoof unexpectedly succeeded';
 exception when others then
  if sqlerrm = 'approval owner spoof unexpectedly succeeded' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_APPROVAL_OWNER_INVALID' then raise; end if;
 end;
end
$owner_guard$;

reset role;
set role service_role;

-- Atomic enqueue creates the job, budget reservation, usage reservation and events.
select job_id as job_id, budget_reservation_id as reservation_id
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-video-001','runway','gen4.5',repeat('a',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','gen4.5','requestHash',repeat('a',64),'prompt','test scene'),
 '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
) \gset

-- Replaying the same key returns the same job and reservation, even after approval consumption.
select job_id as replay_job_id, budget_reservation_id as replay_reservation_id, idempotent_replay as replay
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-video-001','runway','gen4.5',repeat('a',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','gen4.5','requestHash',repeat('a',64),'prompt','test scene'),
 '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
) \gset
do $idempotency$
begin
 if :'replay' <> 't' or :'job_id' <> :'replay_job_id' or :'reservation_id' <> :'replay_reservation_id' then
   raise exception 'idempotent enqueue did not return the same job and reservation';
 end if;
end
$idempotency$;

-- A consumed approval cannot authorize a different idempotency key.
do $approval_replay$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-video-approval-replay','runway','gen4.5',repeat('a',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','gen4.5','requestHash',repeat('a',64)),
   '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
  );
  raise exception 'consumed approval unexpectedly authorized another job';
 exception when others then
  if sqlerrm = 'consumed approval unexpectedly authorized another job' then raise; end if;
  if sqlerrm <> 'VIDEO_JOB_BUDGET_APPROVAL_INVALID' then raise; end if;
 end;
end
$approval_replay$;

-- Simulate the queue lease and durable provider submission lifecycle.
update executive_visuals.jobs
set status='processing',lease_owner='video-worker-pg-test',
    lease_expires_at=clock_timestamp()+interval '5 minutes',
    lease_heartbeat_at=clock_timestamp(),attempt_count=1
where id=:'job_id'::uuid;

select * from executive_visuals.prepare_video_generation_submission(
 :'job_id'::uuid,'123e4567-e89b-42d3-a456-426614174000','runway','gen4.5',repeat('a',64)
);
select executive_visuals.begin_video_generation_submission(:'job_id'::uuid,'video-worker-pg-test');
select executive_visuals.record_video_generation_submission(
 :'job_id'::uuid,'video-worker-pg-test','runway-task-pg-test','{"acceptedStatus":"queued"}'::jsonb
);

insert into executive_visuals.assets(id,owner_id,project_id,storage_bucket,media_type)
values (
 '723e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'executive-visuals-media','video/mp4'
);

select executive_visuals.finish_video_generation_job(
 :'job_id'::uuid,'video-worker-pg-test','succeeded',
 jsonb_build_object('providerTaskId','runway-task-pg-test',
   'assetIds',jsonb_build_array('723e4567-e89b-42d3-a456-426614174000')),
 null,0.75
);

do $final_state$
declare
 policy_row executive_visuals.video_generation_budget_policies;
 reservation_row executive_visuals.video_generation_budget_reservations;
 job_row executive_visuals.jobs;
 submission_row executive_visuals.video_generation_submissions;
begin
 select * into policy_row from executive_visuals.video_generation_budget_policies
 where id='423e4567-e89b-42d3-a456-426614174000';
 select * into reservation_row from executive_visuals.video_generation_budget_reservations where job_id=:'job_id'::uuid;
 select * into job_row from executive_visuals.jobs where id=:'job_id'::uuid;
 select * into submission_row from executive_visuals.video_generation_submissions where job_id=:'job_id'::uuid;
 if policy_row.reserved_amount <> 0 or policy_row.spent_amount <> 0.75 then raise exception 'budget counters did not settle atomically'; end if;
 if reservation_row.state <> 'settled' or reservation_row.actual_amount <> 0.75 then raise exception 'reservation did not settle'; end if;
 if job_row.status <> 'succeeded' or job_row.lease_owner is not null then raise exception 'job did not finish and release its lease'; end if;
 if submission_row.state <> 'succeeded' or submission_row.provider_task_id <> 'runway-task-pg-test' then raise exception 'submission ledger did not terminalize'; end if;
 if (select count(*) from executive_visuals.video_generation_usage_reservations) <> 1 then raise exception 'usage reservation missing or duplicated'; end if;
end
$final_state$;

reset role;
select 'cloud video PostgreSQL integration checks passed' as result;

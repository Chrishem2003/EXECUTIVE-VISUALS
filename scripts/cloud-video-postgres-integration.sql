\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('123e4567-e89b-42d3-a456-426614174000'),
 ('223e4567-e89b-42d3-a456-426614174000');
insert into executive_visuals.projects(id,owner_id,name) values
 ('323e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000','Cloud video PostgreSQL test');

select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);
set role authenticated;

insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5','USD',10,5,10,true
);
select set_config('test.video_policy_id',id::text,false)
from executive_visuals.video_generation_budget_policies
where owner_id='123e4567-e89b-42d3-a456-426614174000'
  and project_id='323e4567-e89b-42d3-a456-426614174000'
  and provider='runway' and model='gen4.5' and currency='USD';
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

-- A different authenticated user cannot issue an approval against another owner's project.
select set_config('request.jwt.claim.sub','223e4567-e89b-42d3-a456-426614174000',false);
do $project_approval_guard$
begin
 begin
  insert into executive_visuals.video_generation_budget_approvals(
   id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,expires_at
  ) values (
   'a23e4567-e89b-42d3-a456-426614174000',
   '223e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'runway','gen4.5',repeat('d',64),'USD',1,clock_timestamp()+interval '10 minutes'
  );
  raise exception 'non-owner project approval unexpectedly succeeded';
 exception when others then
  if sqlerrm = 'non-owner project approval unexpectedly succeeded' then raise; end if;
  if sqlstate <> '42501' then raise; end if;
 end;
end
$project_approval_guard$;
select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);

reset role;
set role service_role;

create temporary table test_context as
select job_id, budget_reservation_id as reservation_id
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-video-001','runway','gen4.5',repeat('a',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','gen4.5','requestHash',repeat('a',64),'prompt','test scene','durationSeconds',5),
 '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
);

create temporary table replay_context as
select job_id, budget_reservation_id as reservation_id, idempotent_replay
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-video-001','runway','gen4.5',repeat('a',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','gen4.5','requestHash',repeat('a',64),'prompt','test scene','durationSeconds',5),
 '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
);
do $idempotency$
declare first_row test_context; replay_row replay_context;
begin
 select * into first_row from test_context;
 select * into replay_row from replay_context;
 if not replay_row.idempotent_replay or first_row.job_id <> replay_row.job_id
    or first_row.reservation_id <> replay_row.reservation_id then
   raise exception 'idempotent enqueue did not return the same job and reservation';
 end if;
end
$idempotency$;

do $price_floor$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-video-underpriced','runway','gen4.5',repeat('d',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','gen4.5','requestHash',repeat('d',64),
     'durationSeconds',5,'outputFormat','mp4'),
   '523e4567-e89b-42d3-a456-426614174000',0.5,'USD'
  );
  raise exception 'underpriced generation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'underpriced generation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE' then raise; end if;
 end;
end
$price_floor$;

do $unpriced_provider$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-video-unpriced','luma','ray-3.2',repeat('e',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','luma','model','ray-3.2','requestHash',repeat('e',64),
     'durationSeconds',5,'outputFormat','mp4'),
   '523e4567-e89b-42d3-a456-426614174000',1,'USD'
  );
  raise exception 'unpriced provider unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'unpriced provider unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED' then raise; end if;
 end;
end
$unpriced_provider$;

do $approval_replay$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-video-approval-replay','runway','gen4.5',repeat('a',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','gen4.5','requestHash',repeat('a',64),
     'durationSeconds',5,'outputFormat','mp4'),
   '523e4567-e89b-42d3-a456-426614174000',1.25,'USD'
  );
  raise exception 'consumed approval unexpectedly authorized another job';
 exception when others then
  if sqlerrm = 'consumed approval unexpectedly authorized another job' then raise; end if;
  if sqlerrm <> 'VIDEO_JOB_BUDGET_APPROVAL_INVALID' then raise; end if;
 end;
end
$approval_replay$;

update executive_visuals.jobs
set status='processing',lease_owner='video-worker-pg-test',
    lease_expires_at=clock_timestamp()+interval '5 minutes',
    lease_heartbeat_at=clock_timestamp(),attempt_count=1
where id=(select job_id from test_context);

select * from executive_visuals.prepare_video_generation_submission(
 (select job_id from test_context),
 '123e4567-e89b-42d3-a456-426614174000','runway','gen4.5',repeat('a',64)
);
select executive_visuals.begin_video_generation_submission((select job_id from test_context),'video-worker-pg-test');
select executive_visuals.record_video_generation_submission(
 (select job_id from test_context),'video-worker-pg-test','runway-task-pg-test','{"acceptedStatus":"queued"}'::jsonb
);

-- A completed task cannot settle without a reviewed evidence receipt.
do $missing_cost_evidence$
begin
 begin
  perform executive_visuals.finish_video_generation_job_with_evidence(
   (select job_id from test_context),'video-worker-pg-test',
   jsonb_build_object('providerTaskId','runway-task-pg-test',
     'assetIds',jsonb_build_array('723e4567-e89b-42d3-a456-426614174000'),
     'costEvidenceReference','missing-evidence'),
   0.75,'missing-evidence'
  );
  raise exception 'settlement without reviewed cost evidence unexpectedly succeeded';
 exception when others then
  if sqlerrm = 'settlement without reviewed cost evidence unexpectedly succeeded' then raise; end if;
  if sqlerrm <> 'VIDEO_COST_EVIDENCE_RECEIPT_MISMATCH' then raise; end if;
 end;
end
$missing_cost_evidence$;

-- The project owner reviews a task-correlated evidence artifact before settlement.
reset role;
set role authenticated;
do $wrong_cost_evidence_task$
begin
 begin
  insert into executive_visuals.video_generation_cost_evidence(
   job_id,reservation_id,owner_id,project_id,provider,model,provider_task_id,
   actual_amount,currency,source_type,evidence_reference,evidence_sha256,reviewer_id
  ) values (
   (select job_id from test_context),(select reservation_id from test_context),
   '123e4567-e89b-42d3-a456-426614174000','323e4567-e89b-42d3-a456-426614174000',
   'runway','gen4.5','wrong-task-id',0.75,'USD','provider_support',
   'provider-support://case/wrong-task',repeat('c',64),
   '123e4567-e89b-42d3-a456-426614174000'
  );
  raise exception 'evidence for a different task unexpectedly succeeded';
 exception when others then
  if sqlerrm = 'evidence for a different task unexpectedly succeeded' then raise; end if;
  if sqlerrm <> 'VIDEO_COST_EVIDENCE_TASK_MISMATCH' then raise; end if;
 end;
end
$wrong_cost_evidence_task$;

insert into executive_visuals.video_generation_cost_evidence(
 job_id,reservation_id,owner_id,project_id,provider,model,provider_task_id,
 actual_amount,currency,source_type,evidence_reference,evidence_sha256,
 reviewer_id,reviewer_note
) values (
 (select job_id from test_context),
 (select reservation_id from test_context),
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5','runway-task-pg-test',
 0.75,'USD','provider_support',
 'provider-support://case/cev-pg-test',repeat('b',64),
 '123e4567-e89b-42d3-a456-426614174000',
 'Provider confirmed the charge for this exact task ID.'
);
reset role;
set role service_role;
do $immutable_cost_evidence$
begin
 begin
  update executive_visuals.video_generation_cost_evidence
  set reviewer_note='attempted mutation'
  where job_id=(select job_id from test_context);
  raise exception 'reviewed cost evidence unexpectedly changed';
 exception when others then
  if sqlerrm = 'reviewed cost evidence unexpectedly changed' then raise; end if;
  if sqlerrm <> 'VIDEO_COST_EVIDENCE_IMMUTABLE' then raise; end if;
 end;
end
$immutable_cost_evidence$;
reset role;
set role service_role;

insert into executive_visuals.assets(
 id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path
) values (
 '723e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'generated-video-1.mp4','video/mp4',1024,repeat('a',64),
 'executive-visuals-media',
 '323e4567-e89b-42d3-a456-426614174000/723e4567-e89b-42d3-a456-426614174000/original.mp4'
);

select executive_visuals.finish_video_generation_job_with_evidence(
 (select job_id from test_context),'video-worker-pg-test',
 jsonb_build_object('providerTaskId','runway-task-pg-test',
   'assetIds',jsonb_build_array('723e4567-e89b-42d3-a456-426614174000'),
   'costEvidenceReference','provider-support://case/cev-pg-test'),
 0.75,'provider-support://case/cev-pg-test'
);

select policy_row.id,policy_row.reserved_amount,policy_row.spent_amount,
       reservation_row.state,reservation_row.actual_amount,
       job_row.status,job_row.lease_owner,submission_row.state,
       submission_row.provider_task_id,
       evidence_row.reviewer_id,
       evidence_row.evidence_sha256,
       (select count(*) from executive_visuals.video_generation_usage_reservations) as usage_count
from executive_visuals.video_generation_budget_policies policy_row
cross join executive_visuals.video_generation_budget_reservations reservation_row
cross join executive_visuals.jobs job_row
cross join executive_visuals.video_generation_submissions submission_row
cross join executive_visuals.video_generation_cost_evidence evidence_row
where policy_row.id=current_setting('test.video_policy_id')::uuid
  and reservation_row.job_id=(select job_id from test_context)
  and job_row.id=(select job_id from test_context)
  and submission_row.job_id=(select job_id from test_context)
  and evidence_row.job_id=(select job_id from test_context);

select 1 / case when exists (
  select 1
  from executive_visuals.video_generation_budget_policies policy_row
  join executive_visuals.video_generation_budget_reservations reservation_row
    on reservation_row.job_id=(select job_id from test_context)
  join executive_visuals.jobs job_row
    on job_row.id=(select job_id from test_context)
  join executive_visuals.video_generation_submissions submission_row
    on submission_row.job_id=(select job_id from test_context)
  where policy_row.id=current_setting('test.video_policy_id')::uuid
    and policy_row.reserved_amount=0 and policy_row.spent_amount=0.75
    and reservation_row.state='settled' and reservation_row.actual_amount=0.75
    and job_row.status='succeeded' and job_row.lease_owner is null
    and submission_row.state='succeeded'
    and submission_row.provider_task_id='runway-task-pg-test'
    and exists (select 1 from executive_visuals.video_generation_cost_evidence e
      where e.job_id=(select job_id from test_context)
        and e.reviewer_id='123e4567-e89b-42d3-a456-426614174000'
        and e.evidence_sha256=repeat('b',64))
    and (select count(*) from executive_visuals.video_generation_usage_reservations)=1
) then 1 else 0 end as final_state_assertion;

do $provider_gate$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-unpriced-provider','luma','ray-3.2',repeat('d',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','luma','model','ray-3.2','requestHash',repeat('d',64)),
   '523e4567-e89b-42d3-a456-426614174000',0.5,'USD'
  );
  raise exception 'provider without verified pricing was accepted';
 exception when others then
  if sqlerrm = 'provider without verified pricing was accepted' then raise; end if;
  if sqlerrm <> 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED' then raise; end if;
 end;
end
$provider_gate$;

reset role;
select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);
set role authenticated;
do $budget_floor$
begin
 begin
  update executive_visuals.video_generation_budget_policies
  set spend_limit_amount=0.5,max_per_job_amount=0.5
  where id=current_setting('test.video_policy_id')::uuid;
  raise exception 'budget ceiling was lowered below committed spend';
 exception when others then
  if sqlerrm = 'budget ceiling was lowered below committed spend' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_LIMIT_BELOW_COMMITTED_SPEND' then raise; end if;
 end;
end
$budget_floor$;
reset role;
set role service_role;
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values (
 '923e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5',repeat('c',64),'USD',1,'overrun test',clock_timestamp()+interval '10 minutes'
);
reset role;
set role service_role;
create temporary table overrun_context as
select job_id, budget_reservation_id as reservation_id
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-video-overrun','runway','gen4.5',repeat('c',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','gen4.5','requestHash',repeat('c',64),'durationSeconds',2),
 '923e4567-e89b-42d3-a456-426614174000',0.5,'USD'
);
update executive_visuals.jobs
set status='processing',lease_owner='video-worker-overrun',
    lease_expires_at=clock_timestamp()+interval '5 minutes'
where id=(select job_id from overrun_context);
do $overrun_guard$
begin
 begin
  perform executive_visuals.finish_video_generation_job(
   (select job_id from overrun_context),'video-worker-overrun','succeeded','{}'::jsonb,null,0.75
  );
  raise exception 'over-reservation actual cost unexpectedly settled';
 exception when others then
  if sqlerrm = 'over-reservation actual cost unexpectedly settled' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_ACTUAL_EXCEEDS_RESERVATION' then raise; end if;
 end;
end
$overrun_guard$;
do $overrun_state$
declare policy_row executive_visuals.video_generation_budget_policies;
       reservation_row executive_visuals.video_generation_budget_reservations;
       target_job uuid;
       job_row executive_visuals.jobs;
begin
 select job_id into target_job from overrun_context;
 select * into policy_row from executive_visuals.video_generation_budget_policies
 where id=current_setting('test.video_policy_id')::uuid;
 select * into reservation_row from executive_visuals.video_generation_budget_reservations where job_id=target_job;
 select * into job_row from executive_visuals.jobs where id=target_job;
 if policy_row.reserved_amount <> 0.5 or policy_row.spent_amount <> 0.75 then
  raise exception 'failed overrun settlement changed budget counters';
 end if;
 if reservation_row.state <> 'reserved' or job_row.status <> 'processing' then
  raise exception 'failed overrun settlement partially changed job or reservation state';
 end if;
end
$overrun_state$;

reset role;
select 'cloud video PostgreSQL integration checks passed' as result;

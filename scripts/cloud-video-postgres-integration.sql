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
insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'google','gemini-omni-1.1-flash','USD',10,3,10,true
);
select set_config('test.google_video_policy_id',id::text,false)
from executive_visuals.video_generation_budget_policies
where owner_id='123e4567-e89b-42d3-a456-426614174000'
  and project_id='323e4567-e89b-42d3-a456-426614174000'
  and provider='google' and model='gemini-omni-1.1-flash' and currency='USD';
insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2','USD',10,5,10,true
);
select set_config('test.aleph2_video_policy_id',id::text,false)
from executive_visuals.video_generation_budget_policies
where owner_id='123e4567-e89b-42d3-a456-426614174000'
  and project_id='323e4567-e89b-42d3-a456-426614174000'
  and provider='runway' and model='aleph2' and currency='USD';
insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values (
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','model-router','USD',10,5,10,true
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

insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values (
 '523e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5',repeat('a',64),'USD',2,'integration test',clock_timestamp()+interval '10 minutes'
);
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values
 ('b23e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000','google','gemini-omni-1.1-flash',repeat('b',64),'USD',3,'Gemini integration test',clock_timestamp()+interval '10 minutes'),
 ('c23e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000','google','gemini-omni-1.1-flash',repeat('c',64),'USD',3,'Gemini under-reservation test',clock_timestamp()+interval '10 minutes'),
 ('d23e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000','google','gemini-omni-1.1-flash',repeat('d',64),'USD',3,'Gemini resolution test',clock_timestamp()+interval '10 minutes');
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values (
 'f23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','model-router',repeat('f',64),'USD',5,'Runway Model Router integration test',clock_timestamp()+interval '10 minutes'
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

-- Workflow quote ledger: service-role-only immutable quote recording.
do $workflow_quote_privileges$
begin
 if has_table_privilege('authenticated','executive_visuals.video_workflow_quotes','SELECT')
    or has_table_privilege('authenticated','executive_visuals.video_workflow_quotes','INSERT')
    or has_table_privilege('authenticated','executive_visuals.video_workflow_quotes','UPDATE') then
   raise exception 'authenticated unexpectedly has direct workflow quote table access';
 end if;
 if has_function_privilege('authenticated',
   'executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)',
   'EXECUTE') then
   raise exception 'authenticated unexpectedly can record workflow quotes';
 end if;
end
$workflow_quote_privileges$;

select executive_visuals.record_video_workflow_quote(
 '723e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-workflow-quote-001',repeat('e',64),'runway','model-router','text-to-video',
 'runway','gen4.5',275,2.75,'USD','studio-video',
 'runway_model_router_dry_run',clock_timestamp()+interval '4 minutes'
);

do $workflow_quote_record$
declare quote_row executive_visuals.video_workflow_quotes;
begin
 select * into quote_row from executive_visuals.video_workflow_quotes
 where id='723e4567-e89b-42d3-a456-426614174000';
 if quote_row.id is null or quote_row.owner_id <> '123e4567-e89b-42d3-a456-426614174000'
    or quote_row.project_id <> '323e4567-e89b-42d3-a456-426614174000'
    or quote_row.request_hash <> repeat('e',64)
    or quote_row.state <> 'quoted'
    or quote_row.estimated_amount <> 2.75
    or quote_row.currency <> 'USD' then
   raise exception 'workflow quote ledger did not preserve the exact quote scope';
 end if;
 begin
  perform executive_visuals.record_video_workflow_quote(
   '823e4567-e89b-42d3-a456-426614174000',
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-workflow-quote-invalid',repeat('d',64),'runway','model-router','text-to-video',
   'runway','gen4.5',275,-1,'USD','studio-video',
   'runway_model_router_dry_run',clock_timestamp()+interval '4 minutes'
  );
  raise exception 'invalid workflow quote amount unexpectedly recorded';
 exception when others then
  if sqlerrm = 'invalid workflow quote amount unexpectedly recorded' then raise; end if;
  if sqlerrm <> 'VIDEO_WORKFLOW_QUOTE_ARGUMENTS_INVALID' then raise; end if;
 end;
end
$workflow_quote_record$;

-- Explicit workflow approval atomically consumes the quote, records the approval,
-- reserves the project budget and queues one idempotent durable job.
do $workflow_quote_approval_privileges$
begin
 if has_function_privilege('authenticated',
   'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)',
   'EXECUTE') then
  raise exception 'authenticated unexpectedly can approve and enqueue workflow video';
 end if;
end
$workflow_quote_approval_privileges$;

create temporary table workflow_approval_result as
select * from executive_visuals.approve_and_enqueue_video_workflow(
 '723e4567-e89b-42d3-a456-426614174000',
 'a23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 repeat('e',64),'pg-workflow-quote-001','studio-video',
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','runway','model','model-router','requestHash',repeat('e',64),
  'operation','text-to-video','durationSeconds',5,'outputFormat','mp4',
  'workflowQuoteId','723e4567-e89b-42d3-a456-426614174000',
  'workflowRequestId','pg-workflow-quote-001'
 ),2.75,'Approved exact workflow quote integration test'
);

do $workflow_quote_approval_result$
declare result_row record; quote_row executive_visuals.video_workflow_quotes;
       reservation executive_visuals.video_generation_budget_reservations;
       approval executive_visuals.video_generation_budget_approvals;
       policy executive_visuals.video_generation_budget_policies;
begin
 select * into result_row from workflow_approval_result;
 select * into quote_row from executive_visuals.video_workflow_quotes
  where id='723e4567-e89b-42d3-a456-426614174000';
 select * into reservation from executive_visuals.video_generation_budget_reservations
  where job_id=result_row.job_id;
 select * into approval from executive_visuals.video_generation_budget_approvals
  where id=reservation.approval_id;
 select * into policy from executive_visuals.video_generation_budget_policies
  where owner_id='123e4567-e89b-42d3-a456-426614174000'
   and project_id='323e4567-e89b-42d3-a456-426614174000'
   and provider='runway' and model='model-router';
 if result_row.job_id is null or result_row.job_status <> 'queued'
    or result_row.idempotent_replay
    or result_row.budget_reservation_id is distinct from reservation.id
    or result_row.approval_id is distinct from approval.id
    or quote_row.state <> 'consumed'
    or reservation.state <> 'reserved'
    or reservation.reserved_amount <> 2.75
    or approval.consumed_at is null
    or policy.reserved_amount <> 2.75 then
  raise exception 'workflow approval did not atomically consume quote, approve, reserve and enqueue';
 end if;
end
$workflow_quote_approval_result$;

create temporary table workflow_approval_replay as
select * from executive_visuals.approve_and_enqueue_video_workflow(
 '723e4567-e89b-42d3-a456-426614174000',
 'b23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 repeat('e',64),'pg-workflow-quote-001','studio-video',
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','runway','model','model-router','requestHash',repeat('e',64),
  'operation','text-to-video','durationSeconds',5,'outputFormat','mp4',
  'workflowQuoteId','723e4567-e89b-42d3-a456-426614174000',
  'workflowRequestId','pg-workflow-quote-001'
 ),2.75,'Idempotent replay of approved workflow quote'
);

do $workflow_quote_approval_replay$
declare first_row record; replay_row record;
begin
 select * into first_row from workflow_approval_result;
 select * into replay_row from workflow_approval_replay;
 if not replay_row.idempotent_replay
    or replay_row.job_id is distinct from first_row.job_id
    or replay_row.budget_reservation_id is distinct from first_row.budget_reservation_id
    or replay_row.approval_id is distinct from first_row.approval_id then
  raise exception 'workflow approval retry did not return the original job and reservation';
 end if;
end
$workflow_quote_approval_replay$;

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

do $router_invalid_operation$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-router-invalid-op','runway','model-router',repeat('f',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','model-router','requestHash',repeat('f',64),
     'operation','audio-to-video','durationSeconds',8,'outputFormat','mp4',
     'prompt','A cinematic product launch'),
   'f23e4567-e89b-42d3-a456-426614174000',4.5,'USD'
  );
  raise exception 'unsupported Runway Model Router operation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'unsupported Runway Model Router operation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_OPERATION_INVALID' then raise; end if;
 end;
end
$router_invalid_operation$;

do $router_duration_guard$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-router-duration','runway','model-router',repeat('f',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','runway','model','model-router','requestHash',repeat('f',64),
     'operation','text-to-video','durationSeconds',31,'outputFormat','mp4',
     'prompt','A cinematic product launch'),
   'f23e4567-e89b-42d3-a456-426614174000',4.5,'USD'
  );
  raise exception 'overlong Runway Model Router operation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'overlong Runway Model Router operation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_DURATION_INVALID' then raise; end if;
 end;
end
$router_duration_guard$;

create temporary table runway_router_context as
select job_id, budget_reservation_id as reservation_id, job_status
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-runway-router-001','runway','model-router',repeat('f',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','runway','model','model-router','requestHash',repeat('f',64),
   'operation','text-to-video','durationSeconds',8,'outputFormat','mp4',
   'prompt','A cinematic product launch','aspectRatio','16:9'),
 'f23e4567-e89b-42d3-a456-426614174000',4.5,'USD'
);

create temporary table google_context as
select job_id, budget_reservation_id as reservation_id, job_status
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-google-video-001','google','gemini-omni-1.1-flash',repeat('b',64),
 jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
   'provider','google','model','gemini-omni-1.1-flash','requestHash',repeat('b',64),
   'prompt','A cinematic sunrise','operation','generate','durationSeconds',5,
   'resolution','720p','aspectRatio','16:9','outputFormat','mp4'),
 'b23e4567-e89b-42d3-a456-426614174000',2.586464,'USD'
);
do $google_enqueue_assertion$
declare queued google_context; policy_row executive_visuals.video_generation_budget_policies;
begin
 select * into queued from google_context;
 select * into policy_row from executive_visuals.video_generation_budget_policies
 where id=current_setting('test.google_video_policy_id')::uuid;
 if queued.job_status <> 'queued' or policy_row.reserved_amount <> 2.586464 then
   raise exception 'Gemini Omni enqueue did not create the expected queued reservation';
 end if;
end
$google_enqueue_assertion$;

do $google_budget_floor$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-google-underpriced','google','gemini-omni-1.1-flash',repeat('c',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','google','model','gemini-omni-1.1-flash','requestHash',repeat('c',64),
     'prompt','A cinematic sunrise','durationSeconds',5,'resolution','720p','outputFormat','mp4'),
   'c23e4567-e89b-42d3-a456-426614174000',2.586463,'USD'
  );
  raise exception 'under-reserved Gemini Omni generation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'under-reserved Gemini Omni generation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE' then raise; end if;
 end;
end
$google_budget_floor$;

do $google_resolution_gate$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-google-1080p','google','gemini-omni-1.1-flash',repeat('d',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
     'provider','google','model','gemini-omni-1.1-flash','requestHash',repeat('d',64),
     'prompt','A cinematic sunrise','durationSeconds',5,'resolution','1080p','outputFormat','mp4'),
   'd23e4567-e89b-42d3-a456-426614174000',3,'USD'
  );
  raise exception 'unpriced Gemini Omni resolution unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'unpriced Gemini Omni resolution unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_UNSUPPORTED_RESOLUTION' then raise; end if;
 end;
end
$google_resolution_gate$;

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

select executive_visuals.finish_video_generation_job(
 (select job_id from test_context),'video-worker-pg-test','succeeded',
 jsonb_build_object('providerTaskId','runway-task-pg-test',
   'assetIds',jsonb_build_array('723e4567-e89b-42d3-a456-426614174000')),
 null,0.75
);

select policy_row.id,policy_row.reserved_amount,policy_row.spent_amount,
       reservation_row.state,reservation_row.actual_amount,
       job_row.status,job_row.lease_owner,submission_row.state,
       submission_row.provider_task_id,
       (select count(*) from executive_visuals.video_generation_usage_reservations where job_id=(select job_id from test_context)) as usage_count
from executive_visuals.video_generation_budget_policies policy_row
cross join executive_visuals.video_generation_budget_reservations reservation_row
cross join executive_visuals.jobs job_row
cross join executive_visuals.video_generation_submissions submission_row
where policy_row.id=current_setting('test.video_policy_id')::uuid
  and reservation_row.job_id=(select job_id from test_context)
  and job_row.id=(select job_id from test_context)
  and submission_row.job_id=(select job_id from test_context);

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
    and (select count(*) from executive_visuals.video_generation_usage_reservations where job_id=(select job_id from test_context))=1
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


-- Aleph 2 transformation approval is service-role-only and exact-request bound.
do $aleph2_rpc_acl$
begin
 if has_function_privilege('authenticated',
    'executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)','EXECUTE')
    or has_function_privilege('anon',
    'executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)','EXECUTE') then
   raise exception 'untrusted role can execute the Aleph 2 approval RPC';
 end if;
 if not has_function_privilege('service_role',
    'executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)','EXECUTE') then
   raise exception 'service_role cannot execute the Aleph 2 approval RPC';
 end if;
end
$aleph2_rpc_acl$;

select executive_visuals.create_video_generation_budget_approval(
 'a23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2',repeat('e',64),'USD',3.00,
 'Aleph 2 integration test',clock_timestamp()+interval '10 minutes'
);
create temporary table aleph2_context as
select job_id,job_status,budget_reservation_id
from executive_visuals.enqueue_video_generation_job(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-integration-aleph2-video-001','runway','aleph2',repeat('e',64),
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','runway','model','aleph2','requestHash',repeat('e',64),
  'operation','video-to-video','sourceVideoAssetId','b23e4567-e89b-42d3-a456-426614174000',
  'prompt','Preserve the camera movement and replace the background.',
  'durationSeconds',8,'outputFormat','mp4','resolution','provider_default'
 ),
 'a23e4567-e89b-42d3-a456-426614174000',3.00,'USD'
);
do $aleph2_enqueue_assertion$
declare queued aleph2_context; policy_row executive_visuals.video_generation_budget_policies;
begin
 select * into queued from aleph2_context;
 select * into policy_row from executive_visuals.video_generation_budget_policies
 where id=current_setting('test.aleph2_video_policy_id')::uuid;
 if queued.job_status <> 'queued' or policy_row.reserved_amount <> 3.00 then
  raise exception 'Aleph 2 enqueue did not create the expected queued reservation';
 end if;
 if not exists(select 1 from executive_visuals.video_generation_budget_approvals
   where id='a23e4567-e89b-42d3-a456-426614174000' and consumed_at is not null
     and request_hash=repeat('e',64)) then
  raise exception 'Aleph 2 approval was not consumed against its exact request hash';
 end if;
end
$aleph2_enqueue_assertion$;

select executive_visuals.create_video_generation_budget_approval(
 'b23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2',repeat('f',64),'USD',2.23,
 'Aleph 2 under-reservation test',clock_timestamp()+interval '10 minutes'
);
do $aleph2_price_floor$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-aleph2-underpriced','runway','aleph2',repeat('f',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','aleph2','requestHash',repeat('f',64),
    'operation','video-to-video','sourceVideoAssetId','b23e4567-e89b-42d3-a456-426614174000',
    'prompt','Edit source','durationSeconds',8,'outputFormat','mp4'),
   'b23e4567-e89b-42d3-a456-426614174001',2.23,'USD'
  );
  raise exception 'underpriced Aleph 2 generation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'underpriced Aleph 2 generation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE' then raise; end if;
 end;
end
$aleph2_price_floor$;

select executive_visuals.create_video_generation_budget_approval(
 'c23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2',repeat('c',64),'USD',3.00,
 'Aleph 2 operation gate test',clock_timestamp()+interval '10 minutes'
);
do $aleph2_operation_gate$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-aleph2-wrong-operation','runway','aleph2',repeat('c',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','aleph2','requestHash',repeat('c',64),
    'operation','text-to-video','sourceVideoAssetId','b23e4567-e89b-42d3-a456-426614174000',
    'prompt','Edit source','durationSeconds',8,'outputFormat','mp4'),
   'c23e4567-e89b-42d3-a456-426614174001',3.00,'USD'
  );
  raise exception 'Aleph 2 non-edit operation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'Aleph 2 non-edit operation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_DURATION_OR_OPERATION_INVALID' then raise; end if;
 end;
end
$aleph2_operation_gate$;


select executive_visuals.create_video_generation_budget_approval(
 'd23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','aleph2',repeat('b',64),'USD',3.00,
 'Aleph 2 minimum duration test',clock_timestamp()+interval '10 minutes'
);
do $aleph2_minimum_duration$
begin
 begin
  perform * from executive_visuals.enqueue_video_generation_job(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'pg-integration-aleph2-one-second','runway','aleph2',repeat('b',64),
   jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','aleph2','requestHash',repeat('b',64),
    'operation','video-to-video','sourceVideoAssetId','b23e4567-e89b-42d3-a456-426614174000',
    'prompt','Edit source','durationSeconds',1,'outputFormat','mp4'),
   'd23e4567-e89b-42d3-a456-426614174001',3.00,'USD'
  );
  raise exception 'one-second Aleph 2 generation unexpectedly enqueued';
 exception when others then
  if sqlerrm = 'one-second Aleph 2 generation unexpectedly enqueued' then raise; end if;
  if sqlerrm <> 'VIDEO_PRICE_DURATION_OR_OPERATION_INVALID' then raise; end if;
 end;
end
$aleph2_minimum_duration$;

reset role;
select 'cloud video PostgreSQL integration checks passed' as result;

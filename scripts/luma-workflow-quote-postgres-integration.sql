-- End-to-end disposable PostgreSQL test for the Luma Ray 3.2 quote/approval/enqueue path.
-- No provider network calls are made and no production data is touched.

begin;
set local search_path = executive_visuals, public;
select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',true);
select set_config('request.jwt.claim.role','authenticated',true);

insert into executive_visuals.video_generation_budget_policies(
 owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,
 rolling_24h_request_limit,enabled
) values(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'luma','ray-3.2','USD',10,2,10,true
);

select * from executive_visuals.grant_generation_credits(
 '123e4567-e89b-42d3-a456-426614174000',1000,'luma-ci-credit-grant',
 'Disposable Luma workflow integration credits',
 jsonb_build_object('source','ci-integration','provider','luma')
);

select executive_visuals.record_video_workflow_quote(
 '923e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-luma-workflow-001',repeat('f',64),'luma','ray-3.2','generate',
 'luma','ray-3.2',100,0.300000,'USD','luma-ray32',
 'luma_ray32_published_credits_contract_rate',clock_timestamp()+interval '4 minutes'
);

create temporary table luma_workflow_approval_result as
select * from executive_visuals.approve_and_enqueue_video_workflow(
 '923e4567-e89b-42d3-a456-426614174000',
 'a23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 repeat('f',64),'luma-ray32','pg-luma-workflow-001',
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','luma','model','ray-3.2','operation','generate',
  'requestHash',repeat('f',64),'durationSeconds',5,'resolution','720p',
  'aspectRatio','16:9','audioMode','none','outputFormat','mp4',
  'workflowQuoteId','923e4567-e89b-42d3-a456-426614174000',
  'workflowRequestId','pg-luma-workflow-001'
 ),0.500000,'Approved exact Luma Ray 3.2 quote integration test'
);

do $luma_workflow_approval_assertion$
declare
 result_row record;
 quote_row executive_visuals.video_workflow_quotes;
 reservation executive_visuals.video_generation_budget_reservations;
 customer_reservation executive_visuals.billing_credit_reservations;
 approval executive_visuals.video_generation_budget_approvals;
 policy executive_visuals.video_generation_budget_policies;
 job_row executive_visuals.jobs;
begin
 select * into result_row from luma_workflow_approval_result;
 select * into quote_row from executive_visuals.video_workflow_quotes
  where id='923e4567-e89b-42d3-a456-426614174000';
 select * into reservation from executive_visuals.video_generation_budget_reservations
  where job_id=result_row.job_id;
 select * into customer_reservation from executive_visuals.billing_credit_reservations
  where job_id=result_row.job_id;
 select * into approval from executive_visuals.video_generation_budget_approvals
  where id=reservation.approval_id;
 select * into policy from executive_visuals.video_generation_budget_policies
  where owner_id='123e4567-e89b-42d3-a456-426614174000'
   and project_id='323e4567-e89b-42d3-a456-426614174000'
   and provider='luma' and model='ray-3.2';
 select * into job_row from executive_visuals.jobs where id=result_row.job_id;
 if result_row.job_id is null or result_row.job_status<>'queued' or result_row.idempotent_replay
    or quote_row.state<>'consumed' or quote_row.provider<>'luma' or quote_row.model<>'ray-3.2'
    or quote_row.operation<>'generate' or quote_row.estimated_credits<>100
    or quote_row.estimated_amount<>0.300000
    or quote_row.pricing_source<>'luma_ray32_published_credits_contract_rate'
    or reservation.state<>'reserved' or reservation.reserved_amount<>0.500000
    or reservation.provider<>'luma' or reservation.model<>'ray-3.2'
    or customer_reservation.id is null or customer_reservation.reserved_credits<>100
    or customer_reservation.state<>'reserved' or approval.consumed_at is null
    or policy.reserved_amount<>0.500000
    or job_row.input->>'provider'<>'luma' or job_row.input->>'model'<>'ray-3.2'
    or job_row.input->>'operation'<>'generate' or job_row.status<>'queued' then
  raise exception 'Luma quote, approval, credit reservation and enqueue did not commit atomically';
 end if;
end
$luma_workflow_approval_assertion$;

create temporary table luma_workflow_approval_replay as
select * from executive_visuals.approve_and_enqueue_video_workflow(
 '923e4567-e89b-42d3-a456-426614174000',
 'b23e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 repeat('f',64),'luma-ray32','pg-luma-workflow-001',
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','luma','model','ray-3.2','operation','generate',
  'requestHash',repeat('f',64),'durationSeconds',5,'resolution','720p',
  'aspectRatio','16:9','audioMode','none','outputFormat','mp4',
  'workflowQuoteId','923e4567-e89b-42d3-a456-426614174000',
  'workflowRequestId','pg-luma-workflow-001'
 ),0.500000,'Idempotent Luma workflow approval replay'
);

do $luma_workflow_replay_assertion$
declare first_row record; replay_row record;
begin
 select * into first_row from luma_workflow_approval_result;
 select * into replay_row from luma_workflow_approval_replay;
 if not replay_row.idempotent_replay or replay_row.job_id is distinct from first_row.job_id
    or replay_row.budget_reservation_id is distinct from first_row.budget_reservation_id
    or replay_row.approval_id is distinct from first_row.approval_id
    or (select count(*) from executive_visuals.jobs where idempotency_key='pg-luma-workflow-001')<>1 then
  raise exception 'Luma workflow approval replay was not idempotent';
 end if;
end
$luma_workflow_replay_assertion$;

select 'Luma Ray 3.2 workflow quote, approval, budget and enqueue integration passed' as result;\ncommit;

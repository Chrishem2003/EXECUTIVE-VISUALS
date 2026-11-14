-- Disposable PostgreSQL acceptance for Gemini Omni workflow quote -> owner approval -> budget reservation -> enqueue.
-- Runs only after cloud-video-postgres-integration.sql and the Google Omni quote/approval migration.

set role service_role;
do $google_omni_workflow_integration$
declare
  owner_id constant uuid := '123e4567-e89b-42d3-a456-426614174000';
  project_id constant uuid := '323e4567-e89b-42d3-a456-426614174000';
  quote_id constant uuid := 'c23e4567-e89b-42d3-a456-426614174000';
  approval_id constant uuid := 'd23e4567-e89b-42d3-a456-426614174000';
  request_id constant text := 'google-omni-workflow-postgres-1';
  request_hash constant text := repeat('a',64);
  config_id constant text := 'google-gemini-omni-flash';
  request_input jsonb;
  approved record;
  replay record;
  job_row executive_visuals.jobs;
  reservation executive_visuals.video_generation_budget_reservations;
  policy executive_visuals.video_generation_budget_policies;
  approval executive_visuals.video_generation_budget_approvals;
begin
  insert into executive_visuals.video_workflow_quotes(
    id,owner_id,project_id,request_id,request_hash,provider,model,operation,
    routed_provider,routed_model,estimated_credits,estimated_amount,currency,
    config_id,pricing_source,expires_at
  ) values (
    quote_id,owner_id,project_id,request_id,request_hash,'google','gemini-omni-1.1-flash','generate',
    'google','gemini-omni-1.1-flash',1106496,2.586464,'USD',
    config_id,'google_gemini_omni_token_pricing_2026-11-05',clock_timestamp()+interval '5 minutes'
  );

  request_input:=jsonb_build_object(
    'projectId',project_id::text,'requestHash',request_hash,
    'provider','google','model','gemini-omni-1.1-flash','operation','generate',
    'prompt','A cinematic sunrise over Kampala','durationSeconds',5,
    'aspectRatio','16:9','resolution','720p','outputFormat','mp4',
    'rightsConfirmed',true,'workflowQuoteId',quote_id::text,'workflowRequestId',request_id
  );

  begin
    perform * from executive_visuals.approve_and_enqueue_video_workflow(
      quote_id,approval_id,owner_id,project_id,request_hash,config_id,request_id,
      request_input,2.50,'Deliberately below the Google Omni maximum reservation'
    );
    raise exception 'Google Omni workflow approval unexpectedly accepted a ceiling below the quote';
  exception when others then
    if sqlerrm <> 'VIDEO_WORKFLOW_APPROVAL_BELOW_QUOTE' then raise; end if;
  end;

  select * into approved from executive_visuals.approve_and_enqueue_video_workflow(
    quote_id,approval_id,owner_id,project_id,request_hash,config_id,request_id,
    request_input,2.70,'Approved Google Omni workflow maximum USD reservation'
  );
  if approved.job_id is null or approved.job_status<>'queued' or approved.idempotent_replay
     or approved.budget_reservation_id is null or approved.approval_id<>approval_id then
    raise exception 'Google Omni workflow approval returned an invalid first enqueue receipt';
  end if;

  select * into replay from executive_visuals.approve_and_enqueue_video_workflow(
    quote_id,'e23e4567-e89b-42d3-a456-426614174000',owner_id,project_id,request_hash,config_id,request_id,
    request_input,2.70,'Idempotent Google Omni workflow approval replay'
  );
  if replay.job_id<>approved.job_id or not replay.idempotent_replay
     or replay.budget_reservation_id<>approved.budget_reservation_id
     or replay.approval_id<>approved.approval_id then
    raise exception 'Google Omni workflow approval replay was not idempotent';
  end if;

  select * into job_row from executive_visuals.jobs where id=approved.job_id;
  select * into reservation from executive_visuals.video_generation_budget_reservations where job_id=approved.job_id;
  select * into approval from executive_visuals.video_generation_budget_approvals where id=approval_id;
  select * into policy from executive_visuals.video_generation_budget_policies
   where owner_id=owner_id and project_id=project_id and provider='google' and model='gemini-omni-1.1-flash';

  if job_row.status<>'queued' or job_row.owner_id<>owner_id or job_row.project_id<>project_id
     or job_row.input->>'provider'<>'google' or job_row.input->>'model'<>'gemini-omni-1.1-flash'
     or job_row.input->>'operation'<>'generate' or job_row.input->>'requestHash'<>request_hash
     or reservation.state<>'reserved' or reservation.provider<>'google'
     or reservation.model<>'gemini-omni-1.1-flash' or reservation.reserved_amount<>2.70
     or approval.consumed_at is null or approval.approved_max_amount<>2.70
     or policy.reserved_amount<>2.70 or policy.spent_amount<>0 then
    raise exception 'Google Omni workflow approval did not bind the quote, owner, provider, budget and job';
  end if;
end
$google_omni_workflow_integration$;
reset role;
select 'Google Omni workflow quote and approval integration checks passed' as result;

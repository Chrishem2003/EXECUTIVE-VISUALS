\set ON_ERROR_STOP on

-- Verify the additive worker-fencing migrations already applied by the CI job.
-- This disposable harness never targets shared staging or production.
do $generation_entitlement_fencing$
begin
  if not has_function_privilege('service_role','executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)','EXECUTE') then
    raise exception 'service_role cannot execute entitlement-gated credit reservation';
  end if;
  if has_function_privilege('anon','executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)','EXECUTE') then
    raise exception 'browser roles must not execute credit reservation';
  end if;
end
$generation_entitlement_fencing$;

update executive_visuals.customer_subscriptions
set entitlements_snapshot='{"ai_generation":false}'::jsonb
where owner_id='123e4567-e89b-42d3-a456-426614174000';

do $generation_entitlement_denied$
begin
  begin
    perform * from executive_visuals.reserve_generation_credits(
      '123e4567-e89b-42d3-a456-426614174000',
      'a23e4567-e89b-42d3-a456-426614174000',1,'missing-ai-entitlement-must-fail'
    );
    raise exception 'generation credit reservation unexpectedly succeeded without AI entitlement';
  exception when insufficient_privilege then
    if sqlerrm<>'VIDEO_GENERATION_ENTITLEMENT_REQUIRED' then raise; end if;
  end;
end
$generation_entitlement_denied$;

update executive_visuals.customer_subscriptions
set entitlements_snapshot='{"ai_generation":true,"video_generation":true}'::jsonb
where owner_id='123e4567-e89b-42d3-a456-426614174000';

do $video_fencing_privileges$
begin
  if has_function_privilege('service_role','executive_visuals.reserve_video_generation_task(uuid,integer,uuid,uuid,text,text,bigint)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.transition_video_generation_task(uuid,text[],text,text,text,text,numeric,text,jsonb,uuid)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.prepare_video_generation_submission(uuid,uuid,text,text,text)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.begin_video_generation_submission(uuid,text)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.record_video_generation_submission(uuid,text,text,jsonb)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.finish_video_generation_job(uuid,text,text,jsonb,jsonb,numeric)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.defer_video_generation_job(uuid,text,integer,text)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.quarantine_video_generation_job(uuid,text,text)','EXECUTE') then
    raise exception 'legacy unfenced video worker RPCs remain executable';
  end if;
  if not has_function_privilege('service_role','executive_visuals.reserve_video_generation_task_v2(uuid,text,uuid,uuid,integer,uuid,uuid,text,text,bigint)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.transition_video_generation_task_v2(uuid,text,uuid,uuid,text[],text,text,text,text,numeric,text,jsonb,uuid)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.prepare_video_generation_submission_v2(uuid,uuid,text,uuid,text,text,text)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.begin_video_generation_submission_v2(uuid,text,uuid)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.record_video_generation_submission_v2(uuid,text,uuid,text,jsonb)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.finish_video_generation_job_v2(uuid,text,uuid,text,jsonb,jsonb,numeric)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.defer_video_generation_job_v2(uuid,text,uuid,integer,text)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.quarantine_video_generation_job_v2(uuid,text,uuid,text)','EXECUTE') then
    raise exception 'service_role cannot execute the fenced video worker RPCs';
  end if;
end
$video_fencing_privileges$;

set role service_role;
do $video_fencing_behavior$
declare
  v_job_id uuid;
  first_claim executive_visuals.jobs;
  second_claim executive_visuals.jobs;
  recovered integer;
begin
  update executive_visuals.jobs set available_at=clock_timestamp()+interval '1 hour'
  where status='queued' and job_type='video.generate';
  insert into executive_visuals.jobs(
    owner_id,project_id,job_type,status,input,idempotency_key,max_attempts
  ) values (
    '123e4567-e89b-42d3-a456-426614174000',
    '323e4567-e89b-42d3-a456-426614174000',
    'video.generate','queued',
    jsonb_build_object(
      'provider','runway','model','gen4.5','requestHash',repeat('f',64),
      'projectId','323e4567-e89b-42d3-a456-426614174000'
    ),
    'video-worker-fencing-integration',3
  ) returning id into v_job_id;

  select * into first_claim
  from executive_visuals.claim_next_job_v2('video-worker-a',90,array['video.generate']);
  if first_claim.id is distinct from v_job_id or first_claim.lease_token is null then
    raise exception 'first video worker claim did not issue a database fencing token';
  end if;

  perform * from executive_visuals.prepare_video_generation_submission_v2(
    v_job_id,'123e4567-e89b-42d3-a456-426614174000','video-worker-a',first_claim.lease_token,
    'runway','gen4.5',repeat('f',64)
  );
  update executive_visuals.jobs
  set lease_expires_at=clock_timestamp()-interval '1 second'
  where id=v_job_id;
  recovered:=executive_visuals.recover_expired_video_generation_jobs(10);
  if recovered<>1 then raise exception 'expired prepared video job was not recovered'; end if;
  update executive_visuals.jobs set available_at=clock_timestamp() where id=v_job_id;

  if executive_visuals.begin_video_generation_submission_v2(
       v_job_id,'video-worker-a',first_claim.lease_token
     ) then
    raise exception 'stale worker began provider submission after recovery';
  end if;
  if executive_visuals.record_video_generation_submission_v2(
       v_job_id,'video-worker-a',first_claim.lease_token,'stale-task','{}'::jsonb
     ) then
    raise exception 'stale worker recorded a provider task after recovery';
  end if;
  if executive_visuals.finish_video_generation_job_v2(
       v_job_id,'video-worker-a',first_claim.lease_token,'failed',null,
       '{"code":"STALE_WORKER"}'::jsonb,null
     ) then
    raise exception 'stale worker finalized a reclaimed video job';
  end if;
  if executive_visuals.defer_video_generation_job_v2(
       v_job_id,'video-worker-a',first_claim.lease_token,30,'VIDEO_PROVIDER_POLL_DEFERRED'
     ) then
    raise exception 'stale worker deferred a reclaimed video job';
  end if;
  if executive_visuals.quarantine_video_generation_job_v2(
       v_job_id,'video-worker-a',first_claim.lease_token,'VIDEO_SUBMISSION_REQUIRES_RECONCILIATION'
     ) then
    raise exception 'stale worker quarantined a reclaimed video job';
  end if;

  select * into second_claim
  from executive_visuals.claim_next_job_v2('video-worker-b',90,array['video.generate']);
  if second_claim.id is distinct from v_job_id or second_claim.lease_token is null
     or second_claim.lease_token=first_claim.lease_token then
    raise exception 'retry did not receive a fresh video worker fencing token';
  end if;
  if not executive_visuals.begin_video_generation_submission_v2(
    v_job_id,'video-worker-b',second_claim.lease_token
  ) then
    raise exception 'new video worker could not begin its submission';
  end if;
  if not executive_visuals.record_video_generation_submission_v2(
    v_job_id,'video-worker-b',second_claim.lease_token,'fresh-task','{"attempt":2}'::jsonb
  ) then
    raise exception 'current video worker could not record its provider task';
  end if;
  if executive_visuals.record_video_generation_submission_v2(
       v_job_id,'video-worker-a',first_claim.lease_token,'stale-task','{}'::jsonb
     ) then
    raise exception 'old video worker token remained valid after reassignment';
  end if;
  if (select state from executive_visuals.video_generation_submissions where job_id=v_job_id)<>'submitted'
     or (select lease_token from executive_visuals.jobs where id=v_job_id) is distinct from second_claim.lease_token then
    raise exception 'current video worker submission or lease state was not preserved';
  end if;
end
$video_fencing_behavior$;
reset role;

select 'cloud video worker lease fencing PostgreSQL integration passed' as result;


-- The older approved-shot worker also uses the shared queue. Verify that its
-- separate shot ledger cannot be changed by a reclaimed worker attempt.
set role service_role;
do $approved_shot_fencing$
declare
  approval_id uuid:='a23e4567-e89b-42d3-a456-426614174000';
  job_id uuid;
  first_claim executive_visuals.jobs;
  second_claim executive_visuals.jobs;
  task_row executive_visuals.video_generation_tasks;
  recovered integer;
begin
  update executive_visuals.jobs set available_at=clock_timestamp()+interval '1 hour'
  where status='queued' and job_type='video.generate.shot';
  insert into executive_visuals.video_generation_approvals(
    id,owner_id,project_id,idempotency_key,request_hash,snapshot_json,
    currency,quoted_amount_micros,budget_ceiling_micros,status
  ) values (
    approval_id,'123e4567-e89b-42d3-a456-426614174000',
    '323e4567-e89b-42d3-a456-426614174000','shot-worker-fencing-key',
    repeat('e',64),
    '{"shots":[{"provider":"runway","model":"gen4.5","prompt":"fencing test","estimatedCostMicros":1000000}]}'::jsonb,
    'USD',1000000,1500000,'approved_pending_submission'
  );

  insert into executive_visuals.jobs(
    owner_id,project_id,job_type,status,input,idempotency_key,max_attempts
  ) values (
    '123e4567-e89b-42d3-a456-426614174000',
    '323e4567-e89b-42d3-a456-426614174000',
    'video.generate.shot','queued',
    jsonb_build_object('approvalId',approval_id::text,'shotIndex',0),
    'approved-shot-worker-fencing-integration',3
  ) returning id into job_id;

  select * into first_claim from executive_visuals.claim_next_job_v2(
    'shot-worker-a',90,array['video.generate.shot']
  );
  if first_claim.id is distinct from job_id or first_claim.lease_token is null then
    raise exception 'approved-shot first worker claim did not issue a fencing token';
  end if;

  select * into task_row from executive_visuals.reserve_video_generation_task_v2(
    job_id,'shot-worker-a',first_claim.lease_token,approval_id,0,
    '123e4567-e89b-42d3-a456-426614174000',
    '323e4567-e89b-42d3-a456-426614174000',
    repeat('e',64),'USD',1000000
  );
  if task_row.id is null or task_row.state<>'reserved' then
    raise exception 'approved-shot reservation did not persist';
  end if;

  update executive_visuals.jobs set lease_expires_at=clock_timestamp()-interval '1 second'
  where id=job_id;
  recovered:=executive_visuals.recover_expired_jobs(10);
  if recovered<>1 then raise exception 'approved-shot expired job was not recovered'; end if;
  update executive_visuals.jobs set available_at=clock_timestamp() where id=job_id;

  begin
    perform * from executive_visuals.transition_video_generation_task_v2(
      job_id,'shot-worker-a',first_claim.lease_token,task_row.id,
      array['reserved'],'submitting',null,null,null,null,null,null,null
    );
    raise exception 'stale approved-shot worker changed its task after recovery';
  exception when insufficient_privilege then
    if sqlerrm<>'VIDEO_WORKER_LEASE_LOST' then raise; end if;
  end;

  select * into second_claim from executive_visuals.claim_next_job_v2(
    'shot-worker-b',90,array['video.generate.shot']
  );
  if second_claim.id is distinct from job_id or second_claim.lease_token is null
     or second_claim.lease_token=first_claim.lease_token then
    raise exception 'approved-shot retry did not receive a fresh fencing token';
  end if;

  select * into task_row from executive_visuals.reserve_video_generation_task_v2(
    job_id,'shot-worker-b',second_claim.lease_token,approval_id,0,
    '123e4567-e89b-42d3-a456-426614174000',
    '323e4567-e89b-42d3-a456-426614174000',
    repeat('e',64),'USD',1000000
  );
  if not exists(
    select 1 from executive_visuals.transition_video_generation_task_v2(
      job_id,'shot-worker-b',second_claim.lease_token,task_row.id,
      array['reserved'],'submitting',null,null,null,null,null,null,null
    )
  ) then raise exception 'current approved-shot worker could not transition its task'; end if;

  begin
    perform * from executive_visuals.transition_video_generation_task_v2(
      job_id,'shot-worker-a',first_claim.lease_token,task_row.id,
      array['submitting'],'failed',null,null,null,null,null,'{"code":"STALE_WORKER"}'::jsonb,null
    );
    raise exception 'stale approved-shot worker overwrote the current task';
  exception when insufficient_privilege then
    if sqlerrm<>'VIDEO_WORKER_LEASE_LOST' then raise; end if;
  end;

  if not exists(
    select 1 from executive_visuals.transition_video_generation_task_v2(
      job_id,'shot-worker-b',second_claim.lease_token,task_row.id,
      array['submitting'],'submission_unknown',null,null,null,null,null,'{"code":"TEST_AMBIGUOUS"}'::jsonb,null
    )
  ) then raise exception 'current approved-shot worker could not persist its submission state'; end if;
  if (select state from executive_visuals.video_generation_tasks where id=task_row.id)<>'submission_unknown' then
    raise exception 'approved-shot current task state was not preserved';
  end if;
end
$approved_shot_fencing$;
reset role;

select 'approved-shot task lease fencing PostgreSQL integration passed' as result;

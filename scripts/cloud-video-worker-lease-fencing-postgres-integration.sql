\set ON_ERROR_STOP on

-- Verify the additive worker-fencing and atomic-publication migrations already applied
-- by the CI job. This disposable harness never targets shared staging or prod.
do $video_fencing_privileges$
begin
  if has_function_privilege('service_role','executive_visuals.prepare_video_generation_submission(uuid,uuid,text,text,text)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.begin_video_generation_submission(uuid,text)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.record_video_generation_submission(uuid,text,text,jsonb)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.finish_video_generation_job(uuid,text,text,jsonb,jsonb,numeric)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.defer_video_generation_job(uuid,text,integer,text)','EXECUTE')
     or has_function_privilege('service_role','executive_visuals.quarantine_video_generation_job(uuid,text,text)','EXECUTE') then
    raise exception 'legacy unfenced video worker RPCs remain executable';
  end if;
  if not has_function_privilege('service_role','executive_visuals.prepare_video_generation_submission_v2(uuid,uuid,text,uuid,text,text,text)','EXECUTE')
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

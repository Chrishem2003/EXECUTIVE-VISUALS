\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111')
on conflict(id) do nothing;

insert into executive_visuals.projects(id,owner_id,name) values
 ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Lease fencing integration')
on conflict(id) do nothing;

do $fencing_privileges$
begin
  if has_function_privilege('anon','executive_visuals.claim_next_job_v2(text,integer,text[])','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.claim_next_job_v2(text,integer,text[])','EXECUTE')
     or has_function_privilege('anon','executive_visuals.renew_job_lease_v2(uuid,text,uuid,integer)','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)','EXECUTE') then
    raise exception 'browser roles must not execute fenced worker RPCs';
  end if;
  if not has_function_privilege('service_role','executive_visuals.claim_next_job_v2(text,integer,text[])','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.renew_job_lease_v2(uuid,text,uuid,integer)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.assert_job_lease_v2(uuid,text,uuid)','EXECUTE') then
    raise exception 'service_role must execute all fenced worker RPCs';
  end if;
  if (to_regprocedure('executive_visuals.claim_next_job(text,integer,text[])') is not null
      and has_function_privilege('service_role','executive_visuals.claim_next_job(text,integer,text[])','EXECUTE'))
     or (to_regprocedure('executive_visuals.renew_job_lease(uuid,text,integer)') is not null
      and has_function_privilege('service_role','executive_visuals.renew_job_lease(uuid,text,integer)','EXECUTE'))
     or (to_regprocedure('executive_visuals.finish_job(uuid,text,text,jsonb,jsonb)') is not null
      and has_function_privilege('service_role','executive_visuals.finish_job(uuid,text,text,jsonb,jsonb)','EXECUTE')) then
    raise exception 'legacy unfenced worker RPCs must be disabled';
  end if;
end
$fencing_privileges$;

set role service_role;
do $fencing_behavior$
declare
  v_job executive_visuals.jobs;
  v_first_token uuid;
  v_second_token uuid;
  v_recovered integer;
begin
  insert into executive_visuals.jobs(owner_id,project_id,job_type,status,input,max_attempts)
  values ('11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'media.color','queued','{"sourceAssetId":"asset-source"}'::jsonb,3)
  returning * into v_job;

  select * into v_job from executive_visuals.claim_next_job_v2('worker-a',90,array['media.color']);
  if v_job.id is null or v_job.status<>'processing' or v_job.lease_owner<>'worker-a' or v_job.lease_token is null then
    raise exception 'first claim did not issue a database fencing token';
  end if;
  v_first_token:=v_job.lease_token;
  if not executive_visuals.assert_job_lease_v2(v_job.id,'worker-a',v_first_token) then
    raise exception 'current claim token was not accepted';
  end if;
  if not executive_visuals.renew_job_lease_v2(v_job.id,'worker-a',v_first_token,90) then
    raise exception 'current claim token could not renew its lease';
  end if;

  update executive_visuals.jobs
  set lease_expires_at=clock_timestamp()-interval '1 second'
  where id=v_job.id;
  v_recovered:=executive_visuals.recover_expired_jobs(10);
  if v_recovered<>1 then raise exception 'expired job was not recovered'; end if;
  update executive_visuals.jobs set available_at=clock_timestamp() where id=v_job.id;
  if executive_visuals.assert_job_lease_v2(v_job.id,'worker-a',v_first_token) then
    raise exception 'recovered worker token remained valid';
  end if;
  if (select lease_token from executive_visuals.jobs where id=v_job.id) is not null then
    raise exception 'recovery did not clear the expired fencing token';
  end if;

  select * into v_job from executive_visuals.claim_next_job_v2('worker-b',90,array['media.color']);
  v_second_token:=v_job.lease_token;
  if v_job.id is null or v_second_token is null or v_second_token=v_first_token then
    raise exception 'retry did not issue a fresh fencing token';
  end if;
  if executive_visuals.finish_job_v2(v_job.id,'worker-a',v_first_token,'succeeded','{}'::jsonb,null) then
    raise exception 'stale worker completed a reclaimed job';
  end if;
  if not executive_visuals.assert_job_lease_v2(v_job.id,'worker-b',v_second_token) then
    raise exception 'new worker lease was not active';
  end if;
  if not executive_visuals.finish_job_v2(v_job.id,'worker-b',v_second_token,'succeeded','{"assetId":"asset-output"}'::jsonb,null) then
    raise exception 'current worker could not complete its job';
  end if;
  if executive_visuals.finish_job_v2(v_job.id,'worker-b',v_second_token,'succeeded','{}'::jsonb,null) then
    raise exception 'terminal completion was replayed';
  end if;
  if (select status from executive_visuals.jobs where id=v_job.id)<>'succeeded'
     or (select lease_token from executive_visuals.jobs where id=v_job.id) is not null then
    raise exception 'completion did not atomically clear the active lease';
  end if;
end
$fencing_behavior$;
reset role;

select 'job lease fencing PostgreSQL integration passed' as result;

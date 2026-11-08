\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('44444444-4444-4444-8444-444444444444')
on conflict(id) do nothing;

insert into executive_visuals.projects(id,owner_id,name) values
 ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Atomic publication'),
 ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','Foreign project')
on conflict(id) do nothing;

insert into executive_visuals.assets(
 id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata
) values
 ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222','source.mp4','video/mp4',4,repeat('b',64),
  'executive-visuals-media','22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/original.mp4',null,'{}'),
 ('66666666-6666-4666-8666-666666666666','44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555','foreign.mp4','video/mp4',4,repeat('c',64),
  'executive-visuals-media','55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666/original.mp4',null,'{}')
on conflict(id) do nothing;

do $atomic_publication_privileges$
begin
 if has_function_privilege('anon','executive_visuals.reserve_asset_publication_v2(uuid,text,uuid,uuid,uuid,text,text,uuid)','EXECUTE')
    or has_function_privilege('authenticated','executive_visuals.finalize_asset_publication_v1(uuid,text,uuid,uuid,uuid,text,text,uuid,text,text,bigint,text,text,uuid,jsonb)','EXECUTE')
    or has_function_privilege('anon','executive_visuals.claim_asset_publication_cleanup_v1(uuid,uuid,uuid,text,text,interval)','EXECUTE') then
  raise exception 'browser roles must not execute publication or cleanup RPCs';
 end if;
 if not has_function_privilege('service_role','executive_visuals.reserve_asset_publication_v2(uuid,text,uuid,uuid,uuid,text,text,uuid)','EXECUTE')
    or not has_function_privilege('service_role','executive_visuals.finalize_asset_publication_v1(uuid,text,uuid,uuid,uuid,text,text,uuid,text,text,bigint,text,text,uuid,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','executive_visuals.claim_asset_publication_cleanup_v1(uuid,uuid,uuid,text,text,interval)','EXECUTE')
    or not has_function_privilege('service_role','executive_visuals.complete_asset_publication_cleanup_v1(uuid,uuid)','EXECUTE') then
  raise exception 'service_role must execute publication and cleanup RPCs';
 end if;
end
$atomic_publication_privileges$;

set role service_role;
insert into executive_visuals.asset_storage_cleanup(storage_bucket,object_path,reason)
values('executive-visuals-media','22222222-2222-4222-8222-222222222222/77777777-7777-4777-8777-777777777777/attempt-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4','attempt_compensation_test');
do $atomic_publication_behavior$
declare
 v_job executive_visuals.jobs;
 v_reservation executive_visuals.asset_publications;
 v_asset executive_visuals.assets;
 v_replayed executive_visuals.assets;
 v_token uuid;
 v_claim record;
 v_path text := '22222222-2222-4222-8222-222222222222/77777777-7777-4777-8777-777777777777/attempt-88888888-8888-4888-8888-888888888888.mp4';
begin
 insert into executive_visuals.jobs(owner_id,project_id,job_type,status,input,max_attempts)
 values ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
         'timeline.render','queued','{"timelineId":"33333333-3333-4333-8333-333333333333"}'::jsonb,3)
 returning * into v_job;

 select * into v_job from executive_visuals.claim_next_job_v2('publisher-a',90,array['timeline.render']);
 if v_job.id is null or v_job.lease_token is null then raise exception 'publication job did not receive a lease token'; end if;
 v_token:=v_job.lease_token;

 select * into v_reservation from executive_visuals.reserve_asset_publication_v2(
  v_job.id,'publisher-a',v_token,v_job.owner_id,v_job.project_id,
  'job-atomic:output:v1',repeat('a',64),'77777777-7777-4777-8777-777777777777'
 );
 if v_reservation.job_id is distinct from v_job.id or v_reservation.status<>'reserved' then
  raise exception 'reservation did not bind to the claimed job';
 end if;

 select * into v_asset from executive_visuals.finalize_asset_publication_v1(
  v_job.id,'publisher-a',v_token,v_job.owner_id,v_job.project_id,
  'job-atomic:output:v1',repeat('a',64),'77777777-7777-4777-8777-777777777777',
  'render.mp4','video/mp4',4,'executive-visuals-media',v_path,
  '33333333-3333-4333-8333-333333333333','{"operation":"timeline.render"}'::jsonb
 );
 if v_asset.id is distinct from '77777777-7777-4777-8777-777777777777'::uuid
    or v_asset.derivative_of is distinct from '33333333-3333-4333-8333-333333333333'::uuid
    or v_asset.object_path is distinct from v_path then
  raise exception 'atomic publication did not persist the expected derivative identity';
 end if;
 if (select status from executive_visuals.asset_publications where id=v_reservation.id)<>'published' then
  raise exception 'asset and publication ledger were not finalized together';
 end if;

 select * into v_replayed from executive_visuals.finalize_asset_publication_v1(
  v_job.id,'publisher-a',v_token,v_job.owner_id,v_job.project_id,
  'job-atomic:output:v1',repeat('a',64),'77777777-7777-4777-8777-777777777777',
  'render.mp4','video/mp4',4,'executive-visuals-media',v_path,
  '33333333-3333-4333-8333-333333333333','{"operation":"timeline.render"}'::jsonb
 );
 if v_replayed.id is distinct from v_asset.id then raise exception 'publication replay changed the asset identity'; end if;

 begin
  insert into executive_visuals.assets(
   id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata
  ) values (
   '99999999-9999-4999-8999-999999999999','11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222','foreign-parent-derivative.mp4','video/mp4',4,repeat('d',64),
   'executive-visuals-media','22222222-2222-4222-8222-222222222222/99999999-9999-4999-8999-999999999999/original.mp4',
   '66666666-6666-4666-8666-666666666666','{}'
  );
  raise exception using errcode='P9999',message='cross-project derivative was accepted';
 exception when check_violation then null;
 end;

 update executive_visuals.jobs
 set status='failed',completed_at=clock_timestamp(),lease_owner=null,lease_token=null,
     lease_expires_at=null,lease_heartbeat_at=null
 where id=v_job.id;
 update executive_visuals.asset_publications
 set updated_at=clock_timestamp()-interval '25 hours'
 where id=v_reservation.id;

 select * into v_claim from executive_visuals.claim_asset_publication_cleanup_v1(
  v_job.id,v_job.owner_id,v_job.project_id,'job-atomic:output:v1',
  '22222222-2222-4222-8222-222222222222/77777777-7777-4777-8777-777777777777/attempt-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
  interval '24 hours'
 );
 if v_claim.claim_id is null or v_claim.claim_token is null or v_claim.status<>'claimed' then
  raise exception 'orphan cleanup path was not durably fenced';
 end if;
 if not executive_visuals.complete_asset_publication_cleanup_v1(v_claim.claim_id,v_claim.claim_token) then
  raise exception 'cleanup claim could not be completed';
 end if;
 if not executive_visuals.complete_asset_publication_cleanup_v1(v_claim.claim_id,v_claim.claim_token) then
  raise exception 'cleanup completion replay was not idempotent';
 end if;

 begin
  perform * from executive_visuals.claim_asset_publication_cleanup_v1(
   v_job.id,v_job.owner_id,v_job.project_id,'job-atomic:output:v1',v_path,interval '24 hours'
  );
  raise exception using errcode='P9999',message='referenced asset object was eligible for orphan cleanup';
 exception when sqlstate '55000' then
  if sqlerrm<>'referenced asset objects cannot be claimed for cleanup' then raise; end if;
 end;
end
$atomic_publication_behavior$;
reset role;

select 'atomic asset publication PostgreSQL integration passed' as result;

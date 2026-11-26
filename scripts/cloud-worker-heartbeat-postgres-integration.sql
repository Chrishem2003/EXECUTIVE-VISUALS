\set ON_ERROR_STOP on
set role service_role;
select executive_visuals.record_cloud_worker_heartbeat(
 'integration-worker-001',array['media','storage_maintenance'],'starting',null,null
);
select executive_visuals.record_cloud_worker_heartbeat(
 'integration-worker-001',array['media','storage_maintenance'],'healthy',now(),null
);
select executive_visuals.record_cloud_worker_heartbeat(
 'integration-worker-001',array['media','storage_maintenance'],'degraded',now(),'QUEUE_RENEW_FAILED'
);
reset role;
do $heartbeat_assertions$
declare v_status text; v_code text; v_families text[];
begin
 select status,last_error_code,worker_families into v_status,v_code,v_families
 from executive_visuals.cloud_worker_heartbeats where worker_id='integration-worker-001';
 if v_status<>'degraded' or v_code<>'QUEUE_RENEW_FAILED' then raise exception 'latest worker heartbeat state was not persisted'; end if;
 if v_families<>array['media','storage_maintenance'] then raise exception 'worker family attribution mismatch'; end if;
 if has_table_privilege('service_role','executive_visuals.cloud_worker_heartbeats','SELECT') then
  raise exception 'service role must not read heartbeat table directly';
 end if;
 if has_function_privilege('anon',
  'executive_visuals.record_cloud_worker_heartbeat(text,text[],text,timestamptz,text)','EXECUTE') then
  raise exception 'anonymous role must not write worker heartbeats';
 end if;
end
$heartbeat_assertions$;
select 'cloud worker heartbeat integration passed' as result;

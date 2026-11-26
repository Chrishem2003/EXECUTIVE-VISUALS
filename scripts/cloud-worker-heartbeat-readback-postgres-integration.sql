\set ON_ERROR_STOP on
set role service_role;
select executive_visuals.record_cloud_worker_heartbeat(
 'integration-worker-readback',array['storage_maintenance'],'healthy',now(),null
);
do $heartbeat_readback$
declare v_row jsonb;
begin
 v_row:=executive_visuals.read_cloud_worker_heartbeat('integration-worker-readback');
 if v_row->>'workerId'<>'integration-worker-readback'
   or v_row->>'status'<>'healthy'
   or v_row->'workerFamilies' is null
   or v_row->>'heartbeatAt' is null then
  raise exception 'service-role heartbeat readback did not return the expected liveness fields';
 end if;
 if executive_visuals.read_cloud_worker_heartbeat('missing-worker') is not null then
  raise exception 'missing worker readback must return null';
 end if;
 if has_function_privilege('anon',
   'executive_visuals.read_cloud_worker_heartbeat(text)','EXECUTE') then
  raise exception 'anonymous role must not read worker heartbeat records';
 end if;
 if has_function_privilege('authenticated',
   'executive_visuals.read_cloud_worker_heartbeat(text)','EXECUTE') then
  raise exception 'authenticated role must not read worker heartbeat records';
 end if;
end
$heartbeat_readback$;
reset role;
select 'cloud worker heartbeat readback integration passed' as result;

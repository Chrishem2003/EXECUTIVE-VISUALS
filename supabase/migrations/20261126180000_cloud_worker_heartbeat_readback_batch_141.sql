-- Batch 141: service-role-only readback for worker liveness acceptance and monitoring.
-- The heartbeat table remains inaccessible directly, including to service_role.

create or replace function executive_visuals.read_cloud_worker_heartbeat(
 p_worker_id text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
set row_security=off
as $worker_heartbeat_read$
declare
 v_row executive_visuals.cloud_worker_heartbeats%rowtype;
begin
 if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then
  raise exception 'Invalid cloud worker heartbeat identity' using errcode='22023';
 end if;
 select * into v_row from executive_visuals.cloud_worker_heartbeats
  where worker_id=p_worker_id;
 if not found then return null; end if;
 return jsonb_build_object(
  'workerId',v_row.worker_id,
  'workerFamilies',v_row.worker_families,
  'status',v_row.status,
  'heartbeatAt',v_row.heartbeat_at,
  'lastCycleAt',v_row.last_cycle_at,
  'lastErrorCode',v_row.last_error_code
 );
end;
$worker_heartbeat_read$;

revoke all on function executive_visuals.read_cloud_worker_heartbeat(text)
 from public,anon,authenticated;
grant execute on function executive_visuals.read_cloud_worker_heartbeat(text)
 to service_role;
comment on function executive_visuals.read_cloud_worker_heartbeat(text) is
 'Returns non-secret liveness metadata for one worker; service_role only, table access remains revoked.';

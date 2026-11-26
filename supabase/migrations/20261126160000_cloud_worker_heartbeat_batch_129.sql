-- Batch 129: durable process-level heartbeat for separately deployed cloud workers.
create table if not exists executive_visuals.cloud_worker_heartbeats (
 worker_id text primary key check (char_length(worker_id) between 1 and 128),
 worker_families text[] not null check (cardinality(worker_families) between 1 and 8),
 status text not null check (status in ('starting','healthy','degraded','stopping','stopped')),
 heartbeat_at timestamptz not null default now(),
 last_cycle_at timestamptz,
 last_error_code text check (last_error_code is null or char_length(last_error_code)<=80),
 updated_at timestamptz not null default now()
);
create index if not exists cloud_worker_heartbeats_status_time_idx
 on executive_visuals.cloud_worker_heartbeats(status,heartbeat_at desc);
alter table executive_visuals.cloud_worker_heartbeats enable row level security;
alter table executive_visuals.cloud_worker_heartbeats force row level security;
revoke all on table executive_visuals.cloud_worker_heartbeats from public,anon,authenticated,service_role;

create or replace function executive_visuals.record_cloud_worker_heartbeat(
 p_worker_id text,p_worker_families text[],p_status text,
 p_last_cycle_at timestamptz default null,p_last_error_code text default null
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
set row_security=off
as $worker_heartbeat$
declare v_now timestamptz:=clock_timestamp();
begin
 if coalesce(length(p_worker_id),0) not between 1 and 128
   or p_worker_families is null or cardinality(p_worker_families) not between 1 and 8
   or p_status not in ('starting','healthy','degraded','stopping','stopped')
   or (p_last_cycle_at is not null and p_last_cycle_at>v_now+interval '5 minutes')
   or (p_last_error_code is not null and (length(p_last_error_code)>80 or p_last_error_code !~ '^[A-Z0-9_]+$')) then
  raise exception 'Invalid cloud worker heartbeat' using errcode='22023';
 end if;
 if exists(select 1 from unnest(p_worker_families) f where f not in
   ('media','timeline','video','publication_cleanup','gemini_files_cleanup','gemini_files_recovery','b2_multipart_cleanup','storage_maintenance')) then
  raise exception 'Unsupported cloud worker family' using errcode='22023';
 end if;
 if cardinality(array(select distinct f from unnest(p_worker_families) f))<>cardinality(p_worker_families) then
  raise exception 'Duplicate cloud worker family' using errcode='22023';
 end if;
 insert into executive_visuals.cloud_worker_heartbeats(
  worker_id,worker_families,status,heartbeat_at,last_cycle_at,last_error_code,updated_at
 ) values(p_worker_id,p_worker_families,p_status,v_now,p_last_cycle_at,p_last_error_code,v_now)
 on conflict(worker_id) do update set
  worker_families=excluded.worker_families,status=excluded.status,heartbeat_at=excluded.heartbeat_at,
  last_cycle_at=coalesce(excluded.last_cycle_at,executive_visuals.cloud_worker_heartbeats.last_cycle_at),
  last_error_code=excluded.last_error_code,updated_at=excluded.updated_at;
 return jsonb_build_object('workerId',p_worker_id,'status',p_status,'heartbeatAt',v_now);
end;
$worker_heartbeat$;
revoke all on function executive_visuals.record_cloud_worker_heartbeat(text,text[],text,timestamptz,text)
 from public,anon,authenticated;
grant execute on function executive_visuals.record_cloud_worker_heartbeat(text,text[],text,timestamptz,text)
 to service_role;
comment on table executive_visuals.cloud_worker_heartbeats is
 'Latest durable heartbeat per separately deployed worker process; no customer media or credentials are stored.';

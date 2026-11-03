-- Durable process-level worker heartbeats. This is operational metadata only;
-- it intentionally contains no credentials, user content, or job payloads.
create table if not exists executive_visuals.worker_heartbeats (
  worker_id text primary key check (char_length(worker_id) between 1 and 128),
  worker_family text not null check (char_length(worker_family) between 1 and 64),
  instance_id text not null check (char_length(instance_id) between 1 and 128),
  status text not null check (status in ('running','stopping','stopped','error')),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics)='object'),
  started_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  stopped_at timestamptz
);

create index if not exists worker_heartbeats_last_seen_idx
  on executive_visuals.worker_heartbeats(last_seen_at desc);

alter table executive_visuals.worker_heartbeats enable row level security;
revoke all on table executive_visuals.worker_heartbeats from public, anon, authenticated;
grant select,insert,update on table executive_visuals.worker_heartbeats to service_role;

create or replace function executive_visuals.heartbeat_worker(
  p_worker_id text,
  p_worker_family text,
  p_instance_id text,
  p_status text default 'running',
  p_metrics jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  seen_at timestamptz;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
    or p_worker_family is null or char_length(btrim(p_worker_family)) not between 1 and 64
    or p_instance_id is null or char_length(btrim(p_instance_id)) not between 1 and 128
    or p_status is null or p_status not in ('running','stopping','stopped','error')
    or p_metrics is null or jsonb_typeof(p_metrics) <> 'object'
    or octet_length(p_metrics::text) > 4000 then
    raise exception 'invalid worker heartbeat';
  end if;

  if (p_metrics - array[
    'cycles','jobsClaimed','recoveredJobs','cycleErrors','recoveryErrors',
    'lastCycleAt','lastRecoveryAt','lastErrorAt','lastErrorCode',
    'activeCycle','recoveryInProgress','workerFamilies'
  ]) <> '{}'::jsonb then
    raise exception 'worker heartbeat contains unsupported metrics';
  end if;

  insert into executive_visuals.worker_heartbeats(
    worker_id,worker_family,instance_id,status,metrics,started_at,last_seen_at,stopped_at
  ) values (
    p_worker_id,p_worker_family,p_instance_id,p_status,p_metrics,
    clock_timestamp(),clock_timestamp(),
    case when p_status='stopped' then clock_timestamp() else null end
  )
  on conflict(worker_id) do update set
    worker_family=excluded.worker_family,
    instance_id=excluded.instance_id,
    status=excluded.status,
    metrics=excluded.metrics,
    last_seen_at=clock_timestamp(),
    stopped_at=case when excluded.status='stopped' then clock_timestamp() else null end
  returning last_seen_at into seen_at;

  return jsonb_build_object('accepted',true,'lastSeenAt',seen_at);
end;
$$;

revoke all on function executive_visuals.heartbeat_worker(text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function executive_visuals.heartbeat_worker(text,text,text,text,jsonb) to service_role;

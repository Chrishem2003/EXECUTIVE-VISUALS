-- Read-only worker fleet snapshot for trusted server-side operations tooling.
-- Staleness is derived at query time; the heartbeat writer never self-certifies health.
create or replace function executive_visuals.list_worker_health(
  p_stale_after_seconds integer default 180,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  result jsonb;
begin
  if p_stale_after_seconds is null or p_stale_after_seconds not between 30 and 3600
    or p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid worker health query bounds';
  end if;

  select coalesce(jsonb_agg(to_jsonb(snapshot_row) order by snapshot_row.last_seen_at desc),'[]'::jsonb)
  into result
  from (
    select
      worker_id,
      worker_family,
      instance_id,
      case
        when status in ('running','stopping')
          and last_seen_at < clock_timestamp() - make_interval(secs => p_stale_after_seconds)
          then 'stale'
        else status
      end as status,
      metrics,
      started_at,
      last_seen_at,
      stopped_at,
      greatest(0,floor(extract(epoch from (clock_timestamp()-last_seen_at))))::integer as age_seconds
    from executive_visuals.worker_heartbeats
    order by last_seen_at desc
    limit p_limit
  ) as snapshot_row;

  return result;
end;
$$;

revoke all on function executive_visuals.list_worker_health(integer,integer) from public, anon, authenticated;
grant execute on function executive_visuals.list_worker_health(integer,integer) to service_role;

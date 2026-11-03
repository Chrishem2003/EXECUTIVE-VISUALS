-- Aggregate-only cleanup visibility for the explicitly allowlisted operations plane.
-- Do not return asset IDs, owners, projects, storage paths or media metadata.
create or replace function executive_visuals.list_asset_cleanup_diagnostics()
returns jsonb
language sql
security definer
set search_path = pg_catalog, executive_visuals
as $$
  with pending as (
    select deleted_at
    from executive_visuals.assets
    where deleted_at is not null
      and storage_cleanup_status='pending'
  )
  select jsonb_build_object(
    'pending_count',count(*)::integer,
    'pending_over_24_hours',count(*) filter (where deleted_at <= clock_timestamp()-interval '24 hours')::integer,
    'pending_over_7_days',count(*) filter (where deleted_at <= clock_timestamp()-interval '7 days')::integer,
    'oldest_pending_at',min(deleted_at),
    'oldest_pending_age_seconds',coalesce(
      greatest(0,floor(extract(epoch from (clock_timestamp()-min(deleted_at)))))::integer,
      0
    )
  )
  from pending;
$$;

revoke all on function executive_visuals.list_asset_cleanup_diagnostics() from public, anon, authenticated;
grant execute on function executive_visuals.list_asset_cleanup_diagnostics() to service_role;

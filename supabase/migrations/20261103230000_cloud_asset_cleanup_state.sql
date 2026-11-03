-- Track object-store deletion independently from asset metadata deletion.
-- Existing soft-deleted rows are treated as pending because older versions did
-- not persist whether the corresponding storage object was actually removed.
alter table executive_visuals.assets
  add column if not exists storage_cleanup_status text not null default 'not_required'
  check (storage_cleanup_status in ('not_required','pending','complete'));

update executive_visuals.assets
set storage_cleanup_status='pending'
where deleted_at is not null
  and storage_cleanup_status='not_required';

create index if not exists ev_assets_pending_storage_cleanup
  on executive_visuals.assets(deleted_at,created_at)
  where deleted_at is not null and storage_cleanup_status='pending';

comment on column executive_visuals.assets.storage_cleanup_status is
  'Tracks private object deletion separately from soft deletion: not_required for active assets, pending until storage removal is confirmed, complete after confirmation.';

-- Aggregate-only cleanup visibility for the trusted operations plane.
-- No asset IDs, owners, project IDs, object paths or filenames are returned.
create or replace function executive_visuals.list_asset_cleanup_diagnostics()
returns jsonb
language sql
security definer
set search_path = pg_catalog, executive_visuals
as $$
  select jsonb_build_object(
    'pending_count',count(*)::integer,
    'pending_over_24_hours',count(*) filter (where deleted_at < clock_timestamp()-interval '24 hours')::integer,
    'pending_over_7_days',count(*) filter (where deleted_at < clock_timestamp()-interval '7 days')::integer,
    'oldest_pending_at',min(deleted_at),
    'oldest_pending_age_seconds',coalesce(greatest(0,floor(extract(epoch from (clock_timestamp()-min(deleted_at)))))::integer,0)
  )
  from executive_visuals.assets
  where deleted_at is not null and storage_cleanup_status='pending';
$$;

revoke all on function executive_visuals.list_asset_cleanup_diagnostics() from public, anon, authenticated;
grant execute on function executive_visuals.list_asset_cleanup_diagnostics() to service_role;

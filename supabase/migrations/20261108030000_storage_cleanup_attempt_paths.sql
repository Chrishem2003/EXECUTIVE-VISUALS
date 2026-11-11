-- Extend the durable compensation outbox to accept immutable per-attempt objects.
-- Preserve the original path allowlist exactly; no existing cleanup records are deleted.
alter table executive_visuals.asset_storage_cleanup
  drop constraint if exists asset_storage_cleanup_object_path_check;

alter table executive_visuals.asset_storage_cleanup
  drop constraint if exists asset_storage_cleanup_check;

alter table executive_visuals.asset_storage_cleanup
  drop constraint if exists asset_storage_cleanup_check1;

alter table executive_visuals.asset_storage_cleanup
  add constraint ev_asset_storage_cleanup_object_path_check
  check (
    object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/original\.[a-z0-9]{1,8}$'
    or
    object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,8}$'
  );

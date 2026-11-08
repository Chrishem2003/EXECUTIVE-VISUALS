-- Allow the durable compensation outbox to track unique immutable publication attempts.
-- This does not delete objects or rewrite existing cleanup records.
alter table executive_visuals.asset_storage_cleanup
  drop constraint if exists asset_storage_cleanup_object_path_check;

alter table executive_visuals.asset_storage_cleanup
  drop constraint if exists asset_storage_cleanup_check;

alter table executive_visuals.asset_storage_cleanup
  add constraint ev_asset_storage_cleanup_object_path_check
  check (
    object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}/(original|attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[a-z0-9]{1,8}$'
  );

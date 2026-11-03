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

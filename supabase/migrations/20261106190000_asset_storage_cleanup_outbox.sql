-- Durable retry queue for storage objects whose compensating delete failed.
-- This migration is additive and does not modify existing asset or job rows.
create table if not exists executive_visuals.asset_storage_cleanup (
  id uuid primary key default gen_random_uuid(),
  storage_bucket text not null check (storage_bucket = 'executive-visuals-media'),
  object_path text not null unique,
  reason text not null default 'asset_metadata_persistence_failed'
    check (char_length(reason) between 1 and 100),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/original\.[a-z0-9]{1,8}$'
  )
);

create index if not exists ev_asset_storage_cleanup_pending
  on executive_visuals.asset_storage_cleanup(next_attempt_at, created_at)
  where completed_at is null;

alter table executive_visuals.asset_storage_cleanup enable row level security;
revoke all on executive_visuals.asset_storage_cleanup from public, anon, authenticated;
grant select, insert, update on executive_visuals.asset_storage_cleanup to service_role;

comment on table executive_visuals.asset_storage_cleanup is
  'Service-role-only durable outbox for retrying exact private storage object deletions after failed asset publication compensation.';

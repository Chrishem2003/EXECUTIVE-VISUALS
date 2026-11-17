-- Durable, tenant-scoped checkpoints for B2 S3 multipart uploads.
-- The upload ID and object key are server-only; browser clients never query this ledger.
create table if not exists executive_visuals.asset_multipart_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  asset_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  storage_provider text not null check (storage_provider = 'backblaze-b2'),
  storage_bucket text not null check (storage_bucket = 'executive-visuals-media'),
  object_path text not null,
  upload_id text not null check (char_length(upload_id) between 8 and 512),
  original_name text not null check (char_length(original_name) between 1 and 180),
  media_type text not null check (char_length(media_type) between 1 and 128),
  byte_size bigint not null check (byte_size > 0),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  part_size bigint not null check (part_size between 5000000 and 5368709120),
  part_count integer not null check (part_count between 1 and 10000),
  status text not null default 'active'
    check (status in ('active','completing','completed','aborted','expired','failed')),
  expires_at timestamptz not null,
  completion_claimed_at timestamptz,
  completed_at timestamptz,
  aborted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,idempotency_key),
  unique(storage_bucket,object_path,upload_id),
  check (object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,180}$')
);

create index if not exists ev_multipart_sessions_owner_active
  on executive_visuals.asset_multipart_upload_sessions(owner_id,updated_at desc)
  where status in ('active','completing');
create index if not exists ev_multipart_sessions_expiry
  on executive_visuals.asset_multipart_upload_sessions(expires_at)
  where status in ('active','completing');

create table if not exists executive_visuals.asset_multipart_upload_parts (
  session_id uuid not null references executive_visuals.asset_multipart_upload_sessions(id) on delete cascade,
  part_number integer not null check (part_number between 1 and 10000),
  etag text not null check (char_length(etag) between 8 and 128),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0),
  recorded_at timestamptz not null default now(),
  primary key(session_id,part_number)
);

create index if not exists ev_multipart_parts_session
  on executive_visuals.asset_multipart_upload_parts(session_id,part_number);

alter table executive_visuals.asset_multipart_upload_sessions enable row level security;
alter table executive_visuals.asset_multipart_upload_parts enable row level security;
revoke all on executive_visuals.asset_multipart_upload_sessions from public, anon, authenticated;
revoke all on executive_visuals.asset_multipart_upload_parts from public, anon, authenticated;
grant select,insert,update,delete on executive_visuals.asset_multipart_upload_sessions to service_role;
grant select,insert,update,delete on executive_visuals.asset_multipart_upload_parts to service_role;

comment on table executive_visuals.asset_multipart_upload_sessions is
  'Service-role-only owner-scoped B2 multipart upload ledger. Never expose B2 upload IDs or object paths to untrusted clients.';
comment on table executive_visuals.asset_multipart_upload_parts is
  'Idempotent per-part checksum and ETag checkpoints for restart-safe B2 multipart upload recovery.';

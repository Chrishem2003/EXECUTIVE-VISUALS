-- Durable private Google Drive export-attempt ledger.
-- Source-controlled only: apply to an isolated staging database after review.
create table if not exists executive_visuals.google_drive_export_attempts (
  id uuid primary key default gen_random_uuid(),
  attempt_key text not null unique check (attempt_key ~ '^[a-f0-9]{64}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  asset_id uuid not null references executive_visuals.assets(id) on delete cascade,
  parent_folder_id text,
  drive_file_id text not null unique,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 262144000),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  encrypted_session_uri text,
  lease_token uuid,
  lease_expires_at timestamptz,
  state text not null check (state in ('PREPARED','UPLOADING','OUTCOME_UNKNOWN','COMPLETED','RECONCILIATION_REQUIRED','FAILED')),
  drive_web_view_link text,
  last_error_code text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists google_drive_export_attempts_recovery_idx
  on executive_visuals.google_drive_export_attempts (state, updated_at)
  where state in ('UPLOADING','OUTCOME_UNKNOWN','RECONCILIATION_REQUIRED');
alter table executive_visuals.google_drive_export_attempts enable row level security;
alter table executive_visuals.google_drive_export_attempts force row level security;
revoke all on table executive_visuals.google_drive_export_attempts from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update on table executive_visuals.google_drive_export_attempts to service_role;

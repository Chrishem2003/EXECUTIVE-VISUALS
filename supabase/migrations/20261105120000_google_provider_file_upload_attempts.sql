-- Durable, private Gemini Files upload-attempt ledger.
-- Source-controlled only; apply only to an isolated staging database after review.

create table if not exists executive_visuals.google_provider_file_upload_attempts (
  id uuid primary key default gen_random_uuid(),
  attempt_key text not null unique check (attempt_key ~ '^[a-f0-9]{64}$'),
  asset_id uuid not null references executive_visuals.assets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 2147483648),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  google_display_name text not null unique,
  state text not null check (state in ('PREPARED','UPLOADING','OUTCOME_UNKNOWN','PROVIDER_CREATED','COMPLETED','FAILED','QUARANTINED')),
  google_file_name text,
  google_file_uri text,
  provider_expires_at timestamptz,
  last_error_code text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reconciled_at timestamptz
);

create index if not exists google_provider_file_upload_attempts_recovery_idx
  on executive_visuals.google_provider_file_upload_attempts (state, updated_at)
  where state in ('UPLOADING','OUTCOME_UNKNOWN','PROVIDER_CREATED');

alter table executive_visuals.google_provider_file_upload_attempts enable row level security;
alter table executive_visuals.google_provider_file_upload_attempts force row level security;

revoke all on table executive_visuals.google_provider_file_upload_attempts from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update on table executive_visuals.google_provider_file_upload_attempts to service_role;

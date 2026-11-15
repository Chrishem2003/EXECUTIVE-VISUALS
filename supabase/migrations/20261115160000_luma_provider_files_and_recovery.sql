-- Durable owner-scoped Luma Files API references and upload recovery ledger.
-- Source-controlled only. Review and apply to isolated staging before any production rollout.

create table if not exists executive_visuals.luma_provider_files (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'luma-ray32' check (provider = 'luma-ray32'),
  provider_file_id uuid not null unique,
  asset_id uuid not null references executive_visuals.assets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  purpose text not null check (purpose in ('input','reference')),
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 262144000),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('PENDING','READY','FAILED','DELETED','EXPIRED','QUARANTINED')),
  provider_expires_at timestamptz,
  failure_code text,
  uploaded_at timestamptz,
  ready_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, asset_id, owner_id, purpose)
);

create index if not exists luma_provider_files_owner_state_idx
  on executive_visuals.luma_provider_files (owner_id, state, updated_at desc);
create index if not exists luma_provider_files_expiry_idx
  on executive_visuals.luma_provider_files (provider_expires_at)
  where state in ('PENDING','READY');

create table if not exists executive_visuals.luma_provider_file_upload_attempts (
  id uuid primary key default gen_random_uuid(),
  attempt_key text not null unique check (attempt_key ~ '^[a-f0-9]{64}$'),
  asset_id uuid not null references executive_visuals.assets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  purpose text not null check (purpose in ('input','reference')),
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 262144000),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  filename text not null,
  state text not null check (state in ('PREPARED','UPLOADING','OUTCOME_UNKNOWN','PROVIDER_CREATED','COMPLETED','FAILED','QUARANTINED')),
  provider_file_id uuid,
  upload_expires_at timestamptz,
  upload_completed_at timestamptz,
  attempt_count integer not null default 1 check (attempt_count > 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reconciled_at timestamptz
);

create index if not exists luma_provider_file_attempts_recovery_idx
  on executive_visuals.luma_provider_file_upload_attempts (state, updated_at)
  where state in ('UPLOADING','OUTCOME_UNKNOWN','PROVIDER_CREATED');

alter table executive_visuals.luma_provider_files enable row level security;
alter table executive_visuals.luma_provider_files force row level security;
alter table executive_visuals.luma_provider_file_upload_attempts enable row level security;
alter table executive_visuals.luma_provider_file_upload_attempts force row level security;

revoke all on table executive_visuals.luma_provider_files from public, anon, authenticated;
revoke all on table executive_visuals.luma_provider_file_upload_attempts from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update, delete on table executive_visuals.luma_provider_files to service_role;
grant select, insert, update on table executive_visuals.luma_provider_file_upload_attempts to service_role;

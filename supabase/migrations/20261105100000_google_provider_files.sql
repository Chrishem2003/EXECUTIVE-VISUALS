-- Private provider-file references for temporary Gemini Files API uploads.
-- Source-controlled only: do not apply to staging or production without review.

create table if not exists executive_visuals.google_provider_files (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'google-gemini-files'),
  asset_id uuid not null references executive_visuals.assets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  google_file_name text not null unique,
  google_file_uri text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 2147483648),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('ACTIVE', 'EXPIRED', 'DELETED', 'FAILED')),
  uploaded_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, asset_id)
);

create index if not exists google_provider_files_expiry_idx
  on executive_visuals.google_provider_files (expires_at)
  where state = 'ACTIVE';

alter table executive_visuals.google_provider_files enable row level security;
alter table executive_visuals.google_provider_files force row level security;

revoke all on table executive_visuals.google_provider_files from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update, delete on table executive_visuals.google_provider_files to service_role;

-- Encrypted per-user Google Drive OAuth connection metadata.
-- The application encrypts refresh tokens before they reach this table.
-- Source-controlled only: review and explicitly apply through the migration process.

create table if not exists executive_visuals.google_drive_connections (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  google_subject text not null check (length(google_subject) between 5 and 255),
  google_email text not null check (length(google_email) between 3 and 320),
  encrypted_refresh_token text not null check (
    encrypted_refresh_token ~ '^gdrive:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  ),
  granted_scopes text[] not null check (
    'https://www.googleapis.com/auth/drive.file' = any(granted_scopes)
  ),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table executive_visuals.google_drive_connections enable row level security;
alter table executive_visuals.google_drive_connections force row level security;

revoke all on table executive_visuals.google_drive_connections from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update, delete on table executive_visuals.google_drive_connections to service_role;

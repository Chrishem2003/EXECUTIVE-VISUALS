-- Encrypted, one-time OAuth state and PKCE verifier storage.
-- State values are SHA-256 hashed; the verifier and OIDC nonce are AES-GCM encrypted by the application.
-- All access is service-role only. Expired rows are removed by the consume path or maintenance cleanup.

create table if not exists executive_visuals.google_drive_oauth_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  encrypted_payload text not null check (
    encrypted_payload ~ '^gstate:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  ),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists google_drive_oauth_states_expiry_idx
  on executive_visuals.google_drive_oauth_states (expires_at);

alter table executive_visuals.google_drive_oauth_states enable row level security;
alter table executive_visuals.google_drive_oauth_states force row level security;

revoke all on table executive_visuals.google_drive_oauth_states from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update, delete on table executive_visuals.google_drive_oauth_states to service_role;

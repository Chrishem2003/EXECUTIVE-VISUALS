-- Durable, encrypted GCS mirror upload-attempt ledger.
-- Additive only. Session URIs are bearer credentials and are stored encrypted by
-- the server adapter; plaintext session URIs must never be written to this table.

create table if not exists executive_visuals.google_gcs_mirror_attempts (
  id uuid primary key,
  attempt_key text not null unique check (attempt_key ~ '^[a-f0-9]{64}$'),
  asset_id uuid not null references executive_visuals.assets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  bucket text not null check (char_length(bucket) between 3 and 63 and bucket ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'),
  object_name text not null check (char_length(object_name) between 1 and 1024 and object_name !~ '^/' and object_name !~ '[[:cntrl:][:space:]?#%]'),
  media_type text not null check (media_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 2147483648),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('PREPARED','UPLOADING','OUTCOME_UNKNOWN','OBJECT_VERIFIED','REGISTERED','FAILED','QUARANTINED')),
  session_uri_ciphertext text,
  session_expires_at timestamptz,
  verified_generation text,
  verified_metageneration text,
  last_error_code text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reconciled_at timestamptz,
  constraint google_gcs_mirror_attempts_lease_pair_check
    check ((lease_token is null) = (lease_expires_at is null)),
  constraint google_gcs_mirror_attempts_session_state_check
    check (state not in ('UPLOADING','OUTCOME_UNKNOWN') or (session_uri_ciphertext is not null and session_expires_at is not null))
);

create index if not exists google_gcs_mirror_attempts_recovery_idx
  on executive_visuals.google_gcs_mirror_attempts (state, lease_expires_at, updated_at)
  where state in ('UPLOADING','OUTCOME_UNKNOWN','OBJECT_VERIFIED');

create or replace function executive_visuals.guard_google_gcs_mirror_attempt()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $
declare
  source_asset executive_visuals.assets%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into source_asset
      from executive_visuals.assets
     where id = new.asset_id and owner_id = new.owner_id
       and project_id is not distinct from new.project_id
       and media_type = new.media_type and byte_size = new.byte_size
       and sha256 = new.sha256 and deleted_at is null;
    if not found then
      raise exception using errcode='23514', message='GOOGLE_GCS_MIRROR_ATTEMPT_ASSET_SCOPE_INVALID';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.attempt_key is distinct from old.attempt_key or
       new.asset_id is distinct from old.asset_id or new.owner_id is distinct from old.owner_id or
       new.project_id is distinct from old.project_id or new.bucket is distinct from old.bucket or
       new.object_name is distinct from old.object_name or new.media_type is distinct from old.media_type or
       new.byte_size is distinct from old.byte_size or new.sha256 is distinct from old.sha256 or
       new.created_at is distinct from old.created_at then
      raise exception using errcode='23514', message='GOOGLE_GCS_MIRROR_ATTEMPT_IDENTITY_IMMUTABLE';
    end if;
    if old.state in ('REGISTERED','FAILED','QUARANTINED') then
      raise exception using errcode='23514', message='GOOGLE_GCS_MIRROR_ATTEMPT_TERMINAL';
    end if;
    if old.session_uri_ciphertext is not null and new.session_uri_ciphertext is distinct from old.session_uri_ciphertext then
      raise exception using errcode='23514', message='GOOGLE_GCS_MIRROR_SESSION_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ev_google_gcs_mirror_attempt_guard on executive_visuals.google_gcs_mirror_attempts;
create trigger ev_google_gcs_mirror_attempt_guard
before update on executive_visuals.google_gcs_mirror_attempts
for each row execute function executive_visuals.guard_google_gcs_mirror_attempt();

alter table executive_visuals.google_gcs_mirror_attempts enable row level security;
alter table executive_visuals.google_gcs_mirror_attempts force row level security;
revoke all on table executive_visuals.google_gcs_mirror_attempts from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update on table executive_visuals.google_gcs_mirror_attempts to service_role;
revoke all on function executive_visuals.guard_google_gcs_mirror_attempt() from public, anon, authenticated;

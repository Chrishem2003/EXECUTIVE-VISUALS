-- Governed registry of verified GCS mirrors for durable Executive Visuals assets.
-- Source records are written only by trusted server code after a successful GCS upload
-- and metadata verification. This migration is additive and contains no destructive DDL/DML.

create table if not exists executive_visuals.google_gcs_asset_sources (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references executive_visuals.assets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  bucket text not null check (
    char_length(bucket) between 3 and 63 and
    bucket ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$' and
    bucket !~ '\.\.' and bucket !~ '\.-' and bucket !~ '-\.'
  ),
  object_name text not null check (
    char_length(object_name) between 1 and 1024 and
    object_name !~ '^/' and
    object_name !~ '[[:cntrl:][:space:]?#%\\]' and
    object_name !~ '(^|/)\.\.(/|$)' and
    object_name !~ '(^|/)\.(/|$)'
  ),
  generation text not null check (generation ~ '^[0-9]{1,30}$'),
  metageneration text not null check (metageneration ~ '^[0-9]{1,30}$'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 2147483648),
  media_type text not null check (media_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  state text not null default 'ACTIVE' check (state in ('ACTIVE','REVOKED')),
  verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint google_gcs_asset_sources_revocation_check
    check ((state = 'ACTIVE' and revoked_at is null) or (state = 'REVOKED' and revoked_at is not null)),
  constraint google_gcs_asset_sources_object_generation_unique
    unique (bucket, object_name, generation)
);

create unique index if not exists google_gcs_asset_sources_one_active_per_asset_idx
  on executive_visuals.google_gcs_asset_sources (asset_id)
  where state = 'ACTIVE';

create index if not exists google_gcs_asset_sources_owner_project_idx
  on executive_visuals.google_gcs_asset_sources (owner_id, project_id, asset_id)
  where state = 'ACTIVE';

create or replace function executive_visuals.validate_google_gcs_asset_source()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $$
declare
  source_asset executive_visuals.assets%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into source_asset
    from executive_visuals.assets
    where id = new.asset_id
      and owner_id = new.owner_id
      and project_id is not distinct from new.project_id
      and media_type = new.media_type
      and byte_size = new.byte_size
      and sha256 = new.sha256
      and deleted_at is null;
    if not found then
      raise exception using errcode = '23514', message = 'GOOGLE_GCS_SOURCE_ASSET_SCOPE_INVALID';
    end if;
    if new.state <> 'ACTIVE' or new.revoked_at is not null then
      raise exception using errcode = '23514', message = 'GOOGLE_GCS_SOURCE_MUST_START_ACTIVE';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or
     new.asset_id is distinct from old.asset_id or
     new.owner_id is distinct from old.owner_id or
     new.project_id is distinct from old.project_id or
     new.bucket is distinct from old.bucket or
     new.object_name is distinct from old.object_name or
     new.generation is distinct from old.generation or
     new.metageneration is distinct from old.metageneration or
     new.byte_size is distinct from old.byte_size or
     new.media_type is distinct from old.media_type or
     new.sha256 is distinct from old.sha256 or
     new.verified_at is distinct from old.verified_at or
     new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'GOOGLE_GCS_SOURCE_IDENTITY_IMMUTABLE';
  end if;

  if old.state <> 'ACTIVE' or new.state <> 'REVOKED' or
     new.revoked_at is null or old.revoked_at is not null then
    raise exception using errcode = '23514', message = 'GOOGLE_GCS_SOURCE_ONLY_ACTIVE_TO_REVOKED';
  end if;
  return new;
end;
$$;

drop trigger if exists ev_google_gcs_asset_sources_validate on executive_visuals.google_gcs_asset_sources;
create trigger ev_google_gcs_asset_sources_validate
before insert or update on executive_visuals.google_gcs_asset_sources
for each row execute function executive_visuals.validate_google_gcs_asset_source();

alter table executive_visuals.google_gcs_asset_sources enable row level security;
alter table executive_visuals.google_gcs_asset_sources force row level security;

revoke all on table executive_visuals.google_gcs_asset_sources from public, anon, authenticated;
grant select, insert, update on table executive_visuals.google_gcs_asset_sources to service_role;

revoke all on function executive_visuals.validate_google_gcs_asset_source() from public, anon, authenticated;

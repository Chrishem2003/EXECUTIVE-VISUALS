-- Persist the client-computed CRC32C independently of mutable GCS object metadata.
-- Existing attempts remain nullable and are quarantined by recovery if they cannot
-- be proven against an immutable checksum receipt. New attempts require a checksum.
alter table executive_visuals.google_gcs_mirror_attempts
  add column if not exists crc32c text;

alter table executive_visuals.google_gcs_mirror_attempts
  drop constraint if exists google_gcs_mirror_attempts_crc32c_check;

alter table executive_visuals.google_gcs_mirror_attempts
  add constraint google_gcs_mirror_attempts_crc32c_check
  check (crc32c is null or crc32c ~ '^[A-Za-z0-9+/]{6}==$');

create or replace function executive_visuals.guard_google_gcs_mirror_attempt()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $gcs_attempt$
declare
  source_asset executive_visuals.assets%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.crc32c is null then
      raise exception using errcode='23514', message='GOOGLE_GCS_MIRROR_ATTEMPT_CRC32C_REQUIRED';
    end if;
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
       new.crc32c is distinct from old.crc32c or new.created_at is distinct from old.created_at then
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
$gcs_attempt$;

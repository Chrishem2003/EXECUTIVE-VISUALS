-- Atomically fence asset metadata publication to the active worker attempt.
-- Additive only. This migration does not alter or remove existing assets, jobs, or storage objects.

create or replace function executive_visuals.finalize_asset_publication_v1(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_publication_key text,
  p_payload_sha256 text,
  p_asset_id uuid,
  p_original_name text,
  p_media_type text,
  p_byte_size bigint,
  p_storage_bucket text,
  p_object_path text,
  p_derivative_of uuid,
  p_metadata jsonb
)
returns setof executive_visuals.assets
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  active_job executive_visuals.jobs;
  publication executive_visuals.asset_publications;
  asset_row executive_visuals.assets;
  expected_prefix text;
  expected_extension text;
  object_filename text;
begin
  if p_job_id is null or p_worker_id is null
     or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_lease_token is null or p_owner_id is null or p_asset_id is null
     or p_publication_key is null or char_length(p_publication_key) not between 1 and 200
     or p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$'
     or p_original_name is null or char_length(p_original_name) not between 1 and 180
     or p_media_type is null or p_byte_size is null or p_byte_size < 1
     or p_storage_bucket is distinct from 'executive-visuals-media'
     or p_object_path is null or jsonb_typeof(p_metadata) is distinct from 'object' then
    raise exception 'invalid atomic asset publication request'
      using errcode = '22023';
  end if;

  expected_extension := case p_media_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/gif' then 'gif'
    when 'video/mp4' then 'mp4'
    when 'video/webm' then 'webm'
    when 'video/quicktime' then 'mov'
    when 'video/x-matroska' then 'mkv'
    when 'audio/mpeg' then 'mp3'
    when 'audio/wav' then 'wav'
    when 'audio/x-wav' then 'wav'
    when 'audio/mp4' then 'm4a'
    when 'audio/ogg' then 'ogg'
    when 'application/pdf' then 'pdf'
    when 'text/plain' then 'txt'
    when 'text/vtt' then 'vtt'
    when 'application/json' then 'json'
    else null
  end;
  if expected_extension is null then
    raise exception 'unsupported atomic asset media type'
      using errcode = '22023';
  end if;

  expected_prefix := coalesce(p_project_id, p_owner_id)::text || '/' || p_asset_id::text || '/';
  if left(p_object_path, char_length(expected_prefix)) <> expected_prefix then
    raise exception 'asset object path is outside its owner/project asset prefix'
      using errcode = '22023';
  end if;
  object_filename := substr(p_object_path, char_length(expected_prefix) + 1);
  if object_filename <> 'original.' || expected_extension then
    if object_filename !~ (
      '^attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.'
      || expected_extension || '$'
    ) then
      raise exception 'asset object path is not a valid immutable publication attempt'
        using errcode = '22023';
    end if;
  end if;

  -- Lock order is always job first, publication second. The job row lock prevents
  -- lease renewal/recovery/reclaim from racing this transaction's finalization.
  select * into active_job
  from executive_visuals.jobs
  where id = p_job_id
  for update;

  if not found
     or active_job.owner_id is distinct from p_owner_id
     or active_job.project_id is distinct from p_project_id
     or active_job.status <> 'processing'
     or active_job.lease_owner is distinct from p_worker_id
     or active_job.lease_token is distinct from p_lease_token
     or active_job.lease_expires_at is null
     or active_job.lease_expires_at <= clock_timestamp() then
    raise exception 'asset publication rejected: worker lease is stale or does not own this job'
      using errcode = 'P0001';
  end if;

  select * into publication
  from executive_visuals.asset_publications
  where owner_id = p_owner_id
    and publication_key = p_publication_key
  for update;

  if not found
     or publication.project_id is distinct from p_project_id
     or publication.asset_id is distinct from p_asset_id
     or publication.payload_sha256 is distinct from p_payload_sha256
     or publication.status not in ('reserved', 'published') then
    raise exception 'asset publication reservation does not match the requested output'
      using errcode = 'P0001';
  end if;

  -- Recheck after acquiring both locks: waiting for the ledger must not let an
  -- expired lease publish merely because it was valid before the wait.
  if active_job.status <> 'processing'
     or active_job.lease_owner is distinct from p_worker_id
     or active_job.lease_token is distinct from p_lease_token
     or active_job.lease_expires_at <= clock_timestamp() then
    raise exception 'asset publication rejected: worker lease expired while waiting for publication lock'
      using errcode = 'P0001';
  end if;

  select * into asset_row
  from executive_visuals.assets
  where id = p_asset_id
  for update;

  if not found then
    insert into executive_visuals.assets (
      id, owner_id, project_id, original_name, media_type, byte_size,
      sha256, storage_bucket, object_path, derivative_of, metadata
    ) values (
      p_asset_id, p_owner_id, p_project_id, p_original_name, p_media_type,
      p_byte_size, p_payload_sha256, p_storage_bucket, p_object_path,
      p_derivative_of, p_metadata
    )
    returning * into asset_row;
  else
    -- A concurrent/retried attempt may have won with a different attempt path.
    -- Accept only an equivalent, owner-scoped immutable attempt and return it;
    -- the caller may then remove only its own losing upload.
    if asset_row.owner_id is distinct from p_owner_id
       or asset_row.project_id is distinct from p_project_id
       or asset_row.original_name is distinct from p_original_name
       or asset_row.media_type is distinct from p_media_type
       or asset_row.byte_size is distinct from p_byte_size
       or asset_row.sha256 is distinct from p_payload_sha256
       or asset_row.storage_bucket is distinct from p_storage_bucket
       or asset_row.derivative_of is distinct from p_derivative_of
       or asset_row.metadata is distinct from p_metadata
       or asset_row.deleted_at is not null
       or left(asset_row.object_path, char_length(expected_prefix)) <> expected_prefix then
      raise exception 'existing asset conflicts with the reserved publication identity'
        using errcode = 'P0001';
    end if;
    object_filename := substr(asset_row.object_path, char_length(expected_prefix) + 1);
    if object_filename <> 'original.' || expected_extension then
      if object_filename !~ (
        '^attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.'
        || expected_extension || '$'
      ) then
        raise exception 'existing asset references an invalid publication object path'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  update executive_visuals.asset_publications
  set status = 'published',
      published_at = coalesce(published_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where owner_id = p_owner_id
    and publication_key = p_publication_key
    and asset_id = p_asset_id;

  return next asset_row;
  return;
end;
$$;

revoke all on function executive_visuals.finalize_asset_publication_v1(
  uuid,text,uuid,uuid,uuid,text,text,uuid,text,text,bigint,text,text,uuid,jsonb
) from public, anon, authenticated;
grant execute on function executive_visuals.finalize_asset_publication_v1(
  uuid,text,uuid,uuid,uuid,text,text,uuid,text,text,bigint,text,text,uuid,jsonb
) to service_role;

comment on function executive_visuals.finalize_asset_publication_v1(
  uuid,text,uuid,uuid,uuid,text,text,uuid,text,text,bigint,text,text,uuid,jsonb
) is
  'Atomically validates the active fenced worker lease, inserts or verifies the owner-scoped asset row, and marks its publication ledger entry published.';

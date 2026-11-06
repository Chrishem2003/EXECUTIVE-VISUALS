-- Atomically fence asset metadata insertion and publication-ledger finalization
-- against the exact worker claim attempt. Storage upload remains outside this
-- short transaction; the object is immutable and uniquely named per attempt.

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
set search_path = ''
as $$
declare
  job_row executive_visuals.jobs;
  publication_row executive_visuals.asset_publications;
  asset_row executive_visuals.assets;
begin
  if p_job_id is null or p_worker_id is null
     or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_lease_token is null
     or p_owner_id is null or p_asset_id is null
     or p_publication_key is null
     or char_length(p_publication_key) not between 1 and 200
     or p_payload_sha256 is null
     or p_payload_sha256 !~ '^[0-9a-f]{64}$'
     or p_original_name is null
     or char_length(p_original_name) not between 1 and 180
     or p_media_type is null or char_length(p_media_type) not between 1 and 128
     or p_byte_size is null or p_byte_size < 1
     or p_storage_bucket is distinct from 'executive-visuals-media'
     or p_object_path is null
     or p_metadata is null or pg_catalog.jsonb_typeof(p_metadata) <> 'object'
  then
    raise exception 'invalid asset publication finalization parameters'
      using errcode = '22023';
  end if;

  -- The job row is the serialization point shared with lease renewal,
  -- recovery, and terminal completion.
  select * into job_row
  from executive_visuals.jobs
  where id = p_job_id
  for update;

  if not found
     or job_row.owner_id is distinct from p_owner_id
     or job_row.project_id is distinct from p_project_id
     or job_row.status <> 'processing'
     or job_row.lease_owner is distinct from p_worker_id
     or job_row.lease_token is distinct from p_lease_token
     or job_row.lease_expires_at is null
     or job_row.lease_expires_at <= pg_catalog.clock_timestamp()
  then
    raise exception 'worker lease is not current for asset publication'
      using errcode = '55000';
  end if;

  select * into publication_row
  from executive_visuals.asset_publications
  where owner_id = p_owner_id
    and publication_key = p_publication_key
  for update;

  if not found
     or publication_row.project_id is distinct from p_project_id
     or publication_row.payload_sha256 is distinct from p_payload_sha256
     or publication_row.asset_id is distinct from p_asset_id
  then
    raise exception 'asset publication reservation does not match finalization'
      using errcode = '23505';
  end if;

  -- A reservation can only point to an object under its owner/project and
  -- asset UUID prefix. Permit the legacy original name for recovery, plus
  -- the immutable per-attempt object naming convention.
  if p_object_path !~ (
    '^' || pg_catalog.coalesce(p_project_id, p_owner_id)::text || '/'
    || p_asset_id::text || '/(attempt-[0-9a-f-]{36}|original)\.[A-Za-z0-9]+$'
  ) then
    raise exception 'asset object path is outside the reserved immutable prefix'
      using errcode = '22023';
  end if;

  -- Insert once. Concurrent finalizers serialize on the publication row and
  -- the asset primary key; a retry must verify the existing immutable identity.
  insert into executive_visuals.assets (
    id, owner_id, project_id, original_name, media_type, byte_size, sha256,
    storage_bucket, object_path, derivative_of, metadata
  ) values (
    p_asset_id, p_owner_id, p_project_id, p_original_name, p_media_type,
    p_byte_size, p_payload_sha256, p_storage_bucket, p_object_path,
    p_derivative_of, p_metadata
  )
  on conflict (id) do nothing;

  select * into asset_row
  from executive_visuals.assets
  where id = p_asset_id
  for update;

  if not found
     or asset_row.owner_id is distinct from p_owner_id
     or asset_row.project_id is distinct from p_project_id
     or asset_row.media_type is distinct from p_media_type
     or asset_row.byte_size is distinct from p_byte_size
     or asset_row.sha256 is distinct from p_payload_sha256
     or asset_row.storage_bucket is distinct from p_storage_bucket
     or asset_row.derivative_of is distinct from p_derivative_of
     or asset_row.deleted_at is not null
     or asset_row.object_path !~ (
       '^' || pg_catalog.coalesce(p_project_id, p_owner_id)::text || '/'
       || p_asset_id::text || '/(attempt-[0-9a-f-]{36}|original)\.[A-Za-z0-9]+$'
     )
  then
    raise exception 'existing asset does not match reserved publication identity'
      using errcode = '23505';
  end if;

  -- Recheck wall-clock expiry after acquiring all locks and verifying the
  -- asset. If the lease expired while this transaction ran, all writes roll back.
  if job_row.lease_expires_at <= pg_catalog.clock_timestamp()
     or job_row.lease_token is distinct from p_lease_token
     or job_row.lease_owner is distinct from p_worker_id
  then
    raise exception 'worker lease expired before publication commit'
      using errcode = '55000';
  end if;

  update executive_visuals.asset_publications
  set status = 'published',
      published_at = pg_catalog.coalesce(published_at, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
  where id = publication_row.id
  returning * into publication_row;

  return next asset_row;
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
  'Atomically validates the active worker lease, inserts or verifies asset metadata, and publishes its owner-scoped idempotency ledger row.';

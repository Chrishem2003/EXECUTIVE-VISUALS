-- Atomically fence asset metadata insertion and publication-ledger finalization
-- against the exact worker claim attempt. Storage upload remains outside this
-- short transaction; each uploaded object is immutable and unique per attempt.

-- A foreign key proves that a derivative source exists, but not that it
-- belongs to the same tenant/project. Enforce that invariant for every asset
-- write path, not only the atomic publication RPC.
alter table executive_visuals.assets
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table executive_visuals.assets
  add column if not exists derivative_of uuid
  references executive_visuals.assets(id) on delete set null;

create index if not exists ev_assets_derivative_source
  on executive_visuals.assets(derivative_of)
  where derivative_of is not null;

create or replace function executive_visuals.validate_asset_derivative_scope_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $derivative_scope$
declare
  parent_asset executive_visuals.assets;
begin
  -- A source asset with existing derivatives cannot be moved to another
  -- project: doing so would invalidate the lineage scope of its children.
  if tg_op = 'UPDATE'
     and (new.owner_id is distinct from old.owner_id
          or new.project_id is distinct from old.project_id)
     and exists (
       select 1
       from executive_visuals.assets
       where derivative_of = old.id
     )
  then
    raise exception 'asset with derivatives cannot change owner/project scope'
      using errcode = '23514';
  end if;

  if new.derivative_of is null then
    return new;
  end if;

  select * into parent_asset
  from executive_visuals.assets
  where id = new.derivative_of
  for share;

  if not found
     or parent_asset.owner_id is distinct from new.owner_id
     or parent_asset.project_id is distinct from new.project_id
     or parent_asset.deleted_at is not null
  then
    raise exception 'asset derivative source must be active and in the same owner/project scope'
      using errcode = '23514';
  end if;

  return new;
end;
$derivative_scope$;

revoke all on function executive_visuals.validate_asset_derivative_scope_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists ev_assets_validate_derivative_scope on executive_visuals.assets;
create trigger ev_assets_validate_derivative_scope
before insert or update of derivative_of, owner_id, project_id
on executive_visuals.assets
for each row execute function executive_visuals.validate_asset_derivative_scope_v1();

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
  expected_extension text;
  expected_path_pattern text;
begin
  if p_job_id is null
     or p_worker_id is null
     or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_lease_token is null
     or p_owner_id is null
     or p_asset_id is null
     or p_publication_key is null
     or char_length(p_publication_key) not between 1 and 200
     or p_payload_sha256 is null
     or p_payload_sha256 !~ '^[0-9a-f]{64}$'
     or p_original_name is null
     or char_length(p_original_name) not between 1 and 180
     or p_media_type is null
     or char_length(p_media_type) not between 1 and 128
     or p_byte_size is null
     or p_byte_size < 1
     or p_storage_bucket is distinct from 'executive-visuals-media'
     or p_object_path is null
     or p_metadata is null
     or pg_catalog.jsonb_typeof(p_metadata) <> 'object'
  then
    raise exception 'invalid asset publication finalization parameters'
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
    raise exception 'unsupported asset media type for publication'
      using errcode = '22023';
  end if;

  expected_path_pattern :=
    '^' || coalesce(p_project_id, p_owner_id)::text || '/'
    || p_asset_id::text
    || '/(attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|original)[.]'
    || expected_extension || '$';

  if p_object_path !~ expected_path_pattern then
    raise exception 'asset object path is outside the reserved immutable prefix'
      using errcode = '22023';
  end if;

  -- Lock the job first. Lease renewal, recovery and completion all update
  -- this row, so no competing transition can pass this serialization point.
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

  -- The owner-scoped ledger row is the second serialization point for
  -- concurrent attempts sharing one stable publication key.
  select * into publication_row
  from executive_visuals.asset_publications
  where owner_id = p_owner_id
    and publication_key = p_publication_key
  for update;

  if not found
     or publication_row.project_id is distinct from p_project_id
     or publication_row.payload_sha256 is distinct from p_payload_sha256
     or publication_row.asset_id is distinct from p_asset_id
     or publication_row.status not in ('reserved', 'published')
  then
    raise exception 'asset publication reservation does not match finalization'
      using errcode = '23505';
  end if;

  -- Insert once. Retries and concurrent attempts verify the existing row;
  -- they never replace its selected object path or metadata.
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
     or asset_row.original_name is distinct from p_original_name
     or asset_row.media_type is distinct from p_media_type
     or asset_row.byte_size is distinct from p_byte_size
     or asset_row.sha256 is distinct from p_payload_sha256
     or asset_row.storage_bucket is distinct from p_storage_bucket
     or asset_row.derivative_of is distinct from p_derivative_of
     or asset_row.metadata is distinct from p_metadata
     or asset_row.deleted_at is not null
     or asset_row.object_path !~ expected_path_pattern
  then
    raise exception 'existing asset does not match reserved publication identity'
      using errcode = '23505';
  end if;

  -- Recheck expiry after all locks and asset verification. If it expired
  -- during lock acquisition, the exception rolls back both writes.
  if job_row.lease_expires_at <= pg_catalog.clock_timestamp()
     or job_row.lease_token is distinct from p_lease_token
     or job_row.lease_owner is distinct from p_worker_id
  then
    raise exception 'worker lease expired before publication commit'
      using errcode = '55000';
  end if;

  update executive_visuals.asset_publications
  set status = 'published',
      published_at = coalesce(published_at, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
  where id = publication_row.id;

  return next asset_row;
end;
$$;

-- The legacy completion RPC can publish a ledger row without proving the
-- current worker claim. All new render publication must use the atomic RPC.
revoke all on function executive_visuals.complete_asset_publication(uuid,text,uuid)
  from public, anon, authenticated, service_role;

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

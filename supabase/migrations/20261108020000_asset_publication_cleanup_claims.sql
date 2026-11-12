-- Bind each new reservation to the job whose lease authorized it.
alter table executive_visuals.asset_publications
  add column if not exists job_id uuid;

create index if not exists ev_asset_publications_job_id
  on executive_visuals.asset_publications(job_id)
  where job_id is not null;

create or replace function executive_visuals.reserve_asset_publication_v2(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_publication_key text,
  p_payload_sha256 text,
  p_asset_id uuid
)
returns setof executive_visuals.asset_publications
language plpgsql
security definer
set search_path = ''
as $reserve_publication$
declare
  job_row executive_visuals.jobs;
  reserved executive_visuals.asset_publications;
begin
  if p_job_id is null or p_worker_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_worker_id)) not between 1 and 128
     or p_lease_token is null or p_owner_id is null or p_asset_id is null
     or p_publication_key is null
     or pg_catalog.char_length(p_publication_key) not between 1 and 200
     or p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid asset publication reservation parameters'
      using errcode = '22023';
  end if;

  select j.* into job_row
  from executive_visuals.jobs j
  where j.id = p_job_id
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
    raise exception 'current worker lease is required to reserve asset publication'
      using errcode = '55000';
  end if;

  insert into executive_visuals.asset_publications as current_publication
    (owner_id, project_id, job_id, publication_key, payload_sha256, asset_id)
  values
    (p_owner_id, p_project_id, p_job_id, p_publication_key, p_payload_sha256, p_asset_id)
  on conflict on constraint ev_asset_publications_owner_key do update
    set updated_at = pg_catalog.clock_timestamp()
    where current_publication.job_id = excluded.job_id
      and current_publication.project_id is not distinct from excluded.project_id
      and current_publication.payload_sha256 = excluded.payload_sha256
  returning current_publication.* into reserved;

  if not found then
    raise exception 'publication key is already bound to another job, project, or payload'
      using errcode = '23505';
  end if;

  return next reserved;
end;
$reserve_publication$;

revoke all on function executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function executive_visuals.reserve_asset_publication_v2(uuid,text,uuid,uuid,uuid,text,text,uuid)
  from public, anon, authenticated;
grant execute on function executive_visuals.reserve_asset_publication_v2(uuid,text,uuid,uuid,uuid,text,text,uuid)
  to service_role;

-- Durable tombstones fence storage cleanup against late publication finalization.
-- Additive only. This migration does not delete storage objects or invoke a cleanup worker.
create table if not exists executive_visuals.asset_publication_cleanup_claims (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references executive_visuals.asset_publications(id) on delete cascade,
  job_id uuid not null,
  owner_id uuid not null,
  project_id uuid,
  object_path text not null unique,
  claim_token uuid not null unique default gen_random_uuid(),
  status text not null default 'claimed' check (status in ('claimed','deleted')),
  claimed_at timestamptz not null default pg_catalog.clock_timestamp(),
  deleted_at timestamptz,
  constraint asset_publication_cleanup_claims_deleted_at_check
    check ((status='deleted') = (deleted_at is not null))
);

create index if not exists ev_asset_publication_cleanup_claims_publication
  on executive_visuals.asset_publication_cleanup_claims(publication_id, claimed_at desc);

alter table executive_visuals.asset_publication_cleanup_claims enable row level security;
revoke all on executive_visuals.asset_publication_cleanup_claims from public, anon, authenticated;
grant select, insert, update on executive_visuals.asset_publication_cleanup_claims to service_role;

create or replace function executive_visuals.claim_asset_publication_cleanup_v1(
  p_job_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_publication_key text,
  p_object_path text,
  p_min_age interval default interval '24 hours'
)
returns table(claim_id uuid, claim_token uuid, object_path text, status text)
language plpgsql
security definer
set search_path = ''
as $claim_cleanup$
declare
  job_row executive_visuals.jobs;
  publication_row executive_visuals.asset_publications;
  claim_row executive_visuals.asset_publication_cleanup_claims;
  expected_prefix text;
begin
  if p_job_id is null or p_owner_id is null
     or p_publication_key is null
     or pg_catalog.char_length(p_publication_key) not between 1 and 200
     or p_object_path is null
     or p_min_age is null
     or extract(epoch from p_min_age) not between 86400 and 2592000
  then
    raise exception 'invalid asset publication cleanup claim parameters'
      using errcode = '22023';
  end if;

  -- Lock order is deliberately identical to publication finalization:
  -- job row first, then the owner-scoped publication ledger row.
  select j.* into job_row
  from executive_visuals.jobs j
  where j.id = p_job_id
  for update;

  if not found
     or job_row.owner_id is distinct from p_owner_id
     or job_row.project_id is distinct from p_project_id
     or job_row.status not in ('succeeded','partial','failed','cancelled','expired')
     or (job_row.lease_expires_at is not null
         and job_row.lease_expires_at > pg_catalog.clock_timestamp())
  then
    raise exception 'publication cleanup is blocked by a missing, mismatched, or active job'
      using errcode = '55000';
  end if;

  select p.* into publication_row
  from executive_visuals.asset_publications p
  where p.owner_id = p_owner_id
    and p.project_id is not distinct from p_project_id
    and p.publication_key = p_publication_key
  for update;

  if not found
     or publication_row.status not in ('reserved','published')
     or publication_row.job_id is distinct from p_job_id
     or publication_row.updated_at > pg_catalog.clock_timestamp() - p_min_age
  then
    raise exception 'publication is missing, already finalized, or not old enough for cleanup'
      using errcode = '55000';
  end if;

  expected_prefix := coalesce(p_project_id, p_owner_id)::text
    || '/' || publication_row.asset_id::text || '/';

  if p_object_path !~ (
    '^' || expected_prefix
    || 'attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.][A-Za-z0-9]{1,12}$'
  ) then
    raise exception 'cleanup object path is outside the reserved publication attempt prefix'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from executive_visuals.assets a
    where a.object_path = p_object_path
  ) then
    raise exception 'referenced asset objects cannot be claimed for cleanup'
      using errcode = '55000';
  end if;

  insert into executive_visuals.asset_publication_cleanup_claims(
    publication_id, job_id, owner_id, project_id, object_path
  ) values (
    publication_row.id, p_job_id, p_owner_id, p_project_id, p_object_path
  )
  on conflict on constraint asset_publication_cleanup_claims_object_path_key do update
    set status = 'claimed',
        claim_token = pg_catalog.gen_random_uuid(),
        claimed_at = pg_catalog.clock_timestamp(),
        deleted_at = null
    where executive_visuals.asset_publication_cleanup_claims.status = 'deleted';

  select c.* into claim_row
  from executive_visuals.asset_publication_cleanup_claims c
  where c.object_path = p_object_path
  for update;

  if not found
     or claim_row.publication_id is distinct from publication_row.id
     or claim_row.job_id is distinct from p_job_id
     or claim_row.owner_id is distinct from p_owner_id
     or claim_row.project_id is distinct from p_project_id
  then
    raise exception 'object path is already fenced by a different cleanup claim'
      using errcode = '23505';
  end if;

  return query select claim_row.id, claim_row.claim_token,
    claim_row.object_path, claim_row.status;
end;
$claim_cleanup$;

create or replace function executive_visuals.complete_asset_publication_cleanup_v1(
  p_claim_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $complete_cleanup$
declare changed integer;
begin
  if p_claim_id is null or p_claim_token is null then
    raise exception 'cleanup claim identity is required'
      using errcode = '22023';
  end if;

  update executive_visuals.asset_publication_cleanup_claims c
  set status = 'deleted',
      deleted_at = coalesce(c.deleted_at, pg_catalog.clock_timestamp())
  where c.id = p_claim_id
    and c.claim_token = p_claim_token
    and c.status = 'claimed';

  get diagnostics changed = row_count;
  if changed = 1 then return true; end if;

  return exists (
    select 1 from executive_visuals.asset_publication_cleanup_claims c
    where c.id = p_claim_id
      and c.claim_token = p_claim_token
      and c.status = 'deleted'
  );
end;
$complete_cleanup$;

revoke all on function executive_visuals.claim_asset_publication_cleanup_v1(uuid,uuid,uuid,text,text,interval)
  from public, anon, authenticated;
grant execute on function executive_visuals.claim_asset_publication_cleanup_v1(uuid,uuid,uuid,text,text,interval)
  to service_role;
revoke all on function executive_visuals.complete_asset_publication_cleanup_v1(uuid,uuid)
  from public, anon, authenticated;
grant execute on function executive_visuals.complete_asset_publication_cleanup_v1(uuid,uuid)
  to service_role;

comment on table executive_visuals.asset_publication_cleanup_claims is
  'Durable object-path tombstones. A claim fences the exact path against late publication finalization until storage deletion is confirmed.';

-- Reinstall finalization with the cleanup tombstone fence.
-- Atomically fence asset metadata insertion and publication-ledger finalization
-- against the exact worker claim attempt. Storage upload remains outside this
-- short transaction; each uploaded object is immutable and unique per attempt.

-- A foreign key proves that a derivative source exists, but not that it
-- belongs to the same tenant/project. Enforce that invariant for every asset
-- write path, not only the atomic publication RPC.
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
     or publication_row.job_id is distinct from p_job_id
  then
    raise exception 'asset publication reservation does not match finalization'
      using errcode = '23505';
  end if;

  -- Cleanup claims use the same job -> publication lock order. Because the
  -- publication row is already locked above, a cleanup claim cannot race this
  -- check: either cleanup commits its tombstone first, or publication commits
  -- first and cleanup observes the published ledger state.
  if exists (
    select 1
    from executive_visuals.asset_publication_cleanup_claims cleanup_claim
    where cleanup_claim.publication_id = publication_row.id
      and cleanup_claim.object_path = p_object_path
  ) then
    raise exception 'asset object path is fenced by a durable cleanup claim'
      using errcode = '55000';
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

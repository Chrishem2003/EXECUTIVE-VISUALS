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
     or pg_catalog.extract(epoch from p_min_age) not between 86400 and 2592000
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
     or (job_row.status = 'processing'
         and (job_row.lease_expires_at is null
              or job_row.lease_expires_at > pg_catalog.clock_timestamp()))
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
     or publication_row.status <> 'reserved'
     or publication_row.updated_at > pg_catalog.clock_timestamp() - p_min_age
  then
    raise exception 'publication is missing, already finalized, or not old enough for cleanup'
      using errcode = '55000';
  end if;

  expected_prefix := pg_catalog.coalesce(p_project_id, p_owner_id)::text
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
  on conflict (object_path) do nothing;

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
      deleted_at = pg_catalog.coalesce(c.deleted_at, pg_catalog.clock_timestamp())
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

-- Idempotent publication ledger for cloud-render outputs.
-- Additive only: existing jobs, assets, and storage objects are untouched.
create table if not exists executive_visuals.asset_publications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  publication_key text not null check (char_length(publication_key) between 1 and 200),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  asset_id uuid not null,
  status text not null default 'reserved' check (status in ('reserved','published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  unique(owner_id, publication_key),
  unique(asset_id),
  check ((status='published') = (published_at is not null))
);

create index if not exists ev_asset_publications_pending
  on executive_visuals.asset_publications(updated_at)
  where status='reserved';

alter table executive_visuals.asset_publications enable row level security;
revoke all on executive_visuals.asset_publications from public, anon, authenticated;
grant select, insert, update on executive_visuals.asset_publications to service_role;

create or replace function executive_visuals.reserve_asset_publication(
  p_owner_id uuid,
  p_project_id uuid,
  p_publication_key text,
  p_payload_sha256 text,
  p_asset_id uuid
)
returns table(owner_id uuid, project_id uuid, publication_key text, payload_sha256 text, asset_id uuid, status text)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare reserved executive_visuals.asset_publications;
begin
  if p_owner_id is null or p_asset_id is null
     or p_publication_key is null or char_length(p_publication_key) not between 1 and 200
     or p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid asset publication reservation';
  end if;

  insert into executive_visuals.asset_publications as current_publication
    (owner_id, project_id, publication_key, payload_sha256, asset_id)
  values
    (p_owner_id, p_project_id, p_publication_key, p_payload_sha256, p_asset_id)
  on conflict (owner_id, publication_key) do update
    set updated_at = now()
    where current_publication.project_id is not distinct from excluded.project_id
      and current_publication.payload_sha256 = excluded.payload_sha256
  returning current_publication.* into reserved;

  if not found then
    raise exception 'publication key already reserved for different project or payload'
      using errcode = '23505';
  end if;

  return query select reserved.owner_id, reserved.project_id, reserved.publication_key,
    reserved.payload_sha256, reserved.asset_id, reserved.status;
end;
$$;

create or replace function executive_visuals.complete_asset_publication(
  p_owner_id uuid,
  p_publication_key text,
  p_asset_id uuid
)
returns table(owner_id uuid, publication_key text, asset_id uuid, status text, published_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare completed executive_visuals.asset_publications;
begin
  update executive_visuals.asset_publications publication
    set status='published', published_at=coalesce(publication.published_at, now()), updated_at=now()
  where publication.owner_id=p_owner_id
    and publication.publication_key=p_publication_key
    and publication.asset_id=p_asset_id
    and exists (
      select 1 from executive_visuals.assets asset
      where asset.id=publication.asset_id
        and asset.owner_id=publication.owner_id
        and asset.project_id is not distinct from publication.project_id
        and asset.sha256=publication.payload_sha256
        and asset.deleted_at is null
    )
  returning publication.* into completed;

  if not found then
    raise exception 'publication cannot be completed without its matching active asset';
  end if;

  return query select completed.owner_id, completed.publication_key,
    completed.asset_id, completed.status, completed.published_at;
end;
$$;

revoke all on function executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid) from public, anon, authenticated;
revoke all on function executive_visuals.complete_asset_publication(uuid,text,uuid) from public, anon, authenticated;
grant execute on function executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid) to service_role;
grant execute on function executive_visuals.complete_asset_publication(uuid,text,uuid) to service_role;

comment on table executive_visuals.asset_publications is
  'Service-role-only idempotency ledger for render outputs. Stable owner-scoped publication keys bind one payload checksum to one asset UUID.';

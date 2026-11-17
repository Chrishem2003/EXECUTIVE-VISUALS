-- Enforce free-tier-safe storage limits at the metadata boundary.
-- Initial Supabase staging limits: 750 MiB global / 512 MiB per owner.
-- When a separately approved R2 production bucket is activated, the operator
-- can raise these values to remain below the R2 10 GB-month free allowance.

create table if not exists executive_visuals.asset_storage_limits (
  singleton boolean primary key default true check (singleton),
  max_total_bytes bigint not null check (max_total_bytes > 0),
  max_owner_bytes bigint not null check (max_owner_bytes > 0),
  updated_at timestamptz not null default now()
);

insert into executive_visuals.asset_storage_limits(singleton,max_total_bytes,max_owner_bytes)
values (true,786432000,536870912)
on conflict (singleton) do nothing;

alter table executive_visuals.asset_storage_limits enable row level security;
revoke all on table executive_visuals.asset_storage_limits from public, anon, authenticated;
grant select, update on table executive_visuals.asset_storage_limits to service_role;

create or replace function executive_visuals.enforce_asset_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
set row_security = off
as $$
declare
  v_max_total bigint;
  v_max_owner bigint;
  v_total_used bigint;
  v_owner_used bigint;
begin
  if new.deleted_at is not null then
    return new;
  end if;

  -- Serialize quota-affecting inserts/restores so parallel uploads cannot
  -- both observe the same remaining capacity and exceed the configured cap.
  perform pg_advisory_xact_lock(hashtextextended('executive_visuals.asset_storage_quota', 0));

  select max_total_bytes, max_owner_bytes
    into v_max_total, v_max_owner
  from executive_visuals.asset_storage_limits
  where singleton = true;

  if not found or v_max_total is null or v_max_owner is null then
    raise exception using
      errcode = 'P0001',
      message = 'CLOUD_ASSET_STORAGE_QUOTA_CONFIG_MISSING';
  end if;

  select coalesce(sum(a.byte_size), 0)
    into v_total_used
  from executive_visuals.assets a
  where a.deleted_at is null
    and a.id is distinct from new.id;

  select coalesce(sum(a.byte_size), 0)
    into v_owner_used
  from executive_visuals.assets a
  where a.deleted_at is null
    and a.owner_id = new.owner_id
    and a.id is distinct from new.id;

  if v_total_used + new.byte_size > v_max_total then
    raise exception using
      errcode = 'P0001',
      message = 'CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED',
      detail = json_build_object(
        'usedBytes', v_total_used,
        'requestedBytes', new.byte_size,
        'limitBytes', v_max_total
      )::text;
  end if;

  if v_owner_used + new.byte_size > v_max_owner then
    raise exception using
      errcode = 'P0001',
      message = 'CLOUD_ASSET_OWNER_QUOTA_EXCEEDED',
      detail = json_build_object(
        'usedBytes', v_owner_used,
        'requestedBytes', new.byte_size,
        'limitBytes', v_max_owner
      )::text;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_asset_storage_quota on executive_visuals.assets;
create trigger enforce_asset_storage_quota
before insert or update of byte_size, owner_id, deleted_at
on executive_visuals.assets
for each row
execute function executive_visuals.enforce_asset_storage_quota();

create or replace function executive_visuals.get_asset_storage_usage(p_owner_id uuid)
returns table (
  global_bytes bigint,
  global_asset_count bigint,
  owner_bytes bigint,
  owner_asset_count bigint,
  max_total_bytes bigint,
  max_owner_bytes bigint,
  remaining_total_bytes bigint,
  remaining_owner_bytes bigint
)
language sql
stable
security definer
set search_path = pg_catalog, executive_visuals
set row_security = off
as $$
  select
    coalesce(sum(a.byte_size), 0)::bigint,
    count(a.id) filter (where a.id is not null)::bigint,
    coalesce(sum(a.byte_size) filter (where a.owner_id = p_owner_id), 0)::bigint,
    count(a.id) filter (where a.owner_id = p_owner_id)::bigint,
    limits.max_total_bytes,
    limits.max_owner_bytes,
    greatest(limits.max_total_bytes - coalesce(sum(a.byte_size), 0), 0)::bigint,
    greatest(limits.max_owner_bytes - coalesce(sum(a.byte_size) filter (where a.owner_id = p_owner_id), 0), 0)::bigint
  from executive_visuals.asset_storage_limits limits
  left join executive_visuals.assets a on a.deleted_at is null
  where limits.singleton = true
  group by limits.max_total_bytes, limits.max_owner_bytes;
$$;

revoke all on function executive_visuals.enforce_asset_storage_quota() from public, anon, authenticated;
revoke all on function executive_visuals.get_asset_storage_usage(uuid) from public, anon, authenticated;
grant execute on function executive_visuals.get_asset_storage_usage(uuid) to service_role;

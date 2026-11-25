-- Batch 123: immutable asset resource events and transactional retention checkpoints.
-- Additive only. No existing financial ledger, payment, or production data is modified.

create table if not exists executive_visuals.asset_resource_measurement_events (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references executive_visuals.assets(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  project_id uuid references executive_visuals.projects(id) on delete restrict,
  event_kind text not null check (event_kind in ('storage_retention','egress')),
  measurement_id text not null unique check (char_length(measurement_id) between 8 and 180),
  resource_type text not null check (resource_type in ('storage_gb_day','egress_gb')),
  quantity numeric(24,10) not null check (quantity > 0),
  unit text not null check (unit in ('gb_day','gb')),
  measured_at timestamptz not null,
  interval_start timestamptz,
  interval_end timestamptz,
  transferred_bytes bigint,
  evidence_source text not null check (evidence_source = 'worker_instrumentation'),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 180),
  created_at timestamptz not null default now(),
  constraint asset_resource_measurement_shape check (
    (event_kind = 'storage_retention' and resource_type = 'storage_gb_day' and unit = 'gb_day'
      and interval_start is not null and interval_end is not null and interval_end > interval_start
      and measured_at = interval_end and transferred_bytes is null)
    or
    (event_kind = 'egress' and resource_type = 'egress_gb' and unit = 'gb'
      and interval_start is null and interval_end is null and transferred_bytes between 1 and 2147483648)
  )
);
create or replace function executive_visuals.reject_asset_resource_measurement_mutation()
returns trigger language plpgsql set search_path = pg_catalog, executive_visuals
as $
begin
  raise exception 'ASSET_RESOURCE_MEASUREMENTS_IMMUTABLE';
end;
$;
revoke all on function executive_visuals.reject_asset_resource_measurement_mutation() from public, anon, authenticated, service_role;

create trigger asset_resource_measurements_immutable
before update or delete on executive_visuals.asset_resource_measurement_events
for each row execute function executive_visuals.reject_asset_resource_measurement_mutation();

create index if not exists asset_resource_measurements_owner_time_idx
  on executive_visuals.asset_resource_measurement_events(owner_id, measured_at desc);
create index if not exists asset_resource_measurements_asset_time_idx
  on executive_visuals.asset_resource_measurement_events(asset_id, measured_at desc);

create table if not exists executive_visuals.asset_storage_retention_checkpoints (
  asset_id uuid primary key references executive_visuals.assets(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  project_id uuid references executive_visuals.projects(id) on delete restrict,
  cursor_at timestamptz not null,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);
create index if not exists asset_storage_retention_checkpoints_owner_idx
  on executive_visuals.asset_storage_retention_checkpoints(owner_id, cursor_at);

alter table executive_visuals.asset_resource_measurement_events enable row level security;
alter table executive_visuals.asset_resource_measurement_events force row level security;
alter table executive_visuals.asset_storage_retention_checkpoints enable row level security;
alter table executive_visuals.asset_storage_retention_checkpoints force row level security;
revoke all on table executive_visuals.asset_resource_measurement_events from public, anon, authenticated, service_role;
revoke all on table executive_visuals.asset_storage_retention_checkpoints from public, anon, authenticated, service_role;

create or replace function executive_visuals.record_asset_resource_measurement(
  p_actor_id uuid,
  p_asset_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_measurement_id text,
  p_event_kind text,
  p_resource_type text,
  p_unit text,
  p_quantity numeric,
  p_measured_at timestamptz,
  p_interval_start timestamptz,
  p_interval_end timestamptz,
  p_transferred_bytes bigint,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals, auth
set row_security = off
as $$
declare
  v_asset executive_visuals.assets%rowtype;
  v_checkpoint executive_visuals.asset_storage_retention_checkpoints%rowtype;
  v_existing executive_visuals.asset_resource_measurement_events%rowtype;
  v_event_id uuid;
  v_expected numeric;
begin
  if p_actor_id is null or not exists (
    select 1 from executive_visuals.platform_admins
    where user_id = p_actor_id and role in ('owner','platform_admin','billing_admin')
  ) then
    raise exception 'Financial administrator access required' using errcode = '42501';
  end if;
  if p_asset_id is null or p_owner_id is null
     or coalesce(length(p_measurement_id),0) not between 8 and 180
     or coalesce(length(p_idempotency_key),0) not between 8 and 180
     or p_measured_at is null or p_quantity is null or p_quantity <= 0 then
    raise exception 'Invalid asset resource measurement identity or quantity' using errcode = '22023';
  end if;

  select * into v_asset
  from executive_visuals.assets
  where id = p_asset_id and owner_id = p_owner_id
    and project_id is not distinct from p_project_id;
  if not found then
    raise exception 'Asset resource attribution does not match a persisted asset' using errcode = '22023';
  end if;
  if v_asset.byte_size is null or v_asset.byte_size <= 0 then
    raise exception 'Asset resource byte size is unavailable' using errcode = '22023';
  end if;

  select * into v_existing
  from executive_visuals.asset_resource_measurement_events
  where idempotency_key = p_idempotency_key or measurement_id = p_measurement_id
  limit 1;
  if found then
    if v_existing.asset_id is distinct from p_asset_id
      or v_existing.owner_id is distinct from p_owner_id
      or v_existing.project_id is distinct from p_project_id
      or v_existing.measurement_id is distinct from p_measurement_id
      or v_existing.event_kind is distinct from p_event_kind
      or v_existing.resource_type is distinct from p_resource_type
      or v_existing.unit is distinct from p_unit
      or v_existing.quantity is distinct from p_quantity
      or v_existing.measured_at is distinct from p_measured_at
      or v_existing.interval_start is distinct from p_interval_start
      or v_existing.interval_end is distinct from p_interval_end
      or v_existing.transferred_bytes is distinct from p_transferred_bytes
      or v_existing.idempotency_key is distinct from p_idempotency_key then
      raise exception 'Asset resource measurement identity conflicts with existing evidence' using errcode = '23505';
    end if;
    return jsonb_build_object('eventId',v_existing.id,'measurementId',v_existing.measurement_id,
      'eventKind',v_existing.event_kind,'idempotentReplay',true,'checkpointAdvanced',false);
  end if;

  if p_event_kind = 'storage_retention' then
    if p_resource_type <> 'storage_gb_day' or p_unit <> 'gb_day'
      or p_interval_start is null or p_interval_end is null
      or p_interval_end <= p_interval_start or p_measured_at <> p_interval_end
      or p_transferred_bytes is not null then
      raise exception 'Storage retention measurement shape is invalid' using errcode = '22023';
    end if;
    insert into executive_visuals.asset_storage_retention_checkpoints(asset_id,owner_id,project_id,cursor_at)
      values(p_asset_id,p_owner_id,p_project_id,v_asset.created_at)
      on conflict (asset_id) do nothing;
    select * into v_checkpoint
      from executive_visuals.asset_storage_retention_checkpoints
      where asset_id = p_asset_id for update;
    if v_checkpoint.owner_id is distinct from p_owner_id
      or v_checkpoint.project_id is distinct from p_project_id then
      raise exception 'Asset retention checkpoint attribution conflict' using errcode = '23514';
    end if;
    if p_interval_start <> v_checkpoint.cursor_at then
      raise exception 'Asset retention interval does not begin at the persisted checkpoint' using errcode = '23514';
    end if;
    if p_interval_end <= v_checkpoint.cursor_at then
      raise exception 'Asset retention checkpoint must advance' using errcode = '22023';
    end if;
    v_expected := (v_asset.byte_size::numeric / 1000000000)
      * (extract(epoch from (p_interval_end - p_interval_start)) / 86400);
    if abs(v_expected - p_quantity) > 0.00000001 then
      raise exception 'Asset retention quantity does not match bytes and elapsed time' using errcode = '22023';
    end if;
  elsif p_event_kind = 'egress' then
    if p_resource_type <> 'egress_gb' or p_unit <> 'gb'
      or p_interval_start is not null or p_interval_end is not null
      or p_transferred_bytes is null or p_transferred_bytes < 1
      or p_transferred_bytes > v_asset.byte_size then
      raise exception 'Asset egress measurement shape is invalid' using errcode = '22023';
    end if;
    v_expected := p_transferred_bytes::numeric / 1000000000;
    if abs(v_expected - p_quantity) > 0.00000001 then
      raise exception 'Asset egress quantity does not match transferred bytes' using errcode = '22023';
    end if;
  else
    raise exception 'Unsupported asset resource event kind' using errcode = '22023';
  end if;

  insert into executive_visuals.asset_resource_measurement_events(
    asset_id,owner_id,project_id,event_kind,measurement_id,resource_type,quantity,unit,
    measured_at,interval_start,interval_end,transferred_bytes,evidence_source,idempotency_key
  ) values (
    p_asset_id,p_owner_id,p_project_id,p_event_kind,p_measurement_id,p_resource_type,p_quantity,p_unit,
    p_measured_at,p_interval_start,p_interval_end,p_transferred_bytes,'worker_instrumentation',p_idempotency_key
  ) returning id into v_event_id;

  if p_event_kind = 'storage_retention' then
    update executive_visuals.asset_storage_retention_checkpoints
      set cursor_at = p_interval_end, version = version + 1, updated_at = now()
      where asset_id = p_asset_id;
  end if;

  return jsonb_build_object('eventId',v_event_id,'measurementId',p_measurement_id,
    'eventKind',p_event_kind,'idempotentReplay',false,
    'checkpointAdvanced',p_event_kind = 'storage_retention');
end;
$$;

revoke all on function executive_visuals.record_asset_resource_measurement(
  uuid,uuid,uuid,uuid,text,text,text,text,numeric,timestamptz,timestamptz,timestamptz,bigint,text
) from public, anon, authenticated;
grant execute on function executive_visuals.record_asset_resource_measurement(
  uuid,uuid,uuid,uuid,text,text,text,text,numeric,timestamptz,timestamptz,timestamptz,bigint,text
) to service_role;

comment on table executive_visuals.asset_resource_measurement_events is
  'Immutable asset-scoped storage-retention and completed-egress measurements; distinct from generation-job accounting.';
comment on table executive_visuals.asset_storage_retention_checkpoints is
  'Per-asset retention cursor advanced in the same transaction as its immutable storage measurement event.';

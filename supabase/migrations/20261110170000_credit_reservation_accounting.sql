-- Batch 3: atomic credit reservations and balance accounting.
-- Service-role only. This migration does not wire reservations into generation jobs.
create table if not exists executive_visuals.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  job_id uuid,
  credit_units bigint not null check (credit_units > 0),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 180),
  status text not null default 'reserved' check (status in ('reserved','settled','released')),
  reason text not null check (char_length(reason) between 3 and 500),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  released_at timestamptz,
  unique(owner_id,idempotency_key)
);
create index if not exists credit_reservations_owner_status_idx
  on executive_visuals.credit_reservations(owner_id,status,created_at desc);
create index if not exists credit_reservations_job_idx
  on executive_visuals.credit_reservations(job_id) where job_id is not null;
alter table executive_visuals.credit_reservations enable row level security;
revoke all on executive_visuals.credit_reservations from anon,authenticated;
grant select,insert,update,delete on executive_visuals.credit_reservations to service_role;

create or replace function executive_visuals.get_credit_balance(p_owner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, public
as $$
declare
  ledger_units bigint;
  reserved_units bigint;
begin
  if p_owner_id is null then raise exception 'Owner is required'; end if;
  select coalesce(sum(credit_delta),0)::bigint into ledger_units
    from executive_visuals.credit_ledger where owner_id=p_owner_id;
  select coalesce(sum(credit_units),0)::bigint into reserved_units
    from executive_visuals.credit_reservations
   where owner_id=p_owner_id and status='reserved';
  return jsonb_build_object(
    'ledger_balance',ledger_units,
    'reserved_credits',reserved_units,
    'available_credits',ledger_units-reserved_units
  );
end;
$$;
revoke all on function executive_visuals.get_credit_balance(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.get_credit_balance(uuid) to service_role;

create or replace function executive_visuals.reserve_credit_units(
  p_owner_id uuid,
  p_credit_units bigint,
  p_idempotency_key text,
  p_reason text,
  p_job_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, public
as $$
declare
  existing_row executive_visuals.credit_reservations%rowtype;
  ledger_units bigint;
  reserved_units bigint;
  reservation_id uuid;
begin
  if p_owner_id is null or p_credit_units is null or p_credit_units<=0
     or nullif(trim(p_idempotency_key),'') is null
     or char_length(p_idempotency_key) not between 8 and 180
     or char_length(coalesce(p_reason,'')) not between 3 and 500
     or jsonb_typeof(coalesce(p_metadata,'{}'::jsonb))<>'object' then
    raise exception 'Invalid credit reservation input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));

  select * into existing_row from executive_visuals.credit_reservations
   where owner_id=p_owner_id and idempotency_key=p_idempotency_key for update;
  if found then
    if existing_row.credit_units<>p_credit_units
       or existing_row.job_id is distinct from p_job_id then
      raise exception 'Credit reservation idempotency key conflict';
    end if;
    return jsonb_build_object('reservation_id',existing_row.id,'status',existing_row.status,
      'credit_units',existing_row.credit_units,'idempotent_replay',true);
  end if;

  select coalesce(sum(credit_delta),0)::bigint into ledger_units
    from executive_visuals.credit_ledger where owner_id=p_owner_id;
  select coalesce(sum(credit_units),0)::bigint into reserved_units
    from executive_visuals.credit_reservations
   where owner_id=p_owner_id and status='reserved';

  if ledger_units-reserved_units<p_credit_units then
    raise exception using message='Insufficient available credits',errcode='P0001',
      detail=jsonb_build_object('available_credits',ledger_units-reserved_units,
        'requested_credits',p_credit_units)::text;
  end if;

  insert into executive_visuals.credit_reservations
    (owner_id,job_id,credit_units,idempotency_key,reason,metadata)
  values(p_owner_id,p_job_id,p_credit_units,p_idempotency_key,p_reason,coalesce(p_metadata,'{}'::jsonb))
  returning id into reservation_id;

  return jsonb_build_object('reservation_id',reservation_id,'status','reserved',
    'credit_units',p_credit_units,'available_after_reservation',ledger_units-reserved_units-p_credit_units,
    'idempotent_replay',false);
end;
$$;
revoke all on function executive_visuals.reserve_credit_units(uuid,bigint,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function executive_visuals.reserve_credit_units(uuid,bigint,text,text,uuid,jsonb) to service_role;

create or replace function executive_visuals.settle_credit_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, public
as $$
declare
  reservation_row executive_visuals.credit_reservations%rowtype;
begin
  if p_reservation_id is null then raise exception 'Reservation ID is required'; end if;
  select * into reservation_row from executive_visuals.credit_reservations
   where id=p_reservation_id for update;
  if not found then raise exception 'Credit reservation not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(reservation_row.owner_id::text,0));

  if reservation_row.status='settled' then
    return jsonb_build_object('reservation_id',reservation_row.id,'status','settled','already_settled',true);
  end if;
  if reservation_row.status<>'reserved' then raise exception 'Only active reservations can be settled'; end if;

  insert into executive_visuals.credit_ledger
    (owner_id,entry_type,credit_delta,idempotency_key,job_id,reason,metadata)
  values
    (reservation_row.owner_id,'settlement',-reservation_row.credit_units,
     'credit-settlement:'||reservation_row.id::text,reservation_row.job_id,
     'Settled reserved credits after approved usage',
     jsonb_build_object('reservation_id',reservation_row.id,'original_reason',reservation_row.reason))
  on conflict(owner_id,idempotency_key) do nothing;

  update executive_visuals.credit_reservations
     set status='settled',settled_at=now(),updated_at=now()
   where id=reservation_row.id;
  return jsonb_build_object('reservation_id',reservation_row.id,'status','settled',
    'credit_units',reservation_row.credit_units,'already_settled',false);
end;
$$;
revoke all on function executive_visuals.settle_credit_reservation(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.settle_credit_reservation(uuid) to service_role;

create or replace function executive_visuals.release_credit_reservation(p_reservation_id uuid,p_reason text default 'Usage cancelled before execution')
returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, public
as $$
declare
  reservation_row executive_visuals.credit_reservations%rowtype;
begin
  if p_reservation_id is null or char_length(coalesce(p_reason,'')) not between 3 and 500 then
    raise exception 'Invalid credit release input';
  end if;
  select * into reservation_row from executive_visuals.credit_reservations
   where id=p_reservation_id for update;
  if not found then raise exception 'Credit reservation not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(reservation_row.owner_id::text,0));

  if reservation_row.status='released' then
    return jsonb_build_object('reservation_id',reservation_row.id,'status','released','already_released',true);
  end if;
  if reservation_row.status<>'reserved' then raise exception 'Settled credit reservations cannot be released'; end if;

  update executive_visuals.credit_reservations
     set status='released',released_at=now(),updated_at=now(),
         metadata=metadata||jsonb_build_object('release_reason',p_reason)
   where id=reservation_row.id;
  return jsonb_build_object('reservation_id',reservation_row.id,'status','released',
    'credit_units',reservation_row.credit_units,'already_released',false);
end;
$$;
revoke all on function executive_visuals.release_credit_reservation(uuid,text) from public,anon,authenticated;
grant execute on function executive_visuals.release_credit_reservation(uuid,text) to service_role;

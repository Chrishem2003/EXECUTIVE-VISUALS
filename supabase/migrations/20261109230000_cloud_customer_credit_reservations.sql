-- Durable customer generation-credit accounts and atomic reserve/settle RPCs.
-- This migration is additive and source-controlled. It is applied only to disposable
-- PostgreSQL CI databases until a separate production migration approval is given.

create table if not exists executive_visuals.billing_credit_accounts (
  owner_id uuid primary key references auth.users(id) on delete restrict,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists executive_visuals.billing_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  amount bigint not null check (amount <> 0),
  event_type text not null check (event_type in ('grant','admin_adjustment','generation_reserve','generation_refund','generation_settlement','expiry')),
  reference_id uuid,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  description text not null default '' check (char_length(description) <= 500),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists ev_billing_credit_ledger_owner_created
  on executive_visuals.billing_credit_ledger(owner_id, created_at desc);
create index if not exists ev_billing_credit_ledger_reference
  on executive_visuals.billing_credit_ledger(reference_id) where reference_id is not null;

create table if not exists executive_visuals.billing_credit_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  job_id uuid references executive_visuals.jobs(id) on delete restrict,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  reserved_credits bigint not null check (reserved_credits > 0),
  actual_credits bigint check (actual_credits is null or actual_credits >= 0),
  state text not null default 'reserved' check (state in ('reserved','settled','released')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  unique(job_id)
);

alter table executive_visuals.billing_credit_accounts enable row level security;
alter table executive_visuals.billing_credit_ledger enable row level security;
alter table executive_visuals.billing_credit_reservations enable row level security;
revoke all on executive_visuals.billing_credit_accounts from public, anon, authenticated;
revoke all on executive_visuals.billing_credit_ledger from public, anon, authenticated;
revoke all on executive_visuals.billing_credit_reservations from public, anon, authenticated;
grant select, insert, update on executive_visuals.billing_credit_accounts to service_role;
grant select, insert on executive_visuals.billing_credit_ledger to service_role;
grant select, insert, update on executive_visuals.billing_credit_reservations to service_role;

create or replace function executive_visuals.reject_billing_credit_ledger_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $reject_billing_credit_ledger_mutation$
begin
  raise exception 'BILLING_CREDIT_LEDGER_IS_APPEND_ONLY';
end;
$reject_billing_credit_ledger_mutation$;
revoke all on function executive_visuals.reject_billing_credit_ledger_mutation()
  from public, anon, authenticated, service_role;
drop trigger if exists ev_billing_credit_ledger_immutable on executive_visuals.billing_credit_ledger;
create trigger ev_billing_credit_ledger_immutable
before update or delete on executive_visuals.billing_credit_ledger
for each row execute function executive_visuals.reject_billing_credit_ledger_mutation();

create or replace function executive_visuals.grant_generation_credits(
  p_owner_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_description text default 'Credit grant',
  p_evidence jsonb default '{}'::jsonb
)
returns table(ledger_id uuid, balance bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $grant_generation_credits$
declare
  existing executive_visuals.billing_credit_ledger;
  new_id uuid;
  current_balance bigint;
begin
  if p_owner_id is null or p_amount is null or p_amount <= 0 or p_amount > 1000000000
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'BILLING_CREDIT_GRANT_ARGUMENTS_INVALID';
  end if;

  insert into executive_visuals.billing_credit_accounts(owner_id)
  values(p_owner_id) on conflict(owner_id) do nothing;

  perform 1 from executive_visuals.billing_credit_accounts a
  where a.owner_id = p_owner_id and a.status = 'active'
  for update;
  if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

  select * into existing from executive_visuals.billing_credit_ledger l
  where l.idempotency_key = p_idempotency_key;
  if existing.id is not null then
    if existing.owner_id <> p_owner_id or existing.amount <> p_amount
       or existing.event_type <> 'grant' or existing.evidence <> p_evidence then
      raise exception 'BILLING_CREDIT_IDEMPOTENCY_CONFLICT';
    end if;
    select coalesce(sum(l.amount),0) into current_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
    return query select existing.id,current_balance,true;
    return;
  end if;

  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,idempotency_key,description,evidence)
  values(p_owner_id,p_amount,'grant',p_idempotency_key,left(coalesce(p_description,''),500),p_evidence)
  returning id into new_id;
  update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
  where owner_id=p_owner_id;
  select coalesce(sum(l.amount),0) into current_balance
  from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
  return query select new_id,current_balance,false;
end;
$grant_generation_credits$;

create or replace function executive_visuals.reserve_generation_credits(
  p_owner_id uuid,
  p_job_id uuid,
  p_credits bigint,
  p_idempotency_key text
)
returns table(reservation_id uuid, balance bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $reserve_generation_credits$
declare
  existing executive_visuals.billing_credit_reservations;
  account_status text;
  current_balance bigint;
  new_reservation_id uuid;
begin
  if p_owner_id is null or p_job_id is null or p_credits is null or p_credits <= 0 or p_credits > 100000000
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception 'BILLING_CREDIT_RESERVATION_ARGUMENTS_INVALID';
  end if;
  if not exists(select 1 from executive_visuals.jobs j where j.id=p_job_id and j.owner_id=p_owner_id) then
    raise exception 'BILLING_JOB_OWNER_MISMATCH';
  end if;

  insert into executive_visuals.billing_credit_accounts(owner_id)
  values(p_owner_id) on conflict(owner_id) do nothing;
  select a.status into account_status
  from executive_visuals.billing_credit_accounts a
  where a.owner_id=p_owner_id for update;
  if account_status is distinct from 'active' then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

  select * into existing from executive_visuals.billing_credit_reservations r
  where r.idempotency_key=p_idempotency_key;
  if existing.id is not null then
    if existing.owner_id<>p_owner_id or existing.job_id<>p_job_id or existing.reserved_credits<>p_credits then
      raise exception 'BILLING_CREDIT_IDEMPOTENCY_CONFLICT';
    end if;
    select coalesce(sum(l.amount),0) into current_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
    return query select existing.id,current_balance,true;
    return;
  end if;

  select coalesce(sum(l.amount),0) into current_balance
  from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
  if current_balance < p_credits then raise exception 'BILLING_INSUFFICIENT_CREDITS'; end if;

  insert into executive_visuals.billing_credit_reservations(owner_id,job_id,idempotency_key,reserved_credits)
  values(p_owner_id,p_job_id,p_idempotency_key,p_credits)
  returning id into new_reservation_id;
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
  values(p_owner_id,-p_credits,'generation_reserve',p_job_id,'credit-reserve:'||p_idempotency_key,'Generation credit reservation');
  current_balance := current_balance - p_credits;
  return query select new_reservation_id,current_balance,false;
end;
$reserve_generation_credits$;

create or replace function executive_visuals.settle_generation_credit_reservation(
  p_reservation_id uuid,
  p_actual_credits bigint,
  p_evidence jsonb
)
returns table(balance bigint, adjustment bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $settle_generation_credit_reservation$
declare
  reservation executive_visuals.billing_credit_reservations;
  current_balance bigint;
  delta bigint;
begin
  if p_reservation_id is null or p_actual_credits is null or p_actual_credits < 0
     or p_actual_credits > 1000000000 or p_evidence is null
     or jsonb_typeof(p_evidence) <> 'object'
     or coalesce(p_evidence->>'provider','') = ''
     or coalesce(p_evidence->>'evidenceType','') not in
       ('provider_task_receipt','provider_invoice','provider_usage_reconciliation','verified_no_charge_cancellation')
     or coalesce(p_evidence->>'evidenceId','') = '' then
    raise exception 'BILLING_CREDIT_SETTLEMENT_EVIDENCE_INVALID';
  end if;

  select * into reservation from executive_visuals.billing_credit_reservations r
  where r.id=p_reservation_id;
  if reservation.id is null then raise exception 'BILLING_CREDIT_RESERVATION_NOT_FOUND'; end if;
  perform 1 from executive_visuals.billing_credit_accounts a
  where a.owner_id=reservation.owner_id for update;
  if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
  select * into reservation from executive_visuals.billing_credit_reservations r
  where r.id=p_reservation_id for update;

  if reservation.state='settled' then
    if reservation.actual_credits<>p_actual_credits or reservation.evidence<>p_evidence then
      raise exception 'BILLING_CREDIT_SETTLEMENT_CONFLICT';
    end if;
    select coalesce(sum(l.amount),0) into current_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=reservation.owner_id;
    return query select current_balance,reservation.reserved_credits-p_actual_credits,true;
    return;
  end if;
  if reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_SETTLEABLE'; end if;

  delta := reservation.reserved_credits - p_actual_credits;
  if delta <> 0 then
    insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description,evidence)
    values(
      reservation.owner_id,delta,
      case when delta>0 then 'generation_refund' else 'generation_settlement' end,
      reservation.job_id,'credit-settlement:'||reservation.id::text,
      'Provider-verified generation credit settlement',p_evidence
    );
  end if;
  update executive_visuals.billing_credit_reservations
  set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
  where id=reservation.id;
  update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
  where owner_id=reservation.owner_id;
  select coalesce(sum(l.amount),0) into current_balance
  from executive_visuals.billing_credit_ledger l where l.owner_id=reservation.owner_id;
  return query select current_balance,delta,false;
end;
$settle_generation_credit_reservation$;

create or replace function executive_visuals.release_generation_credit_reservation(
  p_reservation_id uuid,
  p_reason text
)
returns table(balance bigint,replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $release_generation_credit_reservation$
declare
  reservation executive_visuals.billing_credit_reservations;
  current_balance bigint;
begin
  if p_reservation_id is null or char_length(coalesce(p_reason,'')) not between 1 and 500 then
    raise exception 'BILLING_CREDIT_RELEASE_ARGUMENTS_INVALID';
  end if;
  select * into reservation from executive_visuals.billing_credit_reservations r
  where r.id=p_reservation_id;
  if reservation.id is null then raise exception 'BILLING_CREDIT_RESERVATION_NOT_FOUND'; end if;
  perform 1 from executive_visuals.billing_credit_accounts a
  where a.owner_id=reservation.owner_id for update;
  if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
  select * into reservation from executive_visuals.billing_credit_reservations r
  where r.id=p_reservation_id for update;
  if reservation.state='released' then
    select coalesce(sum(l.amount),0) into current_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=reservation.owner_id;
    return query select current_balance,true;
    return;
  end if;
  if reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_RELEASABLE'; end if;
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
  values(reservation.owner_id,reservation.reserved_credits,'generation_refund',reservation.job_id,
    'credit-release:'||reservation.id::text,left(p_reason,500));
  update executive_visuals.billing_credit_reservations set state='released',settled_at=clock_timestamp()
  where id=reservation.id;
  update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
  where owner_id=reservation.owner_id;
  select coalesce(sum(l.amount),0) into current_balance
  from executive_visuals.billing_credit_ledger l where l.owner_id=reservation.owner_id;
  return query select current_balance,false;
end;
$release_generation_credit_reservation$;

revoke all on function executive_visuals.grant_generation_credits(uuid,bigint,text,text,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text) from public,anon,authenticated;
revoke all on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.release_generation_credit_reservation(uuid,text) from public,anon,authenticated;
grant execute on function executive_visuals.grant_generation_credits(uuid,bigint,text,text,jsonb) to service_role;
grant execute on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text) to service_role;
grant execute on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb) to service_role;
grant execute on function executive_visuals.release_generation_credit_reservation(uuid,text) to service_role;

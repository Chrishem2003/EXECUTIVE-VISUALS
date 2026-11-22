-- Project-scoped shared credit pools for agency/studio production.
-- Project owners fund a pool from their personal generation-credit balance.
-- Reservations, settlement and release remain atomic with the cloud job lifecycle.
-- Additive only; apply to disposable PostgreSQL CI until separately approved.

create table if not exists executive_visuals.project_credit_pools (
  project_id uuid primary key references executive_visuals.projects(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'active' check (status in ('active','suspended')),
  monthly_spend_limit_credits bigint not null default 0
    check (monthly_spend_limit_credits between 0 and 1000000000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(project_id,owner_id)
);

create table if not exists executive_visuals.project_credit_pool_ledger (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references executive_visuals.project_credit_pools(project_id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  amount bigint not null check (amount<>0),
  event_type text not null check (event_type in ('top_up','generation_reserve','generation_refund','generation_settlement')),
  reference_id uuid,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  description text not null default '' check (char_length(description)<=500),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists ev_project_credit_pool_ledger_balance
 on executive_visuals.project_credit_pool_ledger(project_id,created_at desc);
create index if not exists ev_project_credit_pool_ledger_actor
 on executive_visuals.project_credit_pool_ledger(project_id,actor_id,created_at desc);

create table if not exists executive_visuals.project_credit_pool_reservations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references executive_visuals.project_credit_pools(project_id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  job_id uuid not null unique references executive_visuals.jobs(id) on delete restrict,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  reserved_credits bigint not null check (reserved_credits>0),
  actual_credits bigint check (actual_credits is null or actual_credits>=0),
  state text not null default 'reserved' check (state in ('reserved','settled','released')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz
);
create index if not exists ev_project_credit_pool_reservations_period
 on executive_visuals.project_credit_pool_reservations(project_id,created_at,state);

alter table executive_visuals.project_credit_pools enable row level security;
alter table executive_visuals.project_credit_pool_ledger enable row level security;
alter table executive_visuals.project_credit_pool_reservations enable row level security;
revoke all on executive_visuals.project_credit_pools from public,anon,authenticated;
revoke all on executive_visuals.project_credit_pool_ledger from public,anon,authenticated;
revoke all on executive_visuals.project_credit_pool_reservations from public,anon,authenticated;
grant select,insert,update on executive_visuals.project_credit_pools to service_role;
grant select,insert on executive_visuals.project_credit_pool_ledger to service_role;
grant select,insert,update on executive_visuals.project_credit_pool_reservations to service_role;

create or replace function executive_visuals.reject_project_credit_pool_ledger_mutation()
returns trigger language plpgsql set search_path=pg_catalog
as $$ begin raise exception 'PROJECT_CREDIT_POOL_LEDGER_IS_APPEND_ONLY'; end $$;
revoke all on function executive_visuals.reject_project_credit_pool_ledger_mutation()
 from public,anon,authenticated,service_role;
drop trigger if exists ev_project_credit_pool_ledger_immutable on executive_visuals.project_credit_pool_ledger;
create trigger ev_project_credit_pool_ledger_immutable
 before update or delete on executive_visuals.project_credit_pool_ledger
 for each row execute function executive_visuals.reject_project_credit_pool_ledger_mutation();

-- Create/adjust a pool. Only the project owner can configure shared project spend.
create or replace function executive_visuals.configure_project_credit_pool(
 p_owner_id uuid,p_project_id uuid,p_monthly_spend_limit_credits bigint default 0
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare pool executive_visuals.project_credit_pools;
begin
 if p_owner_id is null or p_project_id is null or p_monthly_spend_limit_credits is null
    or p_monthly_spend_limit_credits<0 or p_monthly_spend_limit_credits>1000000000 then
  raise exception 'PROJECT_CREDIT_POOL_ARGUMENTS_INVALID' using errcode='22023';
 end if;
 if not exists(select 1 from projects where id=p_project_id and owner_id=p_owner_id and archived_at is null) then
  raise exception 'PROJECT_CREDIT_POOL_OWNER_REQUIRED' using errcode='42501';
 end if;
 insert into project_credit_pools(project_id,owner_id,monthly_spend_limit_credits)
 values(p_project_id,p_owner_id,p_monthly_spend_limit_credits)
 on conflict(project_id) do update set monthly_spend_limit_credits=excluded.monthly_spend_limit_credits,
  status='active',updated_at=clock_timestamp()
 where project_credit_pools.owner_id=excluded.owner_id
 returning * into pool;
 if pool.project_id is null then
  raise exception 'PROJECT_CREDIT_POOL_OWNER_MISMATCH' using errcode='42501';
 end if;
 return jsonb_build_object('projectId',pool.project_id,'status',pool.status,
  'monthlySpendLimitCredits',pool.monthly_spend_limit_credits);
end $$;

-- Move credits from the owner's personal balance into one project's shared pool.
-- Both append-only ledger entries commit or roll back together.
create or replace function executive_visuals.fund_project_credit_pool(
 p_owner_id uuid,p_project_id uuid,p_credits bigint,p_idempotency_key text
) returns table(pool_balance bigint,personal_balance bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare pool project_credit_pools; existing project_credit_pool_ledger;
 current_personal bigint; current_pool bigint;
begin
 if p_owner_id is null or p_project_id is null or p_credits is null or p_credits<1 or p_credits>100000000
    or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 160 then
  raise exception 'PROJECT_CREDIT_POOL_FUND_ARGUMENTS_INVALID' using errcode='22023';
 end if;
 if not exists(select 1 from projects where id=p_project_id and owner_id=p_owner_id and archived_at is null) then
  raise exception 'PROJECT_CREDIT_POOL_OWNER_REQUIRED' using errcode='42501';
 end if;
 insert into billing_credit_accounts(owner_id) values(p_owner_id) on conflict(owner_id) do nothing;
 perform 1 from billing_credit_accounts where owner_id=p_owner_id and status='active' for update;
 if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
 select * into pool from project_credit_pools where project_id=p_project_id and owner_id=p_owner_id for update;
 if pool.project_id is null or pool.status<>'active' then raise exception 'PROJECT_CREDIT_POOL_NOT_ACTIVE'; end if;
 select * into existing from project_credit_pool_ledger where idempotency_key=p_idempotency_key;
 if existing.id is not null then
  if existing.project_id<>p_project_id or existing.owner_id<>p_owner_id or existing.actor_id<>p_owner_id
     or existing.amount<>p_credits or existing.event_type<>'top_up' then
   raise exception 'PROJECT_CREDIT_POOL_IDEMPOTENCY_CONFLICT' using errcode='23505';
  end if;
  select coalesce(sum(amount),0) into current_pool from project_credit_pool_ledger where project_id=p_project_id;
  select coalesce(sum(amount),0) into current_personal from billing_credit_ledger where owner_id=p_owner_id;
  return query select current_pool,current_personal,true; return;
 end if;
 select coalesce(sum(amount),0) into current_personal from billing_credit_ledger where owner_id=p_owner_id;
 if current_personal<p_credits then raise exception 'BILLING_INSUFFICIENT_CREDITS'; end if;
 insert into billing_credit_ledger(owner_id,amount,event_type,idempotency_key,description,evidence)
 values(p_owner_id,-p_credits,'admin_adjustment','project-pool-fund:'||md5(p_idempotency_key),
  'Transfer to project shared credit pool',jsonb_build_object('projectId',p_project_id,'transferKey',p_idempotency_key));
 insert into project_credit_pool_ledger(project_id,owner_id,actor_id,amount,event_type,idempotency_key,description,evidence)
 values(p_project_id,p_owner_id,p_owner_id,p_credits,'top_up',p_idempotency_key,
  'Owner-funded project shared credit pool',jsonb_build_object('source','personal_credit_balance'));
 select coalesce(sum(amount),0) into current_pool from project_credit_pool_ledger where project_id=p_project_id;
 select coalesce(sum(amount),0) into current_personal from billing_credit_ledger where owner_id=p_owner_id;
 return query select current_pool,current_personal,false;
end $$;

-- Replace the personal-only reservation entry point with a project-aware router.
-- Existing projects without a configured pool retain exactly the personal-wallet behavior.
create or replace function executive_visuals.reserve_generation_credits(
 p_owner_id uuid,p_job_id uuid,p_credits bigint,p_idempotency_key text
) returns table(reservation_id uuid,balance bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare job_row jobs; pool project_credit_pools; existing project_credit_pool_reservations;
 current_balance bigint; new_id uuid; used_this_month bigint;
begin
 if p_owner_id is null or p_job_id is null or p_credits is null or p_credits<=0 or p_credits>100000000
    or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
  raise exception 'BILLING_CREDIT_RESERVATION_ARGUMENTS_INVALID';
 end if;
 perform assert_video_generation_entitlement(p_owner_id);
 select * into job_row from jobs where id=p_job_id and owner_id=p_owner_id and job_type='video.generate';
 if job_row.id is null then raise exception 'BILLING_JOB_OWNER_MISMATCH'; end if;
 if job_row.project_id is not null then
  select * into pool from project_credit_pools where project_id=job_row.project_id;
 end if;
 if pool.project_id is not null then
  if pool.owner_id<>p_owner_id then raise exception 'PROJECT_CREDIT_POOL_OWNER_MISMATCH'; end if;
  select * into pool from project_credit_pools where project_id=job_row.project_id for update;
  if pool.status<>'active' then raise exception 'PROJECT_CREDIT_POOL_NOT_ACTIVE'; end if;
  select * into existing from project_credit_pool_reservations where job_id=p_job_id;
  if existing.id is null then
   select * into existing from project_credit_pool_reservations where idempotency_key=p_idempotency_key;
  end if;
  if existing.id is not null then
   if existing.project_id<>job_row.project_id or existing.owner_id<>p_owner_id
      or existing.job_id<>p_job_id or existing.reserved_credits<>p_credits
      or existing.idempotency_key<>p_idempotency_key then
    raise exception 'BILLING_CREDIT_IDEMPOTENCY_CONFLICT';
   end if;
   select coalesce(sum(amount),0) into current_balance from project_credit_pool_ledger where project_id=job_row.project_id;
   return query select existing.id,current_balance,true; return;
  end if;
  select coalesce(sum(case when state='settled' then actual_credits else reserved_credits end),0)
   into used_this_month from project_credit_pool_reservations
   where project_id=job_row.project_id and state<>'released'
    and created_at>=date_trunc('month',clock_timestamp());
  if pool.monthly_spend_limit_credits>0 and used_this_month+p_credits>pool.monthly_spend_limit_credits then
   raise exception 'PROJECT_CREDIT_POOL_MONTHLY_LIMIT_REACHED';
  end if;
  select coalesce(sum(amount),0) into current_balance from project_credit_pool_ledger where project_id=job_row.project_id;
  if current_balance<p_credits then raise exception 'BILLING_INSUFFICIENT_PROJECT_CREDITS'; end if;
  insert into project_credit_pool_reservations(project_id,owner_id,job_id,idempotency_key,reserved_credits)
  values(job_row.project_id,p_owner_id,p_job_id,p_idempotency_key,p_credits) returning id into new_id;
  insert into project_credit_pool_ledger(project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description)
  values(job_row.project_id,p_owner_id,p_owner_id,-p_credits,'generation_reserve',p_job_id,
   'project-credit-reserve:'||md5(p_idempotency_key),'Project shared credit reservation');
  -- Compatibility mirror keeps existing workflow replay/cancellation readers intact.
  insert into billing_credit_reservations(id,owner_id,job_id,idempotency_key,reserved_credits)
  values(new_id,p_owner_id,p_job_id,p_idempotency_key,p_credits);
  return query select new_id,current_balance-p_credits,false; return;
 end if;

 return query select r.reservation_id,r.balance,r.replayed
  from reserve_generation_credits_without_entitlement(p_owner_id,p_job_id,p_credits,p_idempotency_key) r;
 return;

end $;

create or replace function executive_visuals.settle_project_credit_pool_reservation(
 p_reservation_id uuid,p_actual_credits bigint,p_evidence jsonb
) returns table(balance bigint,adjustment bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare reservation project_credit_pool_reservations; current_balance bigint; delta bigint;
begin
 if p_reservation_id is null or p_actual_credits is null or p_actual_credits<0 or p_actual_credits>1000000000
    or p_evidence is null or jsonb_typeof(p_evidence)<>'object'
    or coalesce(p_evidence->>'provider','')=''
    or coalesce(p_evidence->>'evidenceType','') not in
      ('provider_task_receipt','provider_invoice','provider_usage_reconciliation','verified_no_charge_cancellation')
    or coalesce(p_evidence->>'evidenceId','')='' then
  raise exception 'BILLING_CREDIT_SETTLEMENT_EVIDENCE_INVALID';
 end if;
 select * into reservation from project_credit_pool_reservations where id=p_reservation_id;
 if reservation.id is null then raise exception 'BILLING_CREDIT_RESERVATION_NOT_FOUND'; end if;
 perform 1 from project_credit_pools where project_id=reservation.project_id for update;
 select * into reservation from project_credit_pool_reservations where id=p_reservation_id for update;
 if reservation.state='settled' then
  if reservation.actual_credits<>p_actual_credits or reservation.evidence<>p_evidence then
   raise exception 'BILLING_CREDIT_SETTLEMENT_CONFLICT';
  end if;
  select coalesce(sum(amount),0) into current_balance from project_credit_pool_ledger where project_id=reservation.project_id;
  return query select current_balance,reservation.reserved_credits-p_actual_credits,true; return;
 end if;
 if reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_SETTLEABLE'; end if;
 delta:=reservation.reserved_credits-p_actual_credits;
 if delta<>0 then
  insert into project_credit_pool_ledger(project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description,evidence)
  values(reservation.project_id,reservation.owner_id,reservation.owner_id,delta,
   case when delta>0 then 'generation_refund' else 'generation_settlement' end,
   reservation.job_id,'project-credit-settlement:'||reservation.id::text,
   'Provider-verified project generation credit settlement',p_evidence);
 end if;
 update project_credit_pool_reservations set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
 where id=reservation.id;
 update billing_credit_reservations set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp()
 where id=reservation.id;
 select coalesce(sum(amount),0) into current_balance from project_credit_pool_ledger where project_id=reservation.project_id;
 return query select current_balance,delta,false;
end $$;

-- The existing worker settlement RPC now recognizes project-pool reservations first.
create or replace function executive_visuals.settle_generation_credits_for_job(
 p_job_id uuid,p_owner_id uuid,p_provider text,p_actual_credits bigint,p_evidence jsonb
) returns table(balance bigint,adjustment bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare reservation_id uuid; job_row jobs;
begin
 if p_job_id is null or p_owner_id is null or p_provider is null or char_length(p_provider) not between 1 and 100
    or p_actual_credits is null or p_actual_credits<0 or p_actual_credits>1000000000
    or p_evidence is null or jsonb_typeof(p_evidence)<>'object'
    or p_evidence->>'provider' is distinct from p_provider
    or coalesce(p_evidence->>'evidenceType','') not in
      ('provider_task_receipt','provider_invoice','provider_usage_reconciliation','verified_no_charge_cancellation')
    or coalesce(p_evidence->>'evidenceId','')='' or coalesce(p_evidence->>'evidenceReference','')='' then
  raise exception 'BILLING_CREDIT_JOB_SETTLEMENT_ARGUMENTS_INVALID';
 end if;
 select * into job_row from jobs where id=p_job_id and owner_id=p_owner_id and job_type='video.generate';
 if job_row.id is null then raise exception 'BILLING_CREDIT_JOB_OWNER_MISMATCH'; end if;
 if coalesce(job_row.input->>'provider','')<>p_provider then raise exception 'BILLING_CREDIT_PROVIDER_MISMATCH'; end if;
 select id into reservation_id from project_credit_pool_reservations
  where job_id=p_job_id and owner_id=p_owner_id;
 if reservation_id is not null then
  return query select * from settle_project_credit_pool_reservation(reservation_id,p_actual_credits,p_evidence);
  return;
 end if;
 select id into reservation_id from billing_credit_reservations where job_id=p_job_id and owner_id=p_owner_id;
 if reservation_id is null then raise exception 'BILLING_CREDIT_JOB_RESERVATION_NOT_FOUND'; end if;
 return query select * from settle_generation_credit_reservation(reservation_id,p_actual_credits,p_evidence);
end $$;

-- Release supports both wallet types, preserving the existing cancellation RPC contract.
create or replace function executive_visuals.release_generation_credit_reservation(
 p_reservation_id uuid,p_reason text
) returns table(balance bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare pool_reservation project_credit_pool_reservations; reservation billing_credit_reservations; current_balance bigint;
begin
 if p_reservation_id is null or char_length(coalesce(p_reason,'')) not between 1 and 500 then
  raise exception 'BILLING_CREDIT_RELEASE_ARGUMENTS_INVALID';
 end if;
 select * into pool_reservation from project_credit_pool_reservations where id=p_reservation_id;
 if pool_reservation.id is not null then
  perform 1 from project_credit_pools where project_id=pool_reservation.project_id for update;
  select * into pool_reservation from project_credit_pool_reservations where id=p_reservation_id for update;
  if pool_reservation.state='released' then
   select coalesce(sum(amount),0) into current_balance from project_credit_pool_ledger where project_id=pool_reservation.project_id;
   return query select current_balance,true; return;
  end if;
  if pool_reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_RELEASABLE'; end if;
  insert into project_credit_pool_ledger(project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description)
  values(pool_reservation.project_id,pool_reservation.owner_id,pool_reservation.owner_id,
   pool_reservation.reserved_credits,'generation_refund',pool_reservation.job_id,
   'project-credit-release:'||pool_reservation.id::text,left(p_reason,500));
  update project_credit_pool_reservations set state='released',settled_at=clock_timestamp() where id=pool_reservation.id;
  update billing_credit_reservations set state='released',settled_at=clock_timestamp() where id=pool_reservation.id;
  select coalesce(sum(amount),0) into current_balance from project_credit_pool_ledger where project_id=pool_reservation.project_id;
  return query select current_balance,false; return;
 end if;
 select * into reservation from billing_credit_reservations where id=p_reservation_id;
 if reservation.id is null then raise exception 'BILLING_CREDIT_RESERVATION_NOT_FOUND'; end if;
 perform 1 from billing_credit_accounts where owner_id=reservation.owner_id for update;
 select * into reservation from billing_credit_reservations where id=p_reservation_id for update;
 if reservation.state='released' then
  select coalesce(sum(amount),0) into current_balance from billing_credit_ledger where owner_id=reservation.owner_id;
  return query select current_balance,true; return;
 end if;
 if reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_RELEASABLE'; end if;
 insert into billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
 values(reservation.owner_id,reservation.reserved_credits,'generation_refund',reservation.job_id,
  'credit-release:'||reservation.id::text,left(p_reason,500));
 update billing_credit_reservations set state='released',settled_at=clock_timestamp() where id=reservation.id;
 select coalesce(sum(amount),0) into current_balance from billing_credit_ledger where owner_id=reservation.owner_id;
 return query select current_balance,false;
end $$;

revoke all on function executive_visuals.configure_project_credit_pool(uuid,uuid,bigint) from public,anon,authenticated;
revoke all on function executive_visuals.fund_project_credit_pool(uuid,uuid,bigint,text) from public,anon,authenticated;
revoke all on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text) from public,anon,authenticated;
revoke all on function executive_visuals.settle_project_credit_pool_reservation(uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.settle_generation_credits_for_job(uuid,uuid,text,bigint,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.release_generation_credit_reservation(uuid,text) from public,anon,authenticated;
grant execute on function executive_visuals.configure_project_credit_pool(uuid,uuid,bigint) to service_role;
grant execute on function executive_visuals.fund_project_credit_pool(uuid,uuid,bigint,text) to service_role;
grant execute on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text) to service_role;
grant execute on function executive_visuals.settle_project_credit_pool_reservation(uuid,bigint,jsonb) to service_role;
grant execute on function executive_visuals.settle_generation_credits_for_job(uuid,uuid,text,bigint,jsonb) to service_role;
grant execute on function executive_visuals.release_generation_credit_reservation(uuid,text) to service_role;

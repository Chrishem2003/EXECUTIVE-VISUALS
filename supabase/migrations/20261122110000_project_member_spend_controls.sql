-- Member-level spend attribution and hard limits for owner-funded project wallets.
-- Jobs continue to be owned by the initiating user; the project's pool owner pays.
-- All spend checks serialize on the project pool row to prevent concurrent cap bypass.

alter table executive_visuals.project_credit_pool_reservations
  add column if not exists actor_id uuid references auth.users(id) on delete restrict;
update executive_visuals.project_credit_pool_reservations
  set actor_id=owner_id where actor_id is null;
alter table executive_visuals.project_credit_pool_reservations
  alter column actor_id set not null;
create index if not exists ev_project_credit_pool_reservations_actor_period
  on executive_visuals.project_credit_pool_reservations(project_id,actor_id,created_at,state);

create table if not exists executive_visuals.project_credit_pool_member_policies (
  project_id uuid not null,
  owner_id uuid not null,
  member_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'active' check(status in ('active','paused')),
  monthly_limit_credits bigint not null default 0
    check(monthly_limit_credits between 0 and 1000000000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(project_id,member_id),
  foreign key(project_id,owner_id)
    references executive_visuals.project_credit_pools(project_id,owner_id) on delete restrict,
  check(member_id<>owner_id)
);
create index if not exists ev_project_credit_pool_member_policy_owner
  on executive_visuals.project_credit_pool_member_policies(project_id,owner_id,status);
alter table executive_visuals.project_credit_pool_member_policies enable row level security;
revoke all on executive_visuals.project_credit_pool_member_policies from public,anon,authenticated;
grant select,insert,update,delete on executive_visuals.project_credit_pool_member_policies to service_role;

create or replace function executive_visuals.configure_project_credit_pool_member_policy(
 p_owner_id uuid,p_project_id uuid,p_member_id uuid,
 p_monthly_limit_credits bigint default 0,p_status text default 'active'
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare policy project_credit_pool_member_policies;
begin
 if p_owner_id is null or p_project_id is null or p_member_id is null
    or p_monthly_limit_credits is null or p_monthly_limit_credits<0 or p_monthly_limit_credits>1000000000
    or p_status is null or p_status not in ('active','paused') then
  raise exception 'PROJECT_CREDIT_POOL_MEMBER_POLICY_ARGUMENTS_INVALID' using errcode='22023';
 end if;
 if not exists(select 1 from projects where id=p_project_id and owner_id=p_owner_id) then
  raise exception 'PROJECT_CREDIT_POOL_OWNER_REQUIRED' using errcode='42501';
 end if;
 perform 1 from project_credit_pools
  where project_id=p_project_id and owner_id=p_owner_id and status='active' for update;
 if not found then raise exception 'PROJECT_CREDIT_POOL_NOT_ACTIVE'; end if;
 if p_member_id=p_owner_id or not exists(
  select 1 from project_members where project_id=p_project_id and member_id=p_member_id and role='editor'
 ) then
  raise exception 'PROJECT_CREDIT_POOL_MEMBER_NOT_ELIGIBLE' using errcode='42501';
 end if;
 insert into project_credit_pool_member_policies(project_id,owner_id,member_id,status,monthly_limit_credits)
 values(p_project_id,p_owner_id,p_member_id,p_status,p_monthly_limit_credits)
 on conflict(project_id,member_id) do update set
  status=excluded.status,monthly_limit_credits=excluded.monthly_limit_credits,updated_at=clock_timestamp()
 where project_credit_pool_member_policies.owner_id=excluded.owner_id
 returning * into policy;
 if policy.project_id is null then
  raise exception 'PROJECT_CREDIT_POOL_OWNER_MISMATCH' using errcode='42501';
 end if;
 return jsonb_build_object('projectId',policy.project_id,'memberId',policy.member_id,
  'status',policy.status,'monthlyLimitCredits',policy.monthly_limit_credits);
end $$;

create or replace function executive_visuals.list_project_credit_pool_member_usage(
 p_owner_id uuid,p_project_id uuid
) returns table(member_id uuid,role text,status text,monthly_limit_credits bigint,
 used_this_month bigint,remaining_this_month bigint)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
begin
 if p_owner_id is null or p_project_id is null then
  raise exception 'PROJECT_CREDIT_POOL_MEMBER_USAGE_ARGUMENTS_INVALID' using errcode='22023';
 end if;
 if not exists(select 1 from projects where id=p_project_id and owner_id=p_owner_id) then
  raise exception 'PROJECT_CREDIT_POOL_OWNER_REQUIRED' using errcode='42501';
 end if;
 if not exists(select 1 from project_credit_pools where project_id=p_project_id and owner_id=p_owner_id) then
  raise exception 'PROJECT_CREDIT_POOL_NOT_CONFIGURED';
 end if;
 return query
 with members as (
  select p_owner_id as member_id,'owner'::text as role
  union all
  select m.member_id,m.role from project_members m
   where m.project_id=p_project_id and m.role in ('editor','reviewer','viewer')
 ), usage as (
  select r.actor_id,
   coalesce(sum(case when r.state='settled' then r.actual_credits else r.reserved_credits end)
    filter(where r.state<>'released' and r.created_at>=date_trunc('month',clock_timestamp())),0)::bigint as used
  from project_credit_pool_reservations r where r.project_id=p_project_id group by r.actor_id
 )
 select m.member_id,m.role,coalesce(policy.status,'active'),
  case when m.role='owner' then 0 else coalesce(policy.monthly_limit_credits,0) end,
  coalesce(u.used,0)::bigint,
  case when m.role='owner' or coalesce(policy.monthly_limit_credits,0)=0 then null
   else greatest(0,policy.monthly_limit_credits-coalesce(u.used,0))::bigint end
 from members m
 left join project_credit_pool_member_policies policy
  on policy.project_id=p_project_id and policy.member_id=m.member_id
 left join usage u on u.actor_id=m.member_id
 order by case when m.role='owner' then 0 else 1 end,m.member_id;
end $$;

-- Preserve the existing RPC signature used by approved video enqueue. p_owner_id
-- is the job actor; the configured project wallet owner supplies the entitlement.
create or replace function executive_visuals.reserve_generation_credits(
 p_owner_id uuid,p_job_id uuid,p_credits bigint,p_idempotency_key text
) returns table(reservation_id uuid,balance bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare job_row jobs; pool project_credit_pools; existing project_credit_pool_reservations;
 policy project_credit_pool_member_policies; current_balance bigint; new_id uuid;
 used_this_month bigint; member_used_this_month bigint; entitlement_owner uuid;
begin
 if p_owner_id is null or p_job_id is null or p_credits is null or p_credits<=0 or p_credits>100000000
    or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
  raise exception 'BILLING_CREDIT_RESERVATION_ARGUMENTS_INVALID';
 end if;
 select * into job_row from jobs where id=p_job_id and owner_id=p_owner_id and job_type='video.generate';
 if job_row.id is null then raise exception 'BILLING_JOB_OWNER_MISMATCH'; end if;

 if job_row.project_id is not null then
  select * into pool from project_credit_pools where project_id=job_row.project_id;
 end if;
 if pool.project_id is not null then
  -- Serialize every project reservation so project and member caps cannot race.
  select * into pool from project_credit_pools where project_id=job_row.project_id for update;
  if pool.status<>'active' then raise exception 'PROJECT_CREDIT_POOL_NOT_ACTIVE'; end if;
  if not exists(select 1 from projects p where p.id=job_row.project_id and p.owner_id=p_owner_id)
     and not exists(select 1 from project_members m where m.project_id=job_row.project_id
       and m.member_id=p_owner_id and m.role='editor') then
   raise exception 'PROJECT_CREDIT_POOL_MEMBER_NOT_ALLOWED' using errcode='42501';
  end if;
  entitlement_owner:=pool.owner_id;
  perform assert_video_generation_entitlement(entitlement_owner);
  insert into billing_credit_accounts(owner_id) values(p_owner_id) on conflict(owner_id) do nothing;
  perform 1 from billing_credit_accounts where owner_id=p_owner_id and status='active' for update;
  if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

  if p_owner_id<>pool.owner_id then
   select * into policy from project_credit_pool_member_policies
    where project_id=job_row.project_id and member_id=p_owner_id for update;
   if policy.status='paused' then raise exception 'PROJECT_CREDIT_POOL_MEMBER_PAUSED'; end if;
   if policy.monthly_limit_credits>0 then
    select coalesce(sum(case when state='settled' then actual_credits else reserved_credits end),0)
     into member_used_this_month from project_credit_pool_reservations
     where project_id=job_row.project_id and actor_id=p_owner_id and state<>'released'
      and created_at>=date_trunc('month',clock_timestamp());
    if member_used_this_month+p_credits>policy.monthly_limit_credits then
     raise exception 'PROJECT_CREDIT_POOL_MEMBER_LIMIT_REACHED';
    end if;
   end if;
  end if;

  select * into existing from project_credit_pool_reservations where job_id=p_job_id;
  if existing.id is null then
   select * into existing from project_credit_pool_reservations where idempotency_key=p_idempotency_key;
  end if;
  if existing.id is not null then
   if existing.project_id<>job_row.project_id or existing.owner_id<>p_owner_id
      or existing.actor_id<>p_owner_id or existing.job_id<>p_job_id
      or existing.reserved_credits<>p_credits or existing.idempotency_key<>p_idempotency_key then
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

  insert into project_credit_pool_reservations(project_id,owner_id,actor_id,job_id,idempotency_key,reserved_credits)
  values(job_row.project_id,p_owner_id,p_owner_id,p_job_id,p_idempotency_key,p_credits) returning id into new_id;
  insert into project_credit_pool_ledger(project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description)
  values(job_row.project_id,pool.owner_id,p_owner_id,-p_credits,'generation_reserve',p_job_id,
   'project-credit-reserve:'||md5(p_idempotency_key),'Project shared credit reservation');
  -- Existing billing readers expect the initiating user as reservation owner.
  insert into billing_credit_reservations(id,owner_id,job_id,idempotency_key,reserved_credits)
  values(new_id,p_owner_id,p_job_id,p_idempotency_key,p_credits);
  return query select new_id,current_balance-p_credits,false; return;
 end if;

 perform assert_video_generation_entitlement(p_owner_id);
 return query select r.reservation_id,r.balance,r.replayed
  from reserve_generation_credits_without_entitlement(p_owner_id,p_job_id,p_credits,p_idempotency_key) r;
 return;
end $$;

create or replace function executive_visuals.settle_project_credit_pool_reservation(
 p_reservation_id uuid,p_actual_credits bigint,p_evidence jsonb
) returns table(balance bigint,adjustment bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare reservation project_credit_pool_reservations; current_balance bigint; delta bigint; pool_owner uuid;
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
 select owner_id into pool_owner from project_credit_pools where project_id=reservation.project_id for update;
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
  values(reservation.project_id,pool_owner,reservation.actor_id,delta,
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

create or replace function executive_visuals.release_generation_credit_reservation(
 p_reservation_id uuid,p_reason text
) returns table(balance bigint,replayed boolean)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare pool_reservation project_credit_pool_reservations; reservation billing_credit_reservations;
 current_balance bigint; pool_owner uuid;
begin
 if p_reservation_id is null or char_length(coalesce(p_reason,'')) not between 1 and 500 then
  raise exception 'BILLING_CREDIT_RELEASE_ARGUMENTS_INVALID';
 end if;
 select * into pool_reservation from project_credit_pool_reservations where id=p_reservation_id;
 if pool_reservation.id is not null then
  select owner_id into pool_owner from project_credit_pools where project_id=pool_reservation.project_id for update;
  select * into pool_reservation from project_credit_pool_reservations where id=p_reservation_id for update;
  if pool_reservation.state='released' then
   select coalesce(sum(amount),0) into current_balance from project_credit_pool_ledger where project_id=pool_reservation.project_id;
   return query select current_balance,true; return;
  end if;
  if pool_reservation.state<>'reserved' then raise exception 'BILLING_CREDIT_RESERVATION_NOT_RELEASABLE'; end if;
  insert into project_credit_pool_ledger(project_id,owner_id,actor_id,amount,event_type,reference_id,idempotency_key,description)
  values(pool_reservation.project_id,pool_owner,pool_reservation.actor_id,pool_reservation.reserved_credits,
   'generation_refund',pool_reservation.job_id,'project-credit-release:'||pool_reservation.id::text,left(p_reason,500));
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

revoke all on function executive_visuals.configure_project_credit_pool_member_policy(uuid,uuid,uuid,bigint,text) from public,anon,authenticated;
revoke all on function executive_visuals.list_project_credit_pool_member_usage(uuid,uuid) from public,anon,authenticated;
revoke all on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text) from public,anon,authenticated;
revoke all on function executive_visuals.settle_project_credit_pool_reservation(uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.release_generation_credit_reservation(uuid,text) from public,anon,authenticated;
grant execute on function executive_visuals.configure_project_credit_pool_member_policy(uuid,uuid,uuid,bigint,text) to service_role;
grant execute on function executive_visuals.list_project_credit_pool_member_usage(uuid,uuid) to service_role;
grant execute on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text) to service_role;
grant execute on function executive_visuals.settle_project_credit_pool_reservation(uuid,bigint,jsonb) to service_role;
grant execute on function executive_visuals.release_generation_credit_reservation(uuid,text) to service_role;

-- Runway router approval bridge to the existing PostgreSQL budget/job transaction.
-- Source-controlled only. Do not apply to shared staging or production without an approved target.
-- No provider calls, task creation, or paid execution are enabled by this migration.

create table if not exists executive_visuals.runway_router_approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  config_id text not null check (config_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  provider text not null check (provider = 'runway'),
  model text not null check (model = 'gen4.5'),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  estimated_credits bigint not null check (estimated_credits >= 0),
  max_estimated_credits bigint not null check (max_estimated_credits >= estimated_credits),
  state text not null default 'pending_approval'
    check (state in ('pending_approval','approved','consumed','revoked','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  consumed_at timestamptz,
  check (expires_at > created_at),
  check ((state = 'approved') = (approved_by is not null and approved_at is not null)
      or state in ('consumed','revoked','expired')),
  check ((state = 'consumed') = (consumed_at is not null)
      or state in ('revoked','expired'))
);

create index if not exists ev_runway_router_approvals_owner_created
  on executive_visuals.runway_router_approvals(owner_id, created_at desc);
create index if not exists ev_runway_router_approvals_expiry
  on executive_visuals.runway_router_approvals(state, expires_at);

alter table executive_visuals.runway_router_approvals enable row level security;
revoke all on executive_visuals.runway_router_approvals from public, anon, authenticated;
grant select on executive_visuals.runway_router_approvals to authenticated;
grant all privileges on executive_visuals.runway_router_approvals to service_role;

alter table executive_visuals.video_generation_budget_approvals
  add column if not exists router_approval_id uuid,
  add column if not exists router_input_hash text;

do $fk$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ev_video_budget_approval_router_fk'
      and conrelid = 'executive_visuals.video_generation_budget_approvals'::regclass
  ) then
    alter table executive_visuals.video_generation_budget_approvals
      add constraint ev_video_budget_approval_router_fk
      foreign key (router_approval_id)
      references executive_visuals.runway_router_approvals(id);
  end if;
end
$fk$;

create policy ev_runway_router_approval_read
  on executive_visuals.runway_router_approvals for select to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id = runway_router_approvals.project_id
        and m.member_id = (select auth.uid())
        and m.role = 'reviewer'
    )
  );

-- Service-side record step: persist the exact router decision and its matching
-- ordinary budget approval. Both inserts commit or roll back together.
create or replace function executive_visuals.record_runway_router_preflight(
  p_owner_id uuid,
  p_project_id uuid,
  p_config_id text,
  p_input_hash text,
  p_request_hash text,
  p_estimated_credits bigint,
  p_max_estimated_credits bigint,
  p_approved_max_amount numeric,
  p_currency text default 'USD',
  p_ttl_seconds integer default 900
)
returns table(router_approval_id uuid, budget_approval_id uuid, expires_at timestamptz)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $record_runway_preflight$
declare
  v_router_id uuid;
  v_budget_id uuid;
  v_expires timestamptz;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'RUNWAY_PREFLIGHT_SERVICE_ROLE_REQUIRED';
  end if;
  if p_owner_id is null
     or p_config_id is null or p_config_id !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$'
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_estimated_credits is null or p_estimated_credits < 0
     or p_max_estimated_credits is null or p_max_estimated_credits < p_estimated_credits
     or p_approved_max_amount is null or p_approved_max_amount <= 0
     or p_currency <> 'USD'
     or p_ttl_seconds is null or p_ttl_seconds not between 60 and 900 then
    raise exception 'RUNWAY_PREFLIGHT_ARGUMENTS_INVALID';
  end if;
  if p_project_id is not null and not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'RUNWAY_PREFLIGHT_PROJECT_FORBIDDEN';
  end if;

  v_expires := clock_timestamp() + make_interval(secs => p_ttl_seconds);
  insert into executive_visuals.runway_router_approvals(
    owner_id, project_id, config_id, provider, model, input_hash, request_hash,
    estimated_credits, max_estimated_credits, expires_at
  ) values (
    p_owner_id, p_project_id, p_config_id, 'runway', 'gen4.5', p_input_hash,
    p_request_hash, p_estimated_credits, p_max_estimated_credits, v_expires
  ) returning id into v_router_id;

  insert into executive_visuals.video_generation_budget_approvals(
    owner_id, project_id, provider, model, request_hash, currency,
    approved_max_amount, approval_note, expires_at, router_approval_id, router_input_hash
  ) values (
    p_owner_id, p_project_id, 'runway', 'gen4.5', p_request_hash, p_currency,
    p_approved_max_amount, 'Runway Model Router preflight ' || v_router_id::text,
    v_expires, v_router_id, p_input_hash
  ) returning id into v_budget_id;

  return query select v_router_id, v_budget_id, v_expires;
end;
$record_runway_preflight$;

revoke all on function executive_visuals.record_runway_router_preflight(uuid,uuid,text,text,text,bigint,bigint,numeric,text,integer)
  from public, anon, authenticated;
grant execute on function executive_visuals.record_runway_router_preflight(uuid,uuid,text,text,text,bigint,bigint,numeric,text,integer)
  to service_role;

-- Human approval is performed by the project owner or a project reviewer.
-- The RPC is deliberately narrow: callers cannot edit the decision payload.
create or replace function executive_visuals.approve_runway_router_preflight(p_approval_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $approve_runway_preflight$
declare
  v_row record;
  v_actor uuid := auth.uid();
begin
  if v_actor is null or p_approval_id is null then
    raise exception 'RUNWAY_APPROVAL_ACTOR_REQUIRED';
  end if;
  select * into v_row
  from executive_visuals.runway_router_approvals
  where id = p_approval_id
  for update;
  if not found then raise exception 'RUNWAY_APPROVAL_NOT_FOUND'; end if;
  if not (
    v_row.owner_id = v_actor
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id = v_row.project_id
        and m.member_id = v_actor
        and m.role = 'reviewer'
    )
  ) then
    raise exception 'RUNWAY_APPROVAL_ACTOR_FORBIDDEN';
  end if;
  if v_row.state <> 'pending_approval' then
    raise exception 'RUNWAY_APPROVAL_STATE_INVALID';
  end if;
  if v_row.expires_at <= clock_timestamp() then
    update executive_visuals.runway_router_approvals
      set state = 'expired' where id = p_approval_id;
    raise exception 'RUNWAY_APPROVAL_EXPIRED';
  end if;
  update executive_visuals.runway_router_approvals
    set state = 'approved', approved_by = v_actor, approved_at = clock_timestamp()
    where id = p_approval_id and state = 'pending_approval';
  if not found then raise exception 'RUNWAY_APPROVAL_STATE_INVALID'; end if;
  return true;
end;
$approve_runway_preflight$;

revoke all on function executive_visuals.approve_runway_router_preflight(uuid)
  from public, anon;
grant execute on function executive_visuals.approve_runway_router_preflight(uuid)
  to authenticated;

-- A queued Runway job must carry the exact approved router identity and hashes.
-- This trigger runs inside enqueue_video_generation_job's transaction.
create or replace function executive_visuals.validate_runway_router_job_binding()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $validate_runway_job$
declare
  v_router executive_visuals.runway_router_approvals;
  v_budget executive_visuals.video_generation_budget_approvals;
  v_router_id uuid;
  v_budget_id uuid;
begin
  if new.job_type <> 'video.generate' or coalesce(new.input ->> 'provider','') <> 'runway' then
    return new;
  end if;
  begin
    v_router_id := (new.input ->> 'routerApprovalId')::uuid;
    v_budget_id := (new.input ->> 'budgetApprovalId')::uuid;
  exception when others then
    raise exception 'RUNWAY_JOB_APPROVAL_BINDING_REQUIRED';
  end;

  select * into v_router
  from executive_visuals.runway_router_approvals
  where id = v_router_id
  for update;
  select * into v_budget
  from executive_visuals.video_generation_budget_approvals
  where id = v_budget_id
  for update;

  if v_router.id is null or v_budget.id is null
     or v_router.state <> 'approved'
     or v_router.expires_at <= clock_timestamp()
     or v_router.approved_by is null
     or v_router.owner_id is distinct from new.owner_id
     or v_router.project_id is distinct from new.project_id
     or v_router.provider <> 'runway'
     or v_router.model <> coalesce(new.input ->> 'model','')
     or v_router.input_hash <> coalesce(new.input ->> 'routerInputHash','')
     or v_router.config_id <> coalesce(new.input ->> 'routerConfigId','')
     or v_router.request_hash <> coalesce(new.input ->> 'requestHash','')
     or v_budget.router_approval_id is distinct from v_router.id
     or v_budget.router_input_hash is distinct from v_router.input_hash
     or v_budget.owner_id is distinct from new.owner_id
     or v_budget.project_id is distinct from new.project_id
     or v_budget.request_hash <> v_router.request_hash then
    raise exception 'RUNWAY_JOB_APPROVAL_BINDING_INVALID';
  end if;
  return new;
end;
$validate_runway_job$;

drop trigger if exists ev_runway_router_job_binding on executive_visuals.jobs;
create trigger ev_runway_router_job_binding
  before insert on executive_visuals.jobs
  for each row execute function executive_visuals.validate_runway_router_job_binding();

-- Budget approval consumption and router approval consumption are one database
-- transaction. If this check fails, the enqueue transaction rolls back entirely.
create or replace function executive_visuals.consume_runway_router_approval()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $consume_runway_approval$
declare
  v_router executive_visuals.runway_router_approvals;
begin
  if old.consumed_at is null and new.consumed_at is not null
     and new.provider = 'runway' then
    select * into v_router
    from executive_visuals.runway_router_approvals
    where id = new.router_approval_id
    for update;
    if v_router.id is null
       or v_router.state <> 'approved'
       or v_router.expires_at <= clock_timestamp()
       or v_router.owner_id is distinct from new.owner_id
       or v_router.project_id is distinct from new.project_id
       or v_router.request_hash <> new.request_hash
       or v_router.input_hash <> coalesce(new.router_input_hash,'') then
      raise exception 'RUNWAY_APPROVAL_CONSUMPTION_INVALID';
    end if;
    update executive_visuals.runway_router_approvals
      set state = 'consumed', consumed_at = clock_timestamp()
      where id = v_router.id and state = 'approved';
    if not found then raise exception 'RUNWAY_APPROVAL_STATE_INVALID'; end if;
  end if;
  return new;
end;
$consume_runway_approval$;

drop trigger if exists ev_consume_runway_router_approval
  on executive_visuals.video_generation_budget_approvals;
create trigger ev_consume_runway_router_approval
  before update of consumed_at on executive_visuals.video_generation_budget_approvals
  for each row execute function executive_visuals.consume_runway_router_approval();

-- The existing budget approval trigger must permit the trusted service-role
-- preflight RPC while retaining the authenticated owner check for direct writes.
create or replace function executive_visuals.validate_video_budget_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $validate_budget_approval$
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and new.owner_id is distinct from auth.uid() then
    raise exception 'VIDEO_BUDGET_APPROVAL_OWNER_INVALID';
  end if;
  new.created_at := clock_timestamp();
  new.consumed_at := null;
  if new.expires_at <= clock_timestamp()
     or new.expires_at > clock_timestamp() + interval '15 minutes' then
    raise exception 'VIDEO_BUDGET_APPROVAL_EXPIRY_INVALID';
  end if;
  return new;
end;
$validate_budget_approval$;

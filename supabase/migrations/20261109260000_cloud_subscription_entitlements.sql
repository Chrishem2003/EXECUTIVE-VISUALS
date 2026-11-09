-- Cloud subscription entitlements and period-based credit grants.
-- Draft plan catalogue is not a checkout offer. No prices or live payment credentials are set.
create table if not exists executive_visuals.billing_plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_-]{1,40}$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  billing_interval text not null check (billing_interval in ('month','year','one_time')),
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  currency text not null default 'UGX' check (currency ~ '^[A-Z]{3}$'),
  credits_per_period bigint not null default 0 check (credits_per_period between 0 and 1000000000),
  entitlements jsonb not null default '{}'::jsonb check (jsonb_typeof(entitlements)='object'),
  limits jsonb not null default '{}'::jsonb check (jsonb_typeof(limits)='object'),
  active boolean not null default true,
  checkout_enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists executive_visuals.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  plan_code text not null references executive_visuals.billing_plans(code) on delete restrict,
  status text not null check (status in ('trialing','active','past_due','paused','cancelled','expired','superseded')),
  provider text not null default 'manual' check (provider in ('manual','flutterwave','dodo')),
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  grace_until timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (current_period_end > current_period_start),
  unique(provider,provider_subscription_id)
);
create index if not exists ev_billing_subscriptions_owner_state
  on executive_visuals.billing_subscriptions(owner_id,status,current_period_end desc);
create index if not exists ev_billing_subscriptions_provider_lookup
  on executive_visuals.billing_subscriptions(provider,provider_customer_id);

create table if not exists executive_visuals.billing_subscription_period_grants (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references executive_visuals.billing_subscriptions(id) on delete restrict,
  period_start timestamptz not null,
  ledger_id uuid not null unique references executive_visuals.billing_credit_ledger(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique(subscription_id,period_start)
);
alter table executive_visuals.billing_plans enable row level security;
alter table executive_visuals.billing_subscriptions enable row level security;
alter table executive_visuals.billing_subscription_period_grants enable row level security;
revoke all on executive_visuals.billing_plans,executive_visuals.billing_subscriptions,
  executive_visuals.billing_subscription_period_grants from public,anon,authenticated;
grant select,insert,update on executive_visuals.billing_plans to service_role;
grant select,insert,update on executive_visuals.billing_subscriptions to service_role;
grant select,insert on executive_visuals.billing_subscription_period_grants to service_role;

insert into executive_visuals.billing_plans(code,display_name,billing_interval,amount_minor,currency,credits_per_period,entitlements,limits,active,checkout_enabled)
values
 ('free','Free','month',null,'UGX',0,
  '{"local_editing":true,"video_generation":false,"image_generation":false,"team_collaboration":false,"admin_analytics":false}'::jsonb,
  '{"seats":1,"projects":2,"storage_bytes":268435456,"concurrent_generations":0}'::jsonb,true,false),
 ('creator','Creator','month',null,'UGX',0,
  '{"local_editing":true,"video_generation":true,"image_generation":true,"team_collaboration":false,"admin_analytics":false}'::jsonb,
  '{"seats":1,"projects":20,"storage_bytes":5368709120,"concurrent_generations":1}'::jsonb,true,false),
 ('studio','Studio','month',null,'UGX',0,
  '{"local_editing":true,"video_generation":true,"image_generation":true,"team_collaboration":true,"admin_analytics":false}'::jsonb,
  '{"seats":5,"projects":100,"storage_bytes":53687091200,"concurrent_generations":3}'::jsonb,true,false),
 ('enterprise','Enterprise','year',null,'UGX',0,
  '{"local_editing":true,"video_generation":true,"image_generation":true,"team_collaboration":true,"admin_analytics":true}'::jsonb,
  '{"seats":50,"projects":1000,"storage_bytes":536870912000,"concurrent_generations":10}'::jsonb,true,false)
on conflict(code) do nothing;

create or replace function executive_visuals.ensure_default_generation_subscription()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog,executive_visuals
as $ensure_default_generation_subscription$
begin
  insert into executive_visuals.billing_subscriptions(
    owner_id,plan_code,status,provider,current_period_start,current_period_end,metadata
  )
  values(
    new.owner_id,'free','active','manual',clock_timestamp(),
    clock_timestamp()+interval '10 years','{"provisioned":"default-free"}'::jsonb
  )
  on conflict do nothing;
  return new;
end;
$ensure_default_generation_subscription$;
revoke all on function executive_visuals.ensure_default_generation_subscription() from public,anon,authenticated,service_role;
drop trigger if exists ev_billing_default_subscription on executive_visuals.billing_credit_accounts;
create trigger ev_billing_default_subscription
after insert on executive_visuals.billing_credit_accounts
for each row execute function executive_visuals.ensure_default_generation_subscription();

insert into executive_visuals.billing_subscriptions(owner_id,plan_code,status,provider,current_period_start,current_period_end,metadata)
select a.owner_id,'free','active','manual',clock_timestamp(),clock_timestamp()+interval '10 years',
       '{"provisioned":"migration-default-free"}'::jsonb
from executive_visuals.billing_credit_accounts a
where not exists(select 1 from executive_visuals.billing_subscriptions s where s.owner_id=a.owner_id
  and s.status in ('trialing','active','past_due') and s.current_period_end>clock_timestamp())
on conflict do nothing;

create or replace function executive_visuals.activate_generation_subscription(
  p_owner_id uuid,
  p_plan_code text,
  p_provider text,
  p_provider_customer_id text,
  p_provider_subscription_id text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_status text default 'active',
  p_metadata jsonb default '{}'::jsonb
)
returns table(subscription_id uuid,replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog,executive_visuals
as $activate_generation_subscription$
declare
  plan_row executive_visuals.billing_plans;
  existing executive_visuals.billing_subscriptions;
  new_id uuid;
begin
  if p_owner_id is null or p_plan_code is null or p_provider is null or p_provider not in ('manual','flutterwave','dodo')
     or p_period_start is null or p_period_end is null or p_period_end<=p_period_start
     or p_status is null or p_status not in ('trialing','active','past_due')
     or p_metadata is null or jsonb_typeof(p_metadata)<>'object'
     or (p_provider<>'manual' and coalesce(p_provider_subscription_id,'')='')
     or char_length(coalesce(p_provider_customer_id,''))>200
     or char_length(coalesce(p_provider_subscription_id,''))>200 then
    raise exception 'BILLING_SUBSCRIPTION_ARGUMENTS_INVALID';
  end if;
  select * into plan_row from executive_visuals.billing_plans p
  where p.code=p_plan_code and p.active=true;
  if plan_row.code is null then raise exception 'BILLING_PLAN_NOT_ACTIVE'; end if;

  if p_provider_subscription_id is not null then
    select * into existing from executive_visuals.billing_subscriptions s
    where s.provider=p_provider and s.provider_subscription_id=p_provider_subscription_id
    for update;
    if existing.id is not null then
      if existing.owner_id<>p_owner_id or existing.plan_code<>p_plan_code
         or existing.current_period_start<>p_period_start or existing.current_period_end<>p_period_end then
        raise exception 'BILLING_SUBSCRIPTION_IDEMPOTENCY_CONFLICT';
      end if;
      return query select existing.id,true;
      return;
    end if;
  end if;

  insert into executive_visuals.billing_credit_accounts(owner_id) values(p_owner_id) on conflict do nothing;
  perform 1 from executive_visuals.billing_credit_accounts a where a.owner_id=p_owner_id and a.status='active' for update;
  if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

  update executive_visuals.billing_subscriptions s
  set status='superseded',updated_at=clock_timestamp()
  where s.owner_id=p_owner_id and s.status in ('trialing','active','past_due')
    and s.current_period_end>clock_timestamp();

  insert into executive_visuals.billing_subscriptions(
    owner_id,plan_code,status,provider,provider_customer_id,provider_subscription_id,
    current_period_start,current_period_end,metadata
  ) values(
    p_owner_id,p_plan_code,p_status,p_provider,p_provider_customer_id,p_provider_subscription_id,
    p_period_start,p_period_end,p_metadata
  ) returning id into new_id;
  return query select new_id,false;
end;
$activate_generation_subscription$;
revoke all on function executive_visuals.activate_generation_subscription(uuid,text,text,text,text,timestamptz,timestamptz,text,jsonb)
 from public,anon,authenticated;
grant execute on function executive_visuals.activate_generation_subscription(uuid,text,text,text,text,timestamptz,timestamptz,text,jsonb)
 to service_role;

create or replace function executive_visuals.grant_subscription_period_credits(
  p_subscription_id uuid,
  p_period_start timestamptz
)
returns table(ledger_id uuid,balance bigint,replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog,executive_visuals
as $grant_subscription_period_credits$
declare
  subscription_row executive_visuals.billing_subscriptions;
  plan_row executive_visuals.billing_plans;
  account_status text;
  existing executive_visuals.billing_subscription_period_grants;
  new_ledger_id uuid;
  amount bigint;
  current_balance bigint;
  key text;
begin
  if p_subscription_id is null or p_period_start is null then
    raise exception 'BILLING_PERIOD_GRANT_ARGUMENTS_INVALID';
  end if;
  select * into subscription_row from executive_visuals.billing_subscriptions s
  where s.id=p_subscription_id for update;
  if subscription_row.id is null or subscription_row.current_period_start<>p_period_start
     or subscription_row.status not in ('trialing','active')
     or subscription_row.current_period_end<=clock_timestamp() then
    raise exception 'BILLING_SUBSCRIPTION_PERIOD_NOT_ELIGIBLE';
  end if;
  select * into plan_row from executive_visuals.billing_plans p
  where p.code=subscription_row.plan_code and p.active=true;
  if plan_row.code is null or plan_row.credits_per_period<=0 then
    raise exception 'BILLING_PLAN_CREDITS_NOT_CONFIGURED';
  end if;
  select a.status into account_status from executive_visuals.billing_credit_accounts a
  where a.owner_id=subscription_row.owner_id for update;
  if account_status is distinct from 'active' then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

  select * into existing from executive_visuals.billing_subscription_period_grants g
  where g.subscription_id=p_subscription_id and g.period_start=p_period_start;
  if existing.id is not null then
    select coalesce(sum(l.amount),0) into current_balance from executive_visuals.billing_credit_ledger l
    where l.owner_id=subscription_row.owner_id;
    return query select existing.ledger_id,current_balance,true;
    return;
  end if;

  amount:=plan_row.credits_per_period;
  key:='subscription-period:'||p_subscription_id::text||':'||to_char(p_period_start at time zone 'UTC','YYYYMMDD"T"HH24MISS.US"Z"');
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description,evidence)
  values(subscription_row.owner_id,amount,'grant',p_subscription_id,key,
    'Subscription period credit allocation',
    jsonb_build_object('subscriptionId',p_subscription_id,'planCode',plan_row.code,'periodStart',p_period_start))
  returning id into new_ledger_id;
  insert into executive_visuals.billing_subscription_period_grants(subscription_id,period_start,ledger_id)
  values(p_subscription_id,p_period_start,new_ledger_id);
  update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
  where owner_id=subscription_row.owner_id;
  select coalesce(sum(l.amount),0) into current_balance from executive_visuals.billing_credit_ledger l
  where l.owner_id=subscription_row.owner_id;
  return query select new_ledger_id,current_balance,false;
end;
$grant_subscription_period_credits$;
revoke all on function executive_visuals.grant_subscription_period_credits(uuid,timestamptz)
 from public,anon,authenticated;
grant execute on function executive_visuals.grant_subscription_period_credits(uuid,timestamptz)
 to service_role;

-- Enforce plan entitlements at the same atomic point as customer-credit reservation.
create or replace function executive_visuals.reserve_generation_credits(
  p_owner_id uuid,
  p_job_id uuid,
  p_credits bigint,
  p_idempotency_key text
)
returns table(reservation_id uuid,balance bigint,replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog,executive_visuals
as $reserve_generation_credits$
declare
  existing executive_visuals.billing_credit_reservations;
  account_status text;
  current_balance bigint;
  new_reservation_id uuid;
  job_type text;
  allowed boolean;
begin
  if p_owner_id is null or p_job_id is null or p_credits is null or p_credits<=0 or p_credits>100000000
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception 'BILLING_CREDIT_RESERVATION_ARGUMENTS_INVALID';
  end if;
  select j.job_type into job_type from executive_visuals.jobs j where j.id=p_job_id and j.owner_id=p_owner_id;
  if job_type is null then raise exception 'BILLING_JOB_OWNER_MISMATCH'; end if;

  insert into executive_visuals.billing_credit_accounts(owner_id) values(p_owner_id) on conflict(owner_id) do nothing;
  select a.status into account_status from executive_visuals.billing_credit_accounts a
  where a.owner_id=p_owner_id for update;
  if account_status is distinct from 'active' then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;

  select * into existing from executive_visuals.billing_credit_reservations r where r.idempotency_key=p_idempotency_key;
  if existing.id is not null then
    if existing.owner_id<>p_owner_id or existing.job_id<>p_job_id or existing.reserved_credits<>p_credits then
      raise exception 'BILLING_CREDIT_IDEMPOTENCY_CONFLICT';
    end if;
    select coalesce(sum(l.amount),0) into current_balance from executive_visuals.billing_credit_ledger l
    where l.owner_id=p_owner_id;
    return query select existing.id,current_balance,true;
    return;
  end if;

  select exists(
    select 1 from executive_visuals.billing_subscriptions s
    join executive_visuals.billing_plans p on p.code=s.plan_code
    where s.owner_id=p_owner_id and p.active=true
      and coalesce((p.entitlements->>'video_generation')::boolean,false)=true
      and ((s.status in ('trialing','active') and s.current_period_end>clock_timestamp())
        or (s.status='past_due' and coalesce(s.grace_until,s.current_period_end)>clock_timestamp()))
  ) into allowed;
  if job_type='video.generate' and not allowed then
    raise exception 'BILLING_PLAN_VIDEO_GENERATION_NOT_ENTITLED';
  end if;

  select coalesce(sum(l.amount),0) into current_balance from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
  if current_balance<p_credits then raise exception 'BILLING_INSUFFICIENT_CREDITS'; end if;
  insert into executive_visuals.billing_credit_reservations(owner_id,job_id,idempotency_key,reserved_credits)
  values(p_owner_id,p_job_id,p_idempotency_key,p_credits) returning id into new_reservation_id;
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
  values(p_owner_id,-p_credits,'generation_reserve',p_job_id,'credit-reserve:'||p_idempotency_key,'Generation credit reservation');
  current_balance:=current_balance-p_credits;
  return query select new_reservation_id,current_balance,false;
end;
$reserve_generation_credits$;
revoke all on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
 from public,anon,authenticated;
grant execute on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
 to service_role;

-- Batch 6: subscription lifecycle and immutable entitlement snapshots.
-- No paid plans are activated and no recurring provider charges are initiated.
create table if not exists executive_visuals.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  plan_code text not null unique check (plan_code ~ '^[a-z][a-z0-9_-]{1,63}$'),
  name text not null check (char_length(name) between 2 and 100),
  description text not null default '',
  status text not null default 'draft' check (status in ('draft','active','archived')),
  billing_interval text not null default 'none' check (billing_interval in ('none','monthly','yearly')),
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'UGX' check (currency ~ '^[A-Z]{3}$'),
  included_credits bigint not null default 0 check (included_credits >= 0),
  entitlements jsonb not null default '{}'::jsonb check (jsonb_typeof(entitlements)='object'),
  is_public boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((billing_interval='none' and amount_minor=0) or billing_interval<>'none')
);
create index if not exists subscription_plans_public_idx
  on executive_visuals.subscription_plans(status,is_public,billing_interval);

insert into executive_visuals.subscription_plans
  (plan_code,name,description,status,billing_interval,amount_minor,currency,included_credits,entitlements,is_public)
values
  ('free','Free','Basic workspace access; paid generations are not included.','active','none',0,'UGX',0,
   '{"projects":3,"storage_bytes":536870912,"team_seats":1,"timeline_editor":true,"collaboration":false,"commercial_exports":false,"ai_generation":false}'::jsonb,true)
on conflict(plan_code) do nothing;

create table if not exists executive_visuals.customer_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  plan_id uuid not null references executive_visuals.subscription_plans(id) on delete restrict,
  plan_code text not null,
  plan_version integer not null check (plan_version > 0),
  status text not null check (status in ('pending','trialing','active','past_due','cancelled','expired','suspended')),
  billing_interval text not null check (billing_interval in ('none','monthly','yearly')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  included_credits bigint not null check (included_credits >= 0),
  entitlements_snapshot jsonb not null check (jsonb_typeof(entitlements_snapshot)='object'),
  provider text check (provider is null or provider in ('flutterwave')),
  provider_subscription_id text,
  customer_email text,
  current_period_start timestamptz not null,
  current_period_end timestamptz,
  grace_until timestamptz,
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  granted_by uuid references auth.users(id),
  grant_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_period_end is null or current_period_end>current_period_start),
  check ((status='active' and current_period_end is not null) or status<>'active')
);
create unique index if not exists customer_subscriptions_provider_id_uq
  on executive_visuals.customer_subscriptions(provider,provider_subscription_id)
  where provider_subscription_id is not null;
create index if not exists customer_subscriptions_owner_period_idx
  on executive_visuals.customer_subscriptions(owner_id,current_period_end desc,created_at desc);
create unique index if not exists customer_subscriptions_one_current_idx
  on executive_visuals.customer_subscriptions(owner_id)
  where status in ('trialing','active','past_due','pending');

-- Preserve signed provider subscription callbacks that cannot yet be mapped
-- to a local subscription; never silently discard cancellation or renewal signals.
alter table executive_visuals.payment_webhook_events
  drop constraint if exists payment_webhook_events_processing_status_check;
alter table executive_visuals.payment_webhook_events
  add constraint payment_webhook_events_processing_status_check
  check (processing_status in ('received','processing','processed','ignored','failed','needs_review'));

create table if not exists executive_visuals.subscription_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references executive_visuals.customer_subscriptions(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  actor_id uuid references auth.users(id),
  event_type text not null check (event_type in ('created','activated','renewed','payment_failed','grace_started','cancelled','expired','suspended','plan_changed','admin_granted')),
  source text not null check (source in ('system','flutterwave','admin')),
  reason text,
  event_data jsonb not null default '{}'::jsonb check (jsonb_typeof(event_data)='object'),
  created_at timestamptz not null default now()
);
create index if not exists subscription_events_owner_created_idx
  on executive_visuals.subscription_events(owner_id,created_at desc);

alter table executive_visuals.subscription_plans enable row level security;
alter table executive_visuals.customer_subscriptions enable row level security;
alter table executive_visuals.subscription_events enable row level security;

revoke all on executive_visuals.subscription_plans,
  executive_visuals.customer_subscriptions,
  executive_visuals.subscription_events from anon,authenticated;

grant select on executive_visuals.subscription_plans to authenticated;
grant select on executive_visuals.customer_subscriptions,
  executive_visuals.subscription_events to authenticated;

create policy ev_subscription_plans_public_read
  on executive_visuals.subscription_plans for select to authenticated
  using (status='active' and is_public=true);
create policy ev_customer_subscriptions_owner_read
  on executive_visuals.customer_subscriptions for select to authenticated
  using (owner_id=(select auth.uid()));
create policy ev_subscription_events_owner_read
  on executive_visuals.subscription_events for select to authenticated
  using (owner_id=(select auth.uid()));

create or replace function executive_visuals.grant_customer_subscription(
  p_actor_id uuid,
  p_owner_id uuid,
  p_plan_code text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  actor_role text;
  plan_row executive_visuals.subscription_plans%rowtype;
  new_id uuid;
begin
  select role into actor_role from executive_visuals.platform_admins where user_id=p_actor_id;
  if actor_role is null or actor_role not in ('owner','platform_admin','billing_admin') then
    raise exception 'Billing administrator role required' using errcode='42501';
  end if;
  if p_owner_id is null or p_plan_code is null or p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'Invalid subscription grant input' using errcode='22023';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end<=p_period_start or p_period_end>p_period_start+interval '366 days' then
    raise exception 'Subscription grant period must be positive and no longer than 366 days' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));
  select * into plan_row from executive_visuals.subscription_plans
   where plan_code=p_plan_code and status='active' and is_public=true for share;
  if plan_row.id is null then
    raise exception 'Subscription plan is not active or publicly assignable' using errcode='22023';
  end if;
  if exists(select 1 from executive_visuals.customer_subscriptions
    where owner_id=p_owner_id and status in ('trialing','active','past_due','pending')) then
    raise exception 'Customer already has a current subscription' using errcode='23505';
  end if;
  insert into executive_visuals.customer_subscriptions(
    owner_id,plan_id,plan_code,plan_version,status,billing_interval,amount_minor,currency,
    included_credits,entitlements_snapshot,provider,current_period_start,current_period_end,
    granted_by,grant_reason
  ) values (
    p_owner_id,plan_row.id,plan_row.plan_code,plan_row.version,'active',
    plan_row.billing_interval,plan_row.amount_minor,plan_row.currency,
    plan_row.included_credits,plan_row.entitlements,null,p_period_start,p_period_end,
    p_actor_id,btrim(p_reason)
  ) returning id into new_id;
  insert into executive_visuals.subscription_events(
    subscription_id,owner_id,actor_id,event_type,source,reason,event_data
  ) values (
    new_id,p_owner_id,p_actor_id,'admin_granted','admin',btrim(p_reason),
    jsonb_build_object('plan_code',plan_row.plan_code,'plan_version',plan_row.version,
      'period_start',p_period_start,'period_end',p_period_end)
  );
  return new_id;
end;
$$;
revoke all on function executive_visuals.grant_customer_subscription(uuid,uuid,text,timestamptz,timestamptz,text) from public,anon,authenticated;\ngrant execute on function executive_visuals.grant_customer_subscription(uuid,uuid,text,timestamptz,timestamptz,text) to service_role;

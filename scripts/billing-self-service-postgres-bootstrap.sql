create extension if not exists pgcrypto;
create schema if not exists auth;
create schema if not exists executive_visuals;
do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
create table auth.users(id uuid primary key);

create table executive_visuals.subscription_plans(
 id uuid primary key default gen_random_uuid(),
 plan_code text not null unique,
 version integer not null default 1,
 status text not null,
 is_public boolean not null default true,
 billing_interval text not null,
 amount_minor bigint not null,
 currency text not null,
 included_credits bigint not null default 0,
 entitlements jsonb not null default '{}'::jsonb
);
create table executive_visuals.customer_subscriptions(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id),
 plan_id uuid not null references executive_visuals.subscription_plans(id),
 plan_code text not null,
 plan_version integer not null,
 status text not null,
 billing_interval text not null,
 amount_minor bigint not null,
 currency text not null,
 included_credits bigint not null,
 entitlements_snapshot jsonb not null,
 provider text,
 provider_subscription_id text,
 customer_email text,
 current_period_start timestamptz not null,
 current_period_end timestamptz,
 grace_until timestamptz,
 cancel_at_period_end boolean not null default false,
 cancelled_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (current_period_end is null or current_period_end>current_period_start)
);
create unique index customer_subscriptions_one_current_idx
 on executive_visuals.customer_subscriptions(owner_id)
 where status in ('trialing','active','past_due','pending');
create table executive_visuals.subscription_events(
 id uuid primary key default gen_random_uuid(),
 subscription_id uuid not null references executive_visuals.customer_subscriptions(id),
 owner_id uuid not null references auth.users(id),
 actor_id uuid,
 event_type text not null check(event_type in ('created','activated','renewed','payment_failed','grace_started','cancelled','expired','suspended','plan_changed','admin_granted')),
 source text not null,
 reason text,
 event_data jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create table executive_visuals.payment_transactions(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id),
 provider text not null default 'flutterwave',
 provider_transaction_id text,
 tx_ref text not null,
 amount_minor bigint not null,
 currency text not null,
 status text not null check(status in ('pending','successful','failed','cancelled')),
 payment_method text,
 customer_email text,
 description text not null default '',
 paid_at timestamptz,
 verified_at timestamptz,
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(provider,tx_ref)
);
create table executive_visuals.payment_attempts(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id),
 payment_transaction_id uuid references executive_visuals.payment_transactions(id),
 tx_ref text not null,
 amount_minor bigint not null,
 currency text not null,
 status text not null,
 failure_code text,
 failure_message text,
 attempt_number integer not null,
 next_retry_at timestamptz,
 idempotency_key text not null,
 updated_at timestamptz not null default now()
);
create table executive_visuals.billing_notification_outbox(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id),
 notification_type text not null,
 dedupe_key text not null unique,
 payload jsonb not null,
 status text not null default 'queued',
 attempt_count integer not null default 0,
 available_at timestamptz not null default now(),
 last_error text,
 created_at timestamptz not null default now(),
 read_at timestamptz
);

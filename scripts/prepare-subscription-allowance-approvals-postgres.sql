-- Disposable PostgreSQL fixture for the Supabase allowance-approval migration contract.
create extension if not exists pgcrypto;
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create schema if not exists executive_visuals;
create table if not exists auth.users(id uuid primary key);
create or replace function executive_visuals.reject_revenue_intelligence_mutation()
returns trigger language plpgsql as $$ begin
 raise exception using errcode='55000',message='immutable_record';
end $$;
create table if not exists executive_visuals.platform_admins(
 user_id uuid primary key references auth.users(id) on delete cascade,
 role text not null check(role in('owner','platform_admin','billing_admin','support')),
 granted_by uuid references auth.users(id),
 reason text not null,
 created_at timestamptz not null default now()
);

create table if not exists executive_visuals.subscription_plans(
 id uuid primary key default gen_random_uuid(),
 plan_code text not null unique,
 name text not null,
 description text not null default '',
 status text not null default 'draft' check(status in('draft','active','archived')),
 billing_interval text not null default 'none' check(billing_interval in('none','monthly','yearly')),
 amount_minor bigint not null default 0,
 currency text not null default 'USD',
 included_credits bigint not null default 0,
 entitlements jsonb not null default '{}'::jsonb,
 is_public boolean not null default false,
 version integer not null default 1,
 credit_allowance_published boolean not null default false,
 updated_at timestamptz not null default now()
);
create table if not exists executive_visuals.subscription_plan_provider_prices(
 id uuid primary key default gen_random_uuid(),
 plan_id uuid not null references executive_visuals.subscription_plans(id) on delete restrict,
 provider text not null,
 provider_price_id text,
 amount_minor bigint not null,
 currency text not null,
 active boolean not null default false
);

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

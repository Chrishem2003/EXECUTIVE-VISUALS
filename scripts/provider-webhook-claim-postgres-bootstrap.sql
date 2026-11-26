do $$
begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end;
$$;
create schema if not exists executive_visuals;
grant usage on schema executive_visuals to service_role;
create table executive_visuals.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_key text not null,
  event_type text not null,
  payload_hash text not null,
  signature_verified boolean not null,
  processing_status text not null default 'received',
  payload jsonb not null,
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider,event_key)
);

-- Additional Supabase financial primitives for the disposable asset resource test database.
create table executive_visuals.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','platform_admin','billing_admin','support'))
);
create or replace function executive_visuals.reject_revenue_intelligence_mutation()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  raise exception 'IMMUTABLE_FINANCIAL_EVIDENCE';
end;
$$;

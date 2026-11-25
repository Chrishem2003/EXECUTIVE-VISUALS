-- Additional Supabase financial primitives for the disposable asset resource test database.
create table executive_visuals.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','platform_admin','billing_admin','support'))
);

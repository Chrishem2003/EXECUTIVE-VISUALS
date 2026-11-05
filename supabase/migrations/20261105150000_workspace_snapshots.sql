-- One saved workspace per signed-in user, so work survives restarts and works across devices.
--
-- Safe to run more than once. Paste this whole file into the Supabase dashboard:
--   SQL Editor -> New query -> paste -> Run.
--
-- Privacy: row-level security is on. A signed-in user can only ever see or change their own
-- row. Visitors who are not signed in can do nothing here. The app only needs the public
-- (publishable) key; no secret key is required for this feature.

create table if not exists public.ev_workspace_snapshots (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  revision   integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  -- The server enforces a smaller limit (900,000 bytes); this is a second safety net.
  constraint ev_workspace_snapshots_size check (octet_length(data::text) <= 1000000)
);

alter table public.ev_workspace_snapshots enable row level security;
alter table public.ev_workspace_snapshots force row level security;

revoke all on table public.ev_workspace_snapshots from public, anon;
grant select, insert, update, delete on table public.ev_workspace_snapshots to authenticated;

drop policy if exists ev_workspace_select_own on public.ev_workspace_snapshots;
drop policy if exists ev_workspace_insert_own on public.ev_workspace_snapshots;
drop policy if exists ev_workspace_update_own on public.ev_workspace_snapshots;
drop policy if exists ev_workspace_delete_own on public.ev_workspace_snapshots;

create policy ev_workspace_select_own on public.ev_workspace_snapshots
  for select to authenticated using (user_id = (select auth.uid()));

create policy ev_workspace_insert_own on public.ev_workspace_snapshots
  for insert to authenticated with check (user_id = (select auth.uid()));

create policy ev_workspace_update_own on public.ev_workspace_snapshots
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy ev_workspace_delete_own on public.ev_workspace_snapshots
  for delete to authenticated using (user_id = (select auth.uid()));

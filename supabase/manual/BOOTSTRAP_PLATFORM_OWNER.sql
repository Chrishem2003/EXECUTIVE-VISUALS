-- One-time, operator-run bootstrap for the Executive Visuals platform owner.
-- Run in the Supabase SQL Editor only AFTER:
--   1. The financial-intelligence foundation migration is applied.
--   2. The owner has registered and completed email verification.
-- This script is intentionally not exposed as an HTTP endpoint or browser RPC.
-- It grants no access based only on a client-supplied email.

do $bootstrap$
declare
  owner_user_id uuid;
begin
  select id
    into owner_user_id
    from auth.users
   where lower(email) = lower('chrishem242@gmail.com')
     and email_confirmed_at is not null;

  if owner_user_id is null then
    raise exception 'Verified Supabase Auth account for the configured platform owner was not found. No role was granted.';
  end if;

  insert into executive_visuals.platform_admins
    (user_id, role, granted_by, reason)
  values
    (owner_user_id, 'owner', owner_user_id,
     'Initial platform owner bootstrap; manually approved by project operator.')
  on conflict (user_id) do update
    set role = 'owner',
        granted_by = excluded.granted_by,
        reason = excluded.reason;

  raise notice 'Platform owner role granted to verified Supabase user %.', owner_user_id;
end
$bootstrap$;

-- Verify the grant without exposing unrelated user records.
select pa.role, u.email, u.email_confirmed_at, pa.created_at
  from executive_visuals.platform_admins pa
  join auth.users u on u.id = pa.user_id
 where lower(u.email) = lower('chrishem242@gmail.com');

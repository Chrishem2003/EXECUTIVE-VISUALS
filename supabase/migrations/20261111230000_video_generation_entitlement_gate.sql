-- Enforce the active subscription's immutable AI-generation entitlement
-- inside the same transaction that reserves customer generation credits.
-- This is additive; production application requires a separately approved migration.

create or replace function executive_visuals.assert_video_generation_entitlement(
  p_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $assert_video_generation_entitlement$
declare
  active_subscription_id uuid;
begin
  if p_owner_id is null then
    raise exception 'VIDEO_GENERATION_ENTITLEMENT_OWNER_REQUIRED' using errcode='22023';
  end if;

  -- Hold a shared row lock through the credit reservation so concurrent
  -- cancellation or entitlement changes cannot race an approved generation.
  select s.id into active_subscription_id
  from executive_visuals.customer_subscriptions s
  where s.owner_id=p_owner_id
    and s.status in ('active','trialing')
    and s.current_period_start <= clock_timestamp()
    and s.current_period_end > clock_timestamp()
    and s.entitlements_snapshot @> '{"ai_generation":true}'::jsonb
  order by s.current_period_end desc
  limit 1
  for share;

  if active_subscription_id is null then
    raise exception 'VIDEO_GENERATION_ENTITLEMENT_REQUIRED' using errcode='42501';
  end if;
end;
$assert_video_generation_entitlement$;

revoke all on function executive_visuals.assert_video_generation_entitlement(uuid)
  from public,anon,authenticated,service_role;

-- Keep the existing atomic credit-reservation implementation intact, but make
-- it private and expose an entitlement-checking wrapper under the original RPC.
alter function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  rename to reserve_generation_credits_without_entitlement;

revoke all on function executive_visuals.reserve_generation_credits_without_entitlement(uuid,uuid,bigint,text)
  from public,anon,authenticated,service_role;

create or replace function executive_visuals.reserve_generation_credits(
  p_owner_id uuid,
  p_job_id uuid,
  p_credits bigint,
  p_idempotency_key text
)
returns table(reservation_id uuid,balance bigint,replayed boolean)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $reserve_generation_credits_entitlement_gate$
begin
  perform executive_visuals.assert_video_generation_entitlement(p_owner_id);
  return query
    select r.reservation_id,r.balance,r.replayed
    from executive_visuals.reserve_generation_credits_without_entitlement(
      p_owner_id,p_job_id,p_credits,p_idempotency_key
    ) r;
end;
$reserve_generation_credits_entitlement_gate$;

revoke all on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  from public,anon,authenticated;
grant execute on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  to service_role;

-- Mirror verified provider lifecycle events without re-granting subscription credits.
create or replace function executive_visuals.sync_generation_subscription_status(
  p_provider text,
  p_provider_subscription_id text,
  p_status text,
  p_plan_code text default null,
  p_cancel_at_period_end boolean default false,
  p_grace_until timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(subscription_id uuid,replayed boolean,status text)
language plpgsql
security definer
set search_path = pg_catalog,executive_visuals
as $sync_generation_subscription_status$
declare
  existing executive_visuals.billing_subscriptions;
  plan_row executive_visuals.billing_plans;
begin
  if p_provider is null or p_provider not in ('dodo','flutterwave')
     or coalesce(p_provider_subscription_id,'')='' or char_length(p_provider_subscription_id)>200
     or p_status is null or p_status not in ('trialing','active','past_due','paused','cancelled','expired')
     or p_cancel_at_period_end is null
     or (p_grace_until is not null and p_status<>'past_due')
     or p_metadata is null or jsonb_typeof(p_metadata)<>'object'
     or char_length(coalesce(p_plan_code,''))>40 then
    raise exception 'BILLING_SUBSCRIPTION_STATUS_ARGUMENTS_INVALID';
  end if;

  if p_plan_code is not null then
    select * into plan_row from executive_visuals.billing_plans p
    where p.code=p_plan_code and p.active=true;
    if plan_row.code is null then raise exception 'BILLING_PLAN_NOT_ACTIVE'; end if;
  end if;

  select * into existing from executive_visuals.billing_subscriptions s
  where s.provider=p_provider and s.provider_subscription_id=p_provider_subscription_id
  for update;
  if existing.id is null then raise exception 'BILLING_SUBSCRIPTION_NOT_FOUND'; end if;

  if existing.metadata->>'providerEventId'=p_metadata->>'providerEventId'
     and existing.status=p_status
     and existing.cancel_at_period_end=p_cancel_at_period_end
     and existing.grace_until is not distinct from p_grace_until
     and (p_plan_code is null or existing.plan_code=p_plan_code) then
    return query select existing.id,true,existing.status;
    return;
  end if;

  update executive_visuals.billing_subscriptions
  set status=p_status,
      plan_code=coalesce(p_plan_code,plan_code),
      cancel_at_period_end=p_cancel_at_period_end,
      grace_until=p_grace_until,
      metadata=metadata||p_metadata,
      updated_at=clock_timestamp()
  where id=existing.id;

  return query select existing.id,false,p_status;
end;
$sync_generation_subscription_status$;

revoke all on function executive_visuals.sync_generation_subscription_status(text,text,text,text,boolean,timestamptz,jsonb)
 from public,anon,authenticated;
grant execute on function executive_visuals.sync_generation_subscription_status(text,text,text,text,boolean,timestamptz,jsonb)
 to service_role;

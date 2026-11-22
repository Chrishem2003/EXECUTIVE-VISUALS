do $$
declare
  plan_count integer;
  priced_count integer;
  draft_plan record;
  test_owner uuid := '00000000-0000-4000-8000-000000000762';
begin
  select count(*) into plan_count
  from executive_visuals.subscription_plans
  where plan_code in ('starter_creator','professional_creator','studio','agency','enterprise')
    and status='draft'
    and is_public=false
    and included_credits=0
    and entitlements->>'ai_generation'='true'
    and entitlements->>'credits_pending_cost_validation'='true';

  if plan_count <> 5 then
    raise exception 'COMMERCIAL_DRAFT_PLAN_CATALOG_INVALID: expected five private, zero-credit draft plans; got %',plan_count;
  end if;

  if not exists(select 1 from executive_visuals.subscription_plans where plan_code='starter_creator' and amount_minor=900 and currency='USD')
     or not exists(select 1 from executive_visuals.subscription_plans where plan_code='professional_creator' and amount_minor=2900 and currency='USD')
     or not exists(select 1 from executive_visuals.subscription_plans where plan_code='studio' and amount_minor=7900 and currency='USD')
     or not exists(select 1 from executive_visuals.subscription_plans where plan_code='agency' and amount_minor=19900 and currency='USD')
     or not exists(select 1 from executive_visuals.subscription_plans where plan_code='enterprise' and amount_minor=0 and currency='USD') then
    raise exception 'COMMERCIAL_DRAFT_PLAN_PRICE_HYPOTHESES_INVALID';
  end if;

  select count(*) into priced_count
  from executive_visuals.subscription_plan_provider_prices pp
  join executive_visuals.subscription_plans p on p.id=pp.plan_id
  where p.plan_code in ('starter_creator','professional_creator','studio','agency','enterprise')
    and pp.active=true;

  if priced_count <> 0 then
    raise exception 'COMMERCIAL_DRAFT_PLAN_HAS_ACTIVE_PROVIDER_PRICE';
  end if;

  begin
    perform executive_visuals.reserve_subscription_purchase_for_provider(
      test_owner,'starter_creator','draft-plan-test@example.test','paddle',
      'draft-plan-idempotency-762','draft-plan-tx-reference-762'
    );
    raise exception 'COMMERCIAL_DRAFT_PLAN_CHECKOUT_UNEXPECTEDLY_SUCCEEDED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'Subscription plan is not available' then raise; end if;
  end;
end;
$$;

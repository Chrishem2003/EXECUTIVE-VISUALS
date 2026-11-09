-- Integration coverage for cloud subscription entitlements and period grants.
do $$
declare
  subscription uuid;
  grant_one record;
  grant_two record;
  balance_before bigint;
begin
  insert into auth.users(id,email) values
    ('77777777-7777-4777-8777-777777777777','subscription-test@example.invalid')
  on conflict(id) do nothing;
  insert into executive_visuals.billing_credit_accounts(owner_id)
  values('77777777-7777-4777-8777-777777777777') on conflict do nothing;

  select s.id into subscription from executive_visuals.billing_subscriptions s
  where s.owner_id='77777777-7777-4777-8777-777777777777'
    and s.plan_code='free' and s.status='active'
  order by s.created_at desc limit 1;
  if subscription is null then raise exception 'default free subscription was not provisioned'; end if;

  update executive_visuals.billing_plans set credits_per_period=120
  where code='creator';
  select * into grant_one from executive_visuals.activate_generation_subscription(
    '77777777-7777-4777-8777-777777777777','creator','manual',null,
    'manual-subscription-test-001',clock_timestamp(),
    clock_timestamp()+interval '30 days','active','{"test":true}'::jsonb
  );
  subscription:=grant_one.subscription_id;
  select * into grant_one from executive_visuals.grant_subscription_period_credits(
    subscription,(select current_period_start from executive_visuals.billing_subscriptions where id=subscription)
  );
  if grant_one.replayed or grant_one.balance<>120 then raise exception 'initial subscription period grant failed'; end if;
  select * into grant_two from executive_visuals.grant_subscription_period_credits(
    subscription,(select current_period_start from executive_visuals.billing_subscriptions where id=subscription)
  );
  if not grant_two.replayed or grant_two.balance<>120 then raise exception 'subscription period grant replay was not idempotent'; end if;

  insert into executive_visuals.jobs(id,owner_id,job_type,status,input)
  values('88888888-8888-4888-8888-888888888888',
    '77777777-7777-4777-8777-777777777777','video.generate','queued','{"provider":"runway"}'::jsonb)
  on conflict(id) do nothing;
  select * into grant_one from executive_visuals.reserve_generation_credits(
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',15,'subscription-entitlement-test'
  );
  if grant_one.reservation_id is null or grant_one.balance<>105 then
    raise exception 'entitled creator generation reservation failed';
  end if;

  update executive_visuals.billing_subscriptions set status='cancelled'
  where id=subscription;
  insert into executive_visuals.jobs(id,owner_id,job_type,status,input)
  values('99999999-9999-4999-8999-999999999999',
    '77777777-7777-4777-8777-777777777777','video.generate','queued','{"provider":"runway"}'::jsonb)
  on conflict(id) do nothing;
  begin
    perform * from executive_visuals.reserve_generation_credits(
      '77777777-7777-4777-8777-777777777777',
      '99999999-9999-4999-8999-999999999999',15,'subscription-entitlement-denied-test'
    );
    raise exception 'cancelled subscription unexpectedly authorized video generation';
  exception when others then
    if sqlerrm='cancelled subscription unexpectedly authorized video generation' then raise; end if;
    if sqlerrm<>'BILLING_PLAN_VIDEO_GENERATION_NOT_ENTITLED' then raise; end if;
  end;
end;
$$;

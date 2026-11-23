-- Batch 106: persist Paddle lifecycle event identities so duplicate callbacks
-- cannot re-apply a cancellation/resume or append duplicate subscription events.
-- The unique provider event ID and payload digest make replay detection durable.

create table if not exists executive_visuals.provider_subscription_lifecycle_events(
  id uuid primary key default gen_random_uuid(),
  provider text not null check(provider='paddle'),
  event_id text not null check(char_length(event_id) between 1 and 180),
  provider_subscription_id text not null,
  subscription_id uuid not null references executive_visuals.customer_subscriptions(id) on delete restrict,
  event_type text not null,
  occurred_at timestamptz not null,
  payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
  processing_status text not null check(processing_status in('applied','stale')),
  result jsonb not null check(jsonb_typeof(result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  unique(provider,event_id)
);
create index if not exists provider_subscription_lifecycle_events_subscription_idx
  on executive_visuals.provider_subscription_lifecycle_events(subscription_id,occurred_at desc);
alter table executive_visuals.provider_subscription_lifecycle_events enable row level security;
revoke all on executive_visuals.provider_subscription_lifecycle_events from public,anon,authenticated;
grant select,insert on executive_visuals.provider_subscription_lifecycle_events to service_role;

create or replace function executive_visuals.apply_paddle_subscription_lifecycle(
  p_provider_subscription_id text,
  p_event_type text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_data jsonb
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  existing_event executive_visuals.provider_subscription_lifecycle_events%rowtype;
  next_status text;
  ledger_event_type text;
  event_occurred_at timestamptz;
  provider_event_id text;
  payload_sha text;
  result_payload jsonb;
begin
  if p_provider_subscription_id !~ '^sub_[a-z0-9]{26}$'
     or p_event_type not in ('subscription.created','subscription.activated','subscription.updated',
       'subscription.canceled','subscription.past_due','subscription.paused','subscription.resumed')
     or jsonb_typeof(coalesce(p_event_data,'{}'::jsonb))<>'object'
     or (p_period_start is not null and p_period_end is not null and p_period_end<=p_period_start) then
    raise exception 'Invalid Paddle subscription lifecycle event' using errcode='22023';
  end if;

  provider_event_id:=nullif(btrim(p_event_data->>'event_id'),'');
  payload_sha:=lower(coalesce(p_event_data->>'payload_sha256',''));
  if provider_event_id is null or char_length(provider_event_id)>180
     or payload_sha !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('applied',false,'needsReview',true,'reason','event_identity_or_payload_digest_missing');
  end if;

  begin
    event_occurred_at:=nullif(p_event_data->>'occurred_at','')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Paddle lifecycle event timestamp is invalid' using errcode='22007';
  end;
  if event_occurred_at is null then
    return jsonb_build_object('applied',false,'needsReview',true,'reason','event_timestamp_missing');
  end if;

  select * into subscription_row from customer_subscriptions
   where provider='paddle' and provider_subscription_id=p_provider_subscription_id
   for update;
  if not found then
    return jsonb_build_object('applied',false,'needsReview',true,'reason','subscription_not_mapped');
  end if;

  -- A subscription row lock serializes duplicate event delivery for this subscription.
  -- The unique provider/event key also protects cross-subscription event-ID collisions.
  select * into existing_event
    from provider_subscription_lifecycle_events
   where provider='paddle' and event_id=provider_event_id
   for update;
  if found then
    if existing_event.payload_sha256<>payload_sha
       or existing_event.provider_subscription_id<>p_provider_subscription_id
       or existing_event.event_type<>p_event_type then
      raise exception 'Paddle provider event ID was replayed with different event content'
        using errcode='23505';
    end if;
    return existing_event.result||jsonb_build_object(
      'duplicate',true,'idempotentReplay',true,'eventId',provider_event_id
    );
  end if;

  -- Distinct but older events are recorded as stale; they can never overwrite
  -- a newer subscription state, and their retries are idempotent too.
  if subscription_row.provider_last_event_occurred_at is not null
     and event_occurred_at < subscription_row.provider_last_event_occurred_at then
    result_payload:=jsonb_build_object('applied',false,'stale',true,
      'subscriptionId',subscription_row.id,'status',subscription_row.status,
      'lastEventOccurredAt',subscription_row.provider_last_event_occurred_at,
      'eventId',provider_event_id);
    insert into provider_subscription_lifecycle_events(
      provider,event_id,provider_subscription_id,subscription_id,event_type,occurred_at,
      payload_sha256,processing_status,result
    ) values('paddle',provider_event_id,p_provider_subscription_id,subscription_row.id,
      p_event_type,event_occurred_at,payload_sha,'stale',result_payload);
    return result_payload;
  end if;

  next_status:=case p_event_type
    when 'subscription.canceled' then 'cancelled'
    when 'subscription.past_due' then 'past_due'
    when 'subscription.paused' then 'suspended'
    when 'subscription.resumed' then 'active'
    when 'subscription.activated' then 'active'
    else subscription_row.status
  end;

  -- Paddle can emit subscription.activated before transaction.completed.
  -- A pending local subscription remains pending until the payment finalizer grants access.
  if subscription_row.status='pending' and p_event_type in ('subscription.created','subscription.activated','subscription.updated') then
    next_status:='pending';
  end if;

  update customer_subscriptions set
    status=next_status,
    current_period_start=coalesce(p_period_start,current_period_start),
    current_period_end=coalesce(p_period_end,current_period_end),
    cancel_at_period_end=coalesce(p_cancel_at_period_end,cancel_at_period_end),
    cancelled_at=case when p_event_type='subscription.canceled' then coalesce(cancelled_at,event_occurred_at) else cancelled_at end,
    grace_until=case when next_status='active' then null else grace_until end,
    provider_last_event_occurred_at=event_occurred_at,
    updated_at=now()
   where id=subscription_row.id;

  ledger_event_type:=case p_event_type
    when 'subscription.canceled' then 'cancelled'
    when 'subscription.past_due' then 'payment_failed'
    when 'subscription.paused' then 'suspended'
    when 'subscription.resumed' then 'activated'
    when 'subscription.activated' then 'activated'
    when 'subscription.created' then 'created'
    else null end;
  if ledger_event_type is not null then
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(subscription_row.id,subscription_row.owner_id,ledger_event_type,'paddle',
      'Paddle subscription lifecycle event verified by signature',
      coalesce(p_event_data,'{}'::jsonb)||jsonb_build_object(
        'provider_subscription_id',p_provider_subscription_id,'provider_event_type',p_event_type,
        'payload_sha256',payload_sha
      ));
  end if;

  result_payload:=jsonb_build_object('applied',true,'subscriptionId',subscription_row.id,
    'status',next_status,'lastEventOccurredAt',event_occurred_at,'eventId',provider_event_id);
  insert into provider_subscription_lifecycle_events(
    provider,event_id,provider_subscription_id,subscription_id,event_type,occurred_at,
    payload_sha256,processing_status,result
  ) values('paddle',provider_event_id,p_provider_subscription_id,subscription_row.id,
    p_event_type,event_occurred_at,payload_sha,'applied',result_payload);

  return result_payload;
end;
$$;

revoke all on function executive_visuals.apply_paddle_subscription_lifecycle(text,text,timestamptz,timestamptz,boolean,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.apply_paddle_subscription_lifecycle(text,text,timestamptz,timestamptz,boolean,jsonb)
  to service_role;

-- Batch 10: payment failure recovery, subscription grace periods and customer notifications.
-- Failed mobile-money payments are never auto-debited: customers must explicitly retry.
-- Email delivery remains queued until a configured transactional email provider is connected.

alter table executive_visuals.payment_attempts
  add column if not exists payment_transaction_id uuid
  references executive_visuals.payment_transactions(id) on delete set null;
create unique index if not exists payment_attempts_payment_transaction_uq
  on executive_visuals.payment_attempts(payment_transaction_id)
  where payment_transaction_id is not null;

alter table executive_visuals.billing_notification_outbox
  add column if not exists read_at timestamptz;

create or replace function executive_visuals.record_payment_failure(
  p_payment_id uuid,
  p_failure_code text,
  p_failure_message text,
  p_grace_hours integer default 72
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  attempt_row executive_visuals.payment_attempts%rowtype;
  grace_deadline timestamptz;
  failure_code text;
  failure_message text;
begin
  if p_payment_id is null or p_grace_hours not between 0 and 720 then
    raise exception 'Invalid payment failure input' using errcode='22023';
  end if;
  failure_code := left(coalesce(nullif(btrim(p_failure_code),''),'PAYMENT_FAILED'),100);
  failure_message := left(coalesce(nullif(btrim(p_failure_message),''),'Payment was not completed.'),500);

  select * into payment_row from payment_transactions where id=p_payment_id for update;
  if not found then raise exception 'Payment not found' using errcode='P0002'; end if;
  if payment_row.status not in ('failed','pending') then
    raise exception 'Only failed or pending payment attempts can enter recovery' using errcode='23514';
  end if;

  insert into payment_attempts as current_attempt(
    owner_id,payment_transaction_id,tx_ref,amount_minor,currency,status,
    failure_code,failure_message,attempt_number,next_retry_at,idempotency_key
  ) values (
    payment_row.owner_id,payment_row.id,payment_row.tx_ref,payment_row.amount_minor,
    payment_row.currency,'retry_scheduled',failure_code,failure_message,1,
    case when p_grace_hours=0 then null else now()+interval '24 hours' end,
    'payment-failure:'||payment_row.id::text
  )
  on conflict(payment_transaction_id) where payment_transaction_id is not null
  do update set
    failure_code=excluded.failure_code,
    failure_message=excluded.failure_message,
    status=case when current_attempt.status in ('succeeded','cancelled') then executive_visuals.payment_attempts.status else 'retry_scheduled' end,
    next_retry_at=case when executive_visuals.payment_attempts.status in ('succeeded','cancelled') then current_attempt.next_retry_at else excluded.next_retry_at end,
    updated_at=now()
  returning * into attempt_row;

  select * into subscription_row
  from customer_subscriptions
  where owner_id=payment_row.owner_id
    and id=case when coalesce(payment_row.metadata->>'subscription_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}

  if subscription_row.id is not null and subscription_row.status in ('active','past_due') then
    -- Never extend an existing grace deadline because of repeated failed attempts.
    grace_deadline := coalesce(
      subscription_row.grace_until,
      now()+make_interval(hours=>p_grace_hours)
    );
    update customer_subscriptions
    set status='past_due',grace_until=grace_deadline,updated_at=now()
    where id=subscription_row.id;
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(subscription_row.id,payment_row.owner_id,'payment_failed','system',failure_message,
      jsonb_build_object('payment_id',payment_row.id,'failure_code',failure_code,'grace_until',grace_deadline));
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(subscription_row.id,payment_row.owner_id,'grace_started','system','Payment recovery grace period started',
      jsonb_build_object('payment_id',payment_row.id,'grace_until',grace_deadline));
  end if;

  insert into billing_notification_outbox(owner_id,notification_type,dedupe_key,payload)
  values(
    payment_row.owner_id,'payment_failed','payment-failed:'||payment_row.id::text,
    jsonb_build_object(
      'title','Payment needs attention',
      'message','Your payment could not be completed. Retry checkout to keep your subscription active.',
      'paymentReference',payment_row.tx_ref,
      'failureCode',failure_code,
      'subscriptionId',subscription_row.id,
      'graceUntil',grace_deadline,
      'channels',jsonb_build_array('in_app','email'),
      'emailDelivery','queued_pending_provider'
    )
  ) on conflict(dedupe_key) do nothing;

  return jsonb_build_object(
    'paymentAttemptId',attempt_row.id,
    'status',attempt_row.status,
    'subscriptionStatus',case when subscription_row.id is null then null else 'past_due' end,
    'graceUntil',grace_deadline,
    'notificationQueued',true
  );
end;
$$;

create or replace function executive_visuals.expire_due_subscriptions(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  row_item record;
  expired_count integer := 0;
begin
  if p_limit not between 1 and 500 then
    raise exception 'Limit must be between 1 and 500' using errcode='22023';
  end if;
  for row_item in
    select id,owner_id,plan_code,grace_until
    from customer_subscriptions
    where status='past_due' and grace_until is not null and grace_until<=now()
    order by grace_until asc
    limit p_limit
    for update skip locked
  loop
    update customer_subscriptions
      set status='expired',updated_at=now()
      where id=row_item.id and status='past_due';
    update payment_attempts pa
      set status='exhausted',next_retry_at=null,updated_at=now()
      where pa.owner_id=row_item.owner_id
        and pa.status='retry_scheduled'
        and pa.payment_transaction_id in (
          select pt.id from payment_transactions pt
          where pt.owner_id=row_item.owner_id
            and pt.metadata->>'subscription_id'=row_item.id::text
        );
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
      values(row_item.id,row_item.owner_id,'expired','system','Payment recovery grace period expired',
        jsonb_build_object('plan_code',row_item.plan_code,'grace_until',row_item.grace_until));
    insert into billing_notification_outbox(owner_id,notification_type,dedupe_key,payload)
      values(row_item.owner_id,'subscription_expired','subscription-expired:'||row_item.id::text,
        jsonb_build_object('title','Subscription expired','message','Your subscription has expired after the payment grace period. Renew to restore paid features.','subscriptionId',row_item.id,'channels',jsonb_build_array('in_app','email'),'emailDelivery','queued_pending_provider'))
      on conflict(dedupe_key) do nothing;
    expired_count := expired_count+1;
  end loop;
  return jsonb_build_object('expiredCount',expired_count);
end;
$$;

revoke all on function executive_visuals.record_payment_failure(uuid,text,text,integer)
  from public,anon,authenticated;
revoke all on function executive_visuals.expire_due_subscriptions(integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.record_payment_failure(uuid,text,text,integer)
  to service_role;
grant execute on function executive_visuals.expire_due_subscriptions(integer)
  to service_role;
 then (payment_row.metadata->>'subscription_id')::uuid else null end
  for update;

  if subscription_row.id is not null and subscription_row.status in ('active','past_due') then
    grace_deadline := case
      when p_grace_hours=0 then now()
      else greatest(coalesce(subscription_row.grace_until,now()),now()) + make_interval(hours=>p_grace_hours)
    end;
    update customer_subscriptions
    set status='past_due',grace_until=grace_deadline,updated_at=now()
    where id=subscription_row.id;
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(subscription_row.id,payment_row.owner_id,'payment_failed','system',failure_message,
      jsonb_build_object('payment_id',payment_row.id,'failure_code',failure_code,'grace_until',grace_deadline));
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(subscription_row.id,payment_row.owner_id,'grace_started','system','Payment recovery grace period started',
      jsonb_build_object('payment_id',payment_row.id,'grace_until',grace_deadline));
  end if;

  insert into billing_notification_outbox(owner_id,notification_type,dedupe_key,payload)
  values(
    payment_row.owner_id,'payment_failed','payment-failed:'||payment_row.id::text,
    jsonb_build_object(
      'title','Payment needs attention',
      'message','Your payment could not be completed. Retry checkout to keep your subscription active.',
      'paymentReference',payment_row.tx_ref,
      'failureCode',failure_code,
      'subscriptionId',subscription_row.id,
      'graceUntil',grace_deadline,
      'channels',jsonb_build_array('in_app','email'),
      'emailDelivery','queued_pending_provider'
    )
  ) on conflict(dedupe_key) do nothing;

  return jsonb_build_object(
    'paymentAttemptId',attempt_row.id,
    'status',attempt_row.status,
    'subscriptionStatus',case when subscription_row.id is null then null else 'past_due' end,
    'graceUntil',grace_deadline,
    'notificationQueued',true
  );
end;
$$;

create or replace function executive_visuals.expire_due_subscriptions(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  row_item record;
  expired_count integer := 0;
begin
  if p_limit not between 1 and 500 then
    raise exception 'Limit must be between 1 and 500' using errcode='22023';
  end if;
  for row_item in
    select id,owner_id,plan_code,grace_until
    from customer_subscriptions
    where status='past_due' and grace_until is not null and grace_until<=now()
    order by grace_until asc
    limit p_limit
    for update skip locked
  loop
    update customer_subscriptions
      set status='expired',updated_at=now()
      where id=row_item.id and status='past_due';
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
      values(row_item.id,row_item.owner_id,'expired','system','Payment recovery grace period expired',
        jsonb_build_object('plan_code',row_item.plan_code,'grace_until',row_item.grace_until));
    insert into billing_notification_outbox(owner_id,notification_type,dedupe_key,payload)
      values(row_item.owner_id,'subscription_expired','subscription-expired:'||row_item.id::text,
        jsonb_build_object('title','Subscription expired','message','Your subscription has expired after the payment grace period. Renew to restore paid features.','subscriptionId',row_item.id,'channels',jsonb_build_array('in_app','email'),'emailDelivery','queued_pending_provider'))
      on conflict(dedupe_key) do nothing;
    expired_count := expired_count+1;
  end loop;
  return jsonb_build_object('expiredCount',expired_count);
end;
$$;

revoke all on function executive_visuals.record_payment_failure(uuid,text,text,integer)
  from public,anon,authenticated;
revoke all on function executive_visuals.expire_due_subscriptions(integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.record_payment_failure(uuid,text,text,integer)
  to service_role;
grant execute on function executive_visuals.expire_due_subscriptions(integer)
  to service_role;

-- Forward repair for the payment-recovery upsert target alias.
-- Keeps terminal attempts immutable while allowing active retry records to refresh.
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
    status=case when current_attempt.status in ('succeeded','cancelled') then current_attempt.status else 'retry_scheduled' end,
    next_retry_at=case when current_attempt.status in ('succeeded','cancelled') then current_attempt.next_retry_at else excluded.next_retry_at end,
    updated_at=now()
  returning * into attempt_row;

  select * into subscription_row
  from customer_subscriptions
  where owner_id=payment_row.owner_id
    and id=case when coalesce(payment_row.metadata->>'subscription_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (payment_row.metadata->>'subscription_id')::uuid else null end
  for update;

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

revoke all on function executive_visuals.record_payment_failure(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function executive_visuals.record_payment_failure(uuid,text,text,integer) to service_role;

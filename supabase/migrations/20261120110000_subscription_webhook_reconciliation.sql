-- Resolve only exact, manually reviewed Flutterwave subscription cancellation events.
-- An ambiguous provider callback must never revoke customer access.
create or replace function executive_visuals.reconcile_flutterwave_subscription_cancellation(
  p_actor_id uuid,
  p_event_id uuid,
  p_subscription_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  actor_role text;
  event_row executive_visuals.payment_webhook_events%rowtype;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  provider_subscription_id text;
  provider_customer_email text;
begin
  select role into actor_role
    from executive_visuals.platform_admins
   where user_id=p_actor_id;
  if actor_role is null or actor_role not in ('owner','platform_admin','billing_admin') then
    raise exception 'Billing administrator role required' using errcode='42501';
  end if;
  if p_event_id is null or p_subscription_id is null
     or p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'Invalid subscription cancellation reconciliation input' using errcode='22023';
  end if;

  select * into event_row
    from executive_visuals.payment_webhook_events
   where id=p_event_id
   for update;
  if not found then
    raise exception 'Subscription webhook event not found' using errcode='P0002';
  end if;
  if event_row.provider<>'flutterwave' or event_row.event_type<>'subscription.cancelled'
     or event_row.signature_verified is not true then
    raise exception 'Only verified Flutterwave subscription cancellation events can be reconciled' using errcode='23514';
  end if;

  if event_row.processing_status='processed' and exists(
    select 1 from executive_visuals.subscription_events se
     where se.subscription_id=p_subscription_id
       and se.event_type='cancelled'
       and se.event_data->>'webhookEventId'=p_event_id::text
  ) then
    return jsonb_build_object('resolved',true,'idempotentReplay',true,'subscriptionId',p_subscription_id);
  end if;
  if event_row.processing_status<>'needs_review' then
    raise exception 'Subscription webhook event is not awaiting review' using errcode='55000';
  end if;

  provider_subscription_id:=nullif(btrim(event_row.payload #>> '{data,id}'),'');
  provider_customer_email:=lower(nullif(btrim(event_row.payload #>> '{data,customer,email}'),''));
  if provider_subscription_id is null then
    return jsonb_build_object('resolved',false,'reviewRequired',true,'reason','provider_subscription_id_missing');
  end if;
  if provider_customer_email is null then
    return jsonb_build_object('resolved',false,'reviewRequired',true,'reason','provider_customer_email_missing');
  end if;

  select * into subscription_row
    from executive_visuals.customer_subscriptions
   where id=p_subscription_id
   for update;
  if not found then
    return jsonb_build_object('resolved',false,'reviewRequired',true,'reason','local_subscription_not_found');
  end if;
  if subscription_row.provider<>'flutterwave'
     or subscription_row.provider_subscription_id is null
     or subscription_row.provider_subscription_id<>provider_subscription_id then
    return jsonb_build_object('resolved',false,'reviewRequired',true,'reason','provider_subscription_id_mismatch');
  end if;
  if lower(coalesce(subscription_row.customer_email,''))<>provider_customer_email then
    return jsonb_build_object('resolved',false,'reviewRequired',true,'reason','provider_customer_email_mismatch');
  end if;
  if subscription_row.status not in ('active','past_due','trialing') then
    return jsonb_build_object('resolved',false,'reviewRequired',true,'reason','subscription_not_cancellable');
  end if;

  update executive_visuals.customer_subscriptions
     set status='cancelled',
         cancelled_at=coalesce(cancelled_at,now()),
         cancel_at_period_end=false,
         updated_at=now()
   where id=p_subscription_id;

  insert into executive_visuals.subscription_events(
    subscription_id,owner_id,actor_id,event_type,source,reason,event_data
  ) values(
    p_subscription_id,subscription_row.owner_id,p_actor_id,'cancelled','flutterwave',
    btrim(p_reason),
    jsonb_build_object(
      'webhookEventId',p_event_id,
      'payloadHash',event_row.payload_hash,
      'providerSubscriptionId',provider_subscription_id,
      'providerCustomerEmail',provider_customer_email,
      'manualReconciliation',true
    )
  );

  update executive_visuals.payment_webhook_events
     set processing_status='processed',
         error_message=null,
         processed_at=now()
   where id=p_event_id;

  return jsonb_build_object('resolved',true,'idempotentReplay',false,'subscriptionId',p_subscription_id);
end;
$$;

revoke all on function executive_visuals.reconcile_flutterwave_subscription_cancellation(uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function executive_visuals.reconcile_flutterwave_subscription_cancellation(uuid,uuid,uuid,text)
  to service_role;

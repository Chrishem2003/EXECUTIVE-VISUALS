-- Batch 11: customer self-service subscription lifecycle and scheduled plan changes.
-- Plan changes are applied only after the next customer-initiated, verified renewal.
-- Cancellation never triggers a refund; refunds remain a separate reviewed workflow.

alter table executive_visuals.customer_subscriptions
  add column if not exists scheduled_plan_id uuid references executive_visuals.subscription_plans(id) on delete restrict,
  add column if not exists scheduled_plan_code text,
  add column if not exists scheduled_plan_version integer,
  add column if not exists scheduled_billing_interval text,
  add column if not exists scheduled_amount_minor bigint,
  add column if not exists scheduled_currency text,
  add column if not exists scheduled_included_credits bigint,
  add column if not exists scheduled_entitlements_snapshot jsonb,
  add column if not exists scheduled_plan_at timestamptz;

alter table executive_visuals.subscription_events
  drop constraint if exists subscription_events_event_type_check;
alter table executive_visuals.subscription_events
  add constraint subscription_events_event_type_check
  check (event_type in (
    'created','activated','renewed','payment_failed','grace_started','cancelled',
    'expired','suspended','plan_changed','admin_granted','cancellation_scheduled',
    'cancellation_revoked','plan_change_scheduled','plan_change_cancelled'
  ));

create or replace function executive_visuals.manage_customer_subscription(
  p_owner_id uuid,
  p_subscription_id uuid,
  p_action text,
  p_plan_code text default null,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  sub_row executive_visuals.customer_subscriptions%rowtype;
  plan_row executive_visuals.subscription_plans%rowtype;
  action_name text := lower(coalesce(p_action,''));
  reason_text text := left(coalesce(nullif(btrim(p_reason),''),'Customer self-service'),200);
begin
  if p_owner_id is null or p_subscription_id is null
     or action_name not in ('cancel_at_period_end','cancel_immediately','resume','schedule_plan_change','cancel_plan_change') then
    raise exception 'Invalid subscription management request' using errcode='22023';
  end if;

  select * into sub_row
  from customer_subscriptions
  where id=p_subscription_id and owner_id=p_owner_id
  for update;
  if not found then raise exception 'Subscription not found' using errcode='P0002'; end if;

  -- Do not mutate the subscription while a provider charge is awaiting verification.
  -- This prevents a successful in-flight charge from being orphaned by a concurrent cancel or plan change.
  if exists(
    select 1 from payment_transactions
    where owner_id=p_owner_id and status='pending'
      and metadata->>'subscription_id'=sub_row.id::text
  ) then
    raise exception 'A subscription payment is awaiting provider confirmation; refresh billing before changing this subscription'
      using errcode='55000';
  end if;

  if action_name='cancel_at_period_end' then
    if sub_row.status not in ('active','past_due','trialing') then
      raise exception 'Subscription cannot be scheduled for cancellation' using errcode='23514';
    end if;
    if sub_row.cancel_at_period_end then
      return jsonb_build_object('subscriptionId',sub_row.id,'status',sub_row.status,'cancelAtPeriodEnd',true,'idempotentReplay',true);
    end if;
    update customer_subscriptions set cancel_at_period_end=true,cancelled_at=null,updated_at=now() where id=sub_row.id;
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(sub_row.id,p_owner_id,'cancellation_scheduled','system',reason_text,
      jsonb_build_object('effective_at',sub_row.current_period_end));
    return jsonb_build_object('subscriptionId',sub_row.id,'status',sub_row.status,'cancelAtPeriodEnd',true,'effectiveAt',sub_row.current_period_end);
  elsif action_name='cancel_immediately' then
    if sub_row.status not in ('active','past_due','trialing','pending') then
      raise exception 'Subscription cannot be cancelled in its current state' using errcode='23514';
    end if;
    update customer_subscriptions
      set status='cancelled',cancel_at_period_end=false,cancelled_at=now(),
          scheduled_plan_id=null,scheduled_plan_code=null,scheduled_plan_version=null,
          scheduled_billing_interval=null,scheduled_amount_minor=null,scheduled_currency=null,
          scheduled_included_credits=null,scheduled_entitlements_snapshot=null,scheduled_plan_at=null,
          updated_at=now()
    where id=sub_row.id;
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(sub_row.id,p_owner_id,'cancelled','system',reason_text,
      jsonb_build_object('cancelled_at',now(),'immediate',true));
    return jsonb_build_object('subscriptionId',sub_row.id,'status','cancelled','cancelAtPeriodEnd',false,'cancelledAt',now());
  elsif action_name='resume' then
    if sub_row.status not in ('active','past_due') or not sub_row.cancel_at_period_end
       or sub_row.current_period_end is null or sub_row.current_period_end<=now() then
      raise exception 'Only an active subscription scheduled for future cancellation can be resumed' using errcode='23514';
    end if;
    update customer_subscriptions set cancel_at_period_end=false,cancelled_at=null,updated_at=now() where id=sub_row.id;
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(sub_row.id,p_owner_id,'cancellation_revoked','system',reason_text,jsonb_build_object('period_end',sub_row.current_period_end));
    return jsonb_build_object('subscriptionId',sub_row.id,'status','active','cancelAtPeriodEnd',false);
  elsif action_name='schedule_plan_change' then
    if sub_row.status<>'active' or sub_row.cancel_at_period_end
       or sub_row.current_period_end is null or sub_row.current_period_end<=now() then
      raise exception 'Plan changes require an active subscription that is not scheduled for cancellation' using errcode='23514';
    end if;
    select * into plan_row from subscription_plans
      where plan_code=lower(coalesce(p_plan_code,'')) and status='active' and is_public=true
      for share;
    if not found or plan_row.billing_interval not in ('monthly','yearly')
       or plan_row.currency<>'UGX' or plan_row.amount_minor<=0 then
      raise exception 'Selected plan is unavailable for Uganda mobile-money billing' using errcode='22023';
    end if;
    if plan_row.plan_code=sub_row.plan_code then
      raise exception 'Selected plan is already active' using errcode='22023';
    end if;
    update customer_subscriptions set
      scheduled_plan_id=plan_row.id,
      scheduled_plan_code=plan_row.plan_code,
      scheduled_plan_version=plan_row.version,
      scheduled_billing_interval=plan_row.billing_interval,
      scheduled_amount_minor=plan_row.amount_minor,
      scheduled_currency=plan_row.currency,
      scheduled_included_credits=plan_row.included_credits,
      scheduled_entitlements_snapshot=plan_row.entitlements,
      scheduled_plan_at=sub_row.current_period_end,
      updated_at=now()
    where id=sub_row.id;
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(sub_row.id,p_owner_id,'plan_change_scheduled','system',reason_text,
      jsonb_build_object('from_plan',sub_row.plan_code,'to_plan',plan_row.plan_code,
        'effective_at',sub_row.current_period_end,'amount_minor',plan_row.amount_minor,'currency',plan_row.currency));
    return jsonb_build_object('subscriptionId',sub_row.id,'planCode',sub_row.plan_code,
      'scheduledPlanCode',plan_row.plan_code,'effectiveAt',sub_row.current_period_end,
      'scheduledAmountMinor',plan_row.amount_minor,'currency',plan_row.currency);
  elsif action_name='cancel_plan_change' then
    if sub_row.scheduled_plan_id is null then
      return jsonb_build_object('subscriptionId',sub_row.id,'planChangeCancelled',false,'idempotentReplay',true);
    end if;
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(sub_row.id,p_owner_id,'plan_change_cancelled','system',reason_text,
      jsonb_build_object('scheduled_plan_code',sub_row.scheduled_plan_code));
    update customer_subscriptions set
      scheduled_plan_id=null,scheduled_plan_code=null,scheduled_plan_version=null,
      scheduled_billing_interval=null,scheduled_amount_minor=null,scheduled_currency=null,
      scheduled_included_credits=null,scheduled_entitlements_snapshot=null,scheduled_plan_at=null,
      updated_at=now()
    where id=sub_row.id;
    return jsonb_build_object('subscriptionId',sub_row.id,'planChangeCancelled',true);
  end if;
end;
$$;

revoke all on function executive_visuals.manage_customer_subscription(uuid,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function executive_visuals.manage_customer_subscription(uuid,uuid,text,text,text)
  to service_role;

-- Apply scheduled plan snapshot only after the customer's next payment is verified.
create or replace function executive_visuals.finalize_subscription_renewal(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path=executive_visuals,pg_temp
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  next_period_start timestamptz;
  next_period_end timestamptz;
  target_plan_id uuid;
  target_plan_code text;
  target_plan_version integer;
  target_interval text;
  target_amount bigint;
  target_currency text;
  target_credits bigint;
  target_entitlements jsonb;
  plan_changed boolean := false;
begin
  if p_payment_id is null or nullif(btrim(p_provider_transaction_id),'') is null
     or p_verified_at is null or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb))<>'object'
     or lower(coalesce(p_provider_payload->>'status',''))<>'succeeded' then
    raise exception 'Invalid verified subscription renewal input' using errcode='22023';
  end if;
  select * into payment_row from payment_transactions where id=p_payment_id for update;
  if not found then raise exception 'Renewal payment not found' using errcode='P0002'; end if;
  if payment_row.metadata->>'payment_purpose'<>'subscription_renewal'
     or nullif(payment_row.metadata->>'subscription_id','') is null
     or payment_row.currency<>'UGX'
     or upper(coalesce(p_provider_payload->>'currency',''))<>payment_row.currency
     or coalesce(p_provider_payload->>'reference','')<>payment_row.tx_ref
     or coalesce((p_provider_payload->>'amount')::numeric,-1)<>payment_row.amount_minor::numeric
     or (payment_row.provider_transaction_id is not null and payment_row.provider_transaction_id<>p_provider_transaction_id) then
    raise exception 'Verified provider payment does not match renewal reservation' using errcode='23514';
  end if;
  if payment_row.status='successful' and coalesce((payment_row.metadata->>'renewal_applied')::boolean,false) then
    return jsonb_build_object('paymentId',payment_row.id,'status','successful','idempotentReplay',true);
  end if;
  if payment_row.status<>'pending' then raise exception 'Renewal payment is not pending' using errcode='23514'; end if;

  select * into subscription_row from customer_subscriptions
  where id=(payment_row.metadata->>'subscription_id')::uuid and owner_id=payment_row.owner_id for update;
  if not found then raise exception 'Subscription does not belong to renewal customer' using errcode='42501'; end if;
  if subscription_row.status not in ('active','past_due')
     or subscription_row.cancel_at_period_end
     or subscription_row.billing_interval not in ('monthly','yearly')
     or subscription_row.currency<>payment_row.currency then
    raise exception 'Subscription is not eligible for this renewal payment' using errcode='23514';
  end if;

  target_plan_id:=coalesce(subscription_row.scheduled_plan_id,subscription_row.plan_id);
  target_plan_code:=coalesce(subscription_row.scheduled_plan_code,subscription_row.plan_code);
  target_plan_version:=coalesce(subscription_row.scheduled_plan_version,subscription_row.plan_version);
  target_interval:=coalesce(subscription_row.scheduled_billing_interval,subscription_row.billing_interval);
  target_amount:=coalesce(subscription_row.scheduled_amount_minor,subscription_row.amount_minor);
  target_currency:=coalesce(subscription_row.scheduled_currency,subscription_row.currency);
  target_credits:=coalesce(subscription_row.scheduled_included_credits,subscription_row.included_credits);
  target_entitlements:=coalesce(subscription_row.scheduled_entitlements_snapshot,subscription_row.entitlements_snapshot);
  if target_currency<>payment_row.currency or target_amount<>payment_row.amount_minor then
    raise exception 'Renewal payment does not match current or scheduled plan price' using errcode='23514';
  end if;
  next_period_start:=greatest(coalesce(subscription_row.current_period_end,now()),now());
  next_period_end:=case target_interval when 'monthly' then next_period_start+interval '1 month'
    when 'yearly' then next_period_start+interval '1 year' else null end;
  if next_period_end is null or next_period_end<=next_period_start then
    raise exception 'Could not calculate subscription renewal period' using errcode='22023';
  end if;

  update payment_transactions set status='successful',
    provider_transaction_id=p_provider_transaction_id,paid_at=coalesce(paid_at,p_verified_at),
    verified_at=p_verified_at,metadata=metadata||jsonb_build_object('renewal_applied',true,
      'renewal_verified_at',p_verified_at,'provider_verified_status','succeeded'),updated_at=now()
  where id=payment_row.id;

  plan_changed:=subscription_row.scheduled_plan_id is not null;
  update customer_subscriptions set status='active',plan_id=target_plan_id,plan_code=target_plan_code,
    plan_version=target_plan_version,billing_interval=target_interval,amount_minor=target_amount,
    currency=target_currency,included_credits=target_credits,entitlements_snapshot=target_entitlements,
    current_period_start=next_period_start,current_period_end=next_period_end,grace_until=null,
    scheduled_plan_id=null,scheduled_plan_code=null,scheduled_plan_version=null,
    scheduled_billing_interval=null,scheduled_amount_minor=null,scheduled_currency=null,
    scheduled_included_credits=null,scheduled_entitlements_snapshot=null,scheduled_plan_at=null,
    updated_at=now()
  where id=subscription_row.id;

  if target_credits>0 then
    insert into credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata)
    values(subscription_row.owner_id,'purchase_grant',target_credits,
      'subscription-renewal:'||payment_row.id::text,payment_row.id,
      'Included subscription credits for verified renewal',
      jsonb_build_object('subscription_id',subscription_row.id,'plan_code',target_plan_code,
        'period_start',next_period_start,'period_end',next_period_end))
    on conflict(owner_id,idempotency_key) do nothing;
  end if;

  insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
  values(subscription_row.id,subscription_row.owner_id,'renewed','flutterwave',
    'Customer-initiated mobile-money renewal verified by Flutterwave',
    jsonb_build_object('payment_id',payment_row.id,'provider_transaction_id',p_provider_transaction_id,
      'amount_minor',payment_row.amount_minor,'currency',payment_row.currency,
      'period_start',next_period_start,'period_end',next_period_end,'plan_code',target_plan_code));
  if plan_changed then
    insert into subscription_events(subscription_id,owner_id,event_type,source,reason,event_data)
    values(subscription_row.id,subscription_row.owner_id,'plan_changed','system',
      'Scheduled plan change applied after verified renewal',
      jsonb_build_object('plan_code',target_plan_code,'plan_version',target_plan_version,'effective_at',next_period_start));
  end if;
  return jsonb_build_object('paymentId',payment_row.id,'subscriptionId',subscription_row.id,
    'status','active','planCode',target_plan_code,'planChanged',plan_changed,
    'periodStart',next_period_start,'periodEnd',next_period_end,'idempotentReplay',false);
end;
$$;

revoke all on function executive_visuals.finalize_subscription_renewal(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.finalize_subscription_renewal(uuid,text,jsonb,timestamptz)
  to service_role;

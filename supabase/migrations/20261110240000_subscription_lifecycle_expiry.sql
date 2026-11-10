-- Batch 11 reliability: finalize scheduled cancellations and past-due expirations.
-- This RPC is safe to call repeatedly from multiple application instances.

create or replace function executive_visuals.expire_due_subscriptions(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  row_item record;
  expired_count integer := 0;
  cancelled_count integer := 0;
begin
  if p_limit not between 1 and 500 then
    raise exception 'Limit must be between 1 and 500' using errcode='22023';
  end if;

  for row_item in
    select s.id,s.owner_id,s.plan_code,s.grace_until,s.current_period_end,s.status,s.cancel_at_period_end
    from customer_subscriptions s
    where (
      (s.status='past_due' and s.grace_until is not null and s.grace_until<=now())
      or
      (s.status='active' and s.cancel_at_period_end=true and s.current_period_end is not null
        and s.current_period_end<=now())
    )
    and not exists(
      select 1 from payment_transactions p
      where p.owner_id=s.owner_id and p.status='pending'
        and p.metadata->>'subscription_id'=s.id::text
    )
    order by coalesce(s.grace_until,s.current_period_end) asc
    limit p_limit
    for update of s skip locked
  loop
    update customer_subscriptions
      set status='expired',cancelled_at=coalesce(cancelled_at,now()),
          cancel_at_period_end=false,updated_at=now()
      where id=row_item.id and status=row_item.status;
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
      values(row_item.id,row_item.owner_id,'expired','system',
        case when row_item.status='active' then 'Subscription cancelled at the end of its paid period'
             else 'Payment recovery grace period expired' end,
        jsonb_build_object('plan_code',row_item.plan_code,'grace_until',row_item.grace_until,
          'period_end',row_item.current_period_end,'scheduled_cancellation',row_item.cancel_at_period_end));
    insert into billing_notification_outbox(owner_id,notification_type,dedupe_key,payload)
      values(row_item.owner_id,'subscription_expired','subscription-expired:'||row_item.id::text,
        jsonb_build_object('title','Subscription ended',
          'message',case when row_item.status='active'
            then 'Your subscription ended at the close of its paid period.'
            else 'Your subscription expired after its payment grace period.' end,
          'subscriptionId',row_item.id,'channels',jsonb_build_array('in_app','email'),
          'emailDelivery','queued_pending_provider'))
      on conflict(dedupe_key) do nothing;
    expired_count:=expired_count+1;
    if row_item.status='active' then cancelled_count:=cancelled_count+1; end if;
  end loop;
  return jsonb_build_object('expiredCount',expired_count,'scheduledCancellationsFinalized',cancelled_count);
end;
$$;

revoke all on function executive_visuals.expire_due_subscriptions(integer) from public,anon,authenticated;
grant execute on function executive_visuals.expire_due_subscriptions(integer) to service_role;

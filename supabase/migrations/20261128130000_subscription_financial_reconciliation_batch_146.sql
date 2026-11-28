-- Batch 146: durable, read-only subscription entitlement and payment reconciliation.
-- The RPC records findings only. It never grants credits, changes subscription state,
-- edits payment rows, or attempts to repair provider records automatically.

create table if not exists executive_visuals.subscription_financial_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  status text not null check (status in ('completed','failed')),
  scanned_payment_count integer not null default 0 check (scanned_payment_count >= 0),
  scanned_subscription_count integer not null default 0 check (scanned_subscription_count >= 0),
  finding_count integer not null default 0 check (finding_count >= 0),
  returned_finding_count integer not null default 0 check (returned_finding_count >= 0),
  findings jsonb not null default '[]'::jsonb check (jsonb_typeof(findings)='array'),
  report jsonb not null default '{}'::jsonb check (jsonb_typeof(report)='object')
);

create index if not exists subscription_financial_reconciliation_runs_started_idx
  on executive_visuals.subscription_financial_reconciliation_runs(started_at desc);
create index if not exists payment_transactions_subscription_reconciliation_idx
  on executive_visuals.payment_transactions((metadata->>'payment_purpose'),status,created_at desc)
  where metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal');
create index if not exists payment_transactions_subscription_link_reconciliation_idx
  on executive_visuals.payment_transactions(owner_id,(metadata->>'subscription_id'))
  where metadata ? 'subscription_id';
create index if not exists customer_subscriptions_reconciliation_status_idx
  on executive_visuals.customer_subscriptions(status,current_period_end,created_at);

alter table executive_visuals.subscription_financial_reconciliation_runs enable row level security;
revoke all on executive_visuals.subscription_financial_reconciliation_runs from public, anon, authenticated;
revoke all on executive_visuals.subscription_financial_reconciliation_runs from service_role;
grant select on executive_visuals.subscription_financial_reconciliation_runs to service_role;

create or replace function executive_visuals.run_subscription_financial_reconciliation(
  p_limit integer default 100
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $run_subscription_financial_reconciliation$
declare
  v_run_id uuid;
  v_findings jsonb := '[]'::jsonb;
  v_finding_count integer := 0;
  v_payment_count integer := 0;
  v_subscription_count integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'SUBSCRIPTION_RECONCILIATION_LIMIT_INVALID' using errcode='22023';
  end if;

  select count(*)::integer into v_payment_count
    from payment_transactions
   where metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal');

  select count(*)::integer into v_subscription_count
    from customer_subscriptions;

  with findings as (
    select 'successful_payment_not_applied'::text as category,
      p.id::text as entity_id,p.owner_id,
      jsonb_build_object('paymentId',p.id,'ownerId',p.owner_id,'provider',p.provider,
        'reference',p.tx_ref,'subscriptionId',p.metadata->>'subscription_id',
        'paymentStatus',p.status,'subscriptionApplied',false) as details
    from payment_transactions p
    where p.metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      and p.status='successful'
      and p.metadata->'subscription_applied' is distinct from 'true'::jsonb

    union all

    select 'applied_payment_not_successful',p.id::text,p.owner_id,
      jsonb_build_object('paymentId',p.id,'ownerId',p.owner_id,'provider',p.provider,
        'reference',p.tx_ref,'paymentStatus',p.status,'subscriptionApplied',true)
    from payment_transactions p
    where p.metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      and p.metadata->'subscription_applied' = 'true'::jsonb
      and p.status<>'successful'

    union all

    select 'subscription_record_missing',p.id::text,p.owner_id,
      jsonb_build_object('paymentId',p.id,'ownerId',p.owner_id,'provider',p.provider,
        'reference',p.tx_ref,'subscriptionId',p.metadata->>'subscription_id')
    from payment_transactions p
    left join customer_subscriptions s
      on s.id::text=p.metadata->>'subscription_id' and s.owner_id=p.owner_id
    where p.metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      and p.metadata->'subscription_applied' = 'true'::jsonb
      and s.id is null

    union all

    select 'subscription_provider_mismatch',p.id::text,p.owner_id,
      jsonb_build_object('paymentId',p.id,'ownerId',p.owner_id,'paymentProvider',p.provider,
        'subscriptionProvider',s.provider,'subscriptionId',s.id)
    from payment_transactions p
    join customer_subscriptions s
      on s.id::text=p.metadata->>'subscription_id' and s.owner_id=p.owner_id
    where p.metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      and p.status='successful'
      and p.metadata->'subscription_applied' = 'true'::jsonb
      and s.provider is distinct from p.provider

    union all

    select 'subscription_allowance_grant_missing',p.id::text,p.owner_id,
      jsonb_build_object('paymentId',p.id,'ownerId',p.owner_id,'provider',p.provider,
        'subscriptionId',s.id,'expectedCredits',s.included_credits)
    from payment_transactions p
    join customer_subscriptions s
      on s.id::text=p.metadata->>'subscription_id' and s.owner_id=p.owner_id
    where p.metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      and p.status='successful'
      and p.metadata->'subscription_applied' = 'true'::jsonb
      and s.included_credits>0
      and not exists (
        select 1 from credit_ledger l
         where l.owner_id=p.owner_id and l.payment_transaction_id=p.id
           and l.entry_type='purchase_grant' and l.credit_delta=s.included_credits
           and l.idempotency_key in ('subscription-purchase:'||p.id::text,
                                     'subscription-renewal:'||p.id::text)
      )

    union all

    select 'subscription_allowance_wallet_mirror_missing',p.id::text,p.owner_id,
      jsonb_build_object('paymentId',p.id,'ownerId',p.owner_id,'provider',p.provider,
        'subscriptionId',s.id,'expectedCredits',s.included_credits)
    from payment_transactions p
    join customer_subscriptions s
      on s.id::text=p.metadata->>'subscription_id' and s.owner_id=p.owner_id
    join credit_ledger l
      on l.owner_id=p.owner_id and l.payment_transaction_id=p.id
     and l.entry_type='purchase_grant' and l.credit_delta=s.included_credits
    where p.metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      and p.status='successful'
      and p.metadata->'subscription_applied' = 'true'::jsonb
      and s.included_credits>0
      and not exists (
        select 1 from billing_credit_revenue_sources rs
         where rs.owner_id=p.owner_id and rs.source_reference_id=p.id
           and rs.source_type='subscription_allowance'
           and rs.credits_granted=s.included_credits
      )

    union all

    select 'active_subscription_period_elapsed',s.id::text,s.owner_id,
      jsonb_build_object('subscriptionId',s.id,'ownerId',s.owner_id,'planCode',s.plan_code,
        'periodEnd',s.current_period_end,'provider',s.provider)
    from customer_subscriptions s
    where s.status='active' and s.current_period_end is not null
      and s.current_period_end<=v_now
      and not exists (
        select 1 from payment_transactions p
         where p.owner_id=s.owner_id and p.status='pending'
           and p.metadata->>'subscription_id'=s.id::text
      )

    union all

    select 'past_due_grace_deadline_missing',s.id::text,s.owner_id,
      jsonb_build_object('subscriptionId',s.id,'ownerId',s.owner_id,'planCode',s.plan_code,
        'provider',s.provider,'periodEnd',s.current_period_end)
    from customer_subscriptions s
    where s.status='past_due' and s.grace_until is null

    union all

    select 'multiple_current_subscriptions',x.owner_id::text,x.owner_id,
      jsonb_build_object('ownerId',x.owner_id,'subscriptionCount',x.subscription_count,
        'subscriptionIds',x.subscription_ids)
    from (
      select owner_id,count(*)::integer as subscription_count,
        jsonb_agg(id order by created_at,id) as subscription_ids
      from customer_subscriptions
      where status in ('pending','trialing','active','past_due')
      group by owner_id having count(*)>1
    ) x

    union all

    select 'stale_pending_subscription_without_pending_payment',s.id::text,s.owner_id,
      jsonb_build_object('subscriptionId',s.id,'ownerId',s.owner_id,'planCode',s.plan_code,
        'createdAt',s.created_at,'provider',s.provider)
    from customer_subscriptions s
    where s.status='pending' and s.created_at<v_now-interval '24 hours'
      and not exists (
        select 1 from payment_transactions p
         where p.owner_id=s.owner_id and p.status='pending'
           and p.metadata->>'subscription_id'=s.id::text
      )
  ), ranked as (
    select category,entity_id,owner_id,details
    from findings
    order by category,entity_id
  )
  select count(*)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'category',category,'entityId',entity_id,'details',details
    ) order by category,entity_id) filter (where ordinal<=p_limit),'[]'::jsonb)
  into v_finding_count,v_findings
  from (
    select *,row_number() over(order by category,entity_id) as ordinal
    from ranked
  ) limited;

  insert into subscription_financial_reconciliation_runs(
    completed_at,status,scanned_payment_count,scanned_subscription_count,
    finding_count,returned_finding_count,findings,report
  ) values(
    clock_timestamp(),'completed',v_payment_count,v_subscription_count,
    v_finding_count,jsonb_array_length(v_findings),v_findings,
    jsonb_build_object('mode','read_only','mutationsApplied',false,
      'generatedAt',v_now,'limit',p_limit)
  ) returning id into v_run_id;

  return jsonb_build_object(
    'runId',v_run_id,'status','completed','mode','read_only',
    'mutationsApplied',false,'generatedAt',v_now,
    'scannedPaymentCount',v_payment_count,
    'scannedSubscriptionCount',v_subscription_count,
    'findingCount',v_finding_count,
    'returnedFindingCount',jsonb_array_length(v_findings),
    'findings',v_findings
  );
end;
$run_subscription_financial_reconciliation$;

revoke all on function executive_visuals.run_subscription_financial_reconciliation(integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.run_subscription_financial_reconciliation(integer)
  to service_role;


-- Paddle past-due lifecycle notifications must start a bounded grace period.
-- Use the provider's occurred_at timestamp (not webhook arrival time) so retries
-- cannot extend the customer's grace window. A resumed event clears the deadline.
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
as $apply_paddle_subscription_lifecycle_batch146$
declare
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  next_status text;
  ledger_event_type text;
  event_occurred_at timestamptz;
begin
  if p_provider_subscription_id !~ '^sub_[a-z0-9]{26}$'
     or p_event_type not in ('subscription.created','subscription.activated','subscription.updated',
       'subscription.canceled','subscription.past_due','subscription.paused','subscription.resumed')
     or jsonb_typeof(coalesce(p_event_data,'{}'::jsonb))<>'object'
     or (p_period_start is not null and p_period_end is not null and p_period_end<=p_period_start) then
    raise exception 'Invalid Paddle subscription lifecycle event' using errcode='22023';
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

  if subscription_row.provider_last_event_occurred_at is not null
     and event_occurred_at < subscription_row.provider_last_event_occurred_at then
    return jsonb_build_object('applied',false,'stale',true,
      'subscriptionId',subscription_row.id,'status',subscription_row.status,
      'lastEventOccurredAt',subscription_row.provider_last_event_occurred_at);
  end if;

  next_status:=case p_event_type
    when 'subscription.canceled' then 'cancelled'
    when 'subscription.past_due' then 'past_due'
    when 'subscription.paused' then 'suspended'
    when 'subscription.resumed' then 'active'
    when 'subscription.activated' then 'active'
    else subscription_row.status
  end;

  if subscription_row.status='pending' and p_event_type in ('subscription.created','subscription.activated','subscription.updated') then
    next_status:='pending';
  end if;

  update customer_subscriptions set
    status=next_status,
    current_period_start=coalesce(p_period_start,current_period_start),
    current_period_end=coalesce(p_period_end,current_period_end),
    cancel_at_period_end=coalesce(p_cancel_at_period_end,cancel_at_period_end),
    cancelled_at=case when p_event_type='subscription.canceled' then coalesce(cancelled_at,event_occurred_at) else cancelled_at end,
    grace_until=case
      when next_status='active' then null
      when p_event_type='subscription.past_due'
        then coalesce(grace_until,event_occurred_at+interval '72 hours')
      else grace_until
    end,
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
        'provider_subscription_id',p_provider_subscription_id,'provider_event_type',p_event_type));
  end if;

  return jsonb_build_object('applied',true,'subscriptionId',subscription_row.id,
    'status',next_status,'lastEventOccurredAt',event_occurred_at,
    'graceUntil',case when p_event_type='subscription.past_due'
      then coalesce(subscription_row.grace_until,event_occurred_at+interval '72 hours')
      else null end);
end;
$apply_paddle_subscription_lifecycle_batch146$;

revoke all on function executive_visuals.apply_paddle_subscription_lifecycle(text,text,timestamptz,timestamptz,boolean,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.apply_paddle_subscription_lifecycle(text,text,timestamptz,timestamptz,boolean,jsonb)
  to service_role;

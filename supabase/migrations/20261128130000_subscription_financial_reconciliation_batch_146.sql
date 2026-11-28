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
      and coalesce((p.metadata->>'subscription_applied')::boolean,false) is not true

    union all

    select 'applied_payment_not_successful',p.id::text,p.owner_id,
      jsonb_build_object('paymentId',p.id,'ownerId',p.owner_id,'provider',p.provider,
        'reference',p.tx_ref,'paymentStatus',p.status,'subscriptionApplied',true)
    from payment_transactions p
    where p.metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      and coalesce((p.metadata->>'subscription_applied')::boolean,false) is true
      and p.status<>'successful'

    union all

    select 'subscription_record_missing',p.id::text,p.owner_id,
      jsonb_build_object('paymentId',p.id,'ownerId',p.owner_id,'provider',p.provider,
        'reference',p.tx_ref,'subscriptionId',p.metadata->>'subscription_id')
    from payment_transactions p
    left join customer_subscriptions s
      on s.id::text=p.metadata->>'subscription_id' and s.owner_id=p.owner_id
    where p.metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      and coalesce((p.metadata->>'subscription_applied')::boolean,false) is true
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
      and coalesce((p.metadata->>'subscription_applied')::boolean,false) is true
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
      and coalesce((p.metadata->>'subscription_applied')::boolean,false) is true
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
      and coalesce((p.metadata->>'subscription_applied')::boolean,false) is true
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

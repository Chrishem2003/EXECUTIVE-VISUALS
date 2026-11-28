-- Batch 146: disposable PostgreSQL acceptance for subscription financial reconciliation.
-- All mutations are enclosed in a transaction and rolled back after assertions.
begin;
set role service_role;
do $batch146$
declare
  v_subscription_id uuid;
  v_payment_id uuid;
  v_report jsonb;
  v_run_id uuid;
  v_original_payment_metadata jsonb;
  v_original_status text;
  v_original_start timestamptz;
  v_original_end timestamptz;
  v_original_grace timestamptz;
begin
  select id into v_subscription_id
    from executive_visuals.customer_subscriptions
   where provider='pesapal' and status='active'
   order by created_at desc limit 1;
  if v_subscription_id is null then
    raise exception 'Batch 146 requires the verified Pesapal subscription fixture from the provider integration suite';
  end if;

  select id,metadata into v_payment_id,v_original_payment_metadata
    from executive_visuals.payment_transactions
   where owner_id=(select owner_id from executive_visuals.customer_subscriptions where id=v_subscription_id)
     and metadata->>'subscription_id'=v_subscription_id::text
     and metadata->>'payment_purpose'='subscription_purchase'
     and status='successful'
   order by created_at asc limit 1;
  if v_payment_id is null then raise exception 'Batch 146 could not locate the verified initial subscription payment'; end if;

  -- Healthy baseline must be clean: the payment, allowance grant and wallet source agree.
  v_report:=executive_visuals.run_subscription_financial_reconciliation(100);
  if v_report->>'status'<>'completed' or v_report->>'mode'<>'read_only'
     or (v_report->>'mutationsApplied')::boolean is distinct from false
     or (v_report->>'findingCount')::integer<>0 then
    raise exception 'Healthy Paddle/Pesapal fixtures should reconcile without findings: %',v_report;
  end if;
  v_run_id:=(v_report->>'runId')::uuid;
  if not exists(select 1 from executive_visuals.subscription_financial_reconciliation_runs
    where id=v_run_id and status='completed' and finding_count=0 and report->>'mutationsApplied'='false') then
    raise exception 'Reconciliation run was not durably recorded';
  end if;

  -- A successful payment missing its application marker must be visible, never silently re-granted.
  update executive_visuals.payment_transactions
     set metadata=jsonb_set(metadata,'{subscription_applied}','false'::jsonb,true)
   where id=v_payment_id;
  v_report:=executive_visuals.run_subscription_financial_reconciliation(100);
  if not exists(select 1 from jsonb_array_elements(v_report->'findings') f
    where f->>'category'='successful_payment_not_applied'
      and f->>'entityId'=v_payment_id::text) then
    raise exception 'Successful-but-unapplied subscription payment was not reported: %',v_report;
  end if;
  update executive_visuals.payment_transactions set metadata=v_original_payment_metadata where id=v_payment_id;

  -- A provider lifecycle past_due state without a grace deadline is a launch blocker.
  select status,current_period_start,current_period_end,grace_until
    into v_original_status,v_original_start,v_original_end,v_original_grace
    from executive_visuals.customer_subscriptions where id=v_subscription_id;
  update executive_visuals.customer_subscriptions
     set status='past_due',grace_until=null where id=v_subscription_id;
  v_report:=executive_visuals.run_subscription_financial_reconciliation(100);
  if not exists(select 1 from jsonb_array_elements(v_report->'findings') f
    where f->>'category'='past_due_grace_deadline_missing'
      and f->>'entityId'=v_subscription_id::text) then
    raise exception 'Past-due subscription without grace deadline was not reported: %',v_report;
  end if;

  -- An active subscription past its paid-through date and without a pending renewal is also flagged.
  update executive_visuals.customer_subscriptions
     set status='active',current_period_start=clock_timestamp()-interval '2 days',
         current_period_end=clock_timestamp()-interval '1 day',grace_until=null
   where id=v_subscription_id;
  v_report:=executive_visuals.run_subscription_financial_reconciliation(100);
  if not exists(select 1 from jsonb_array_elements(v_report->'findings') f
    where f->>'category'='active_subscription_period_elapsed'
      and f->>'entityId'=v_subscription_id::text) then
    raise exception 'Expired active subscription was not reported: %',v_report;
  end if;

  -- Bound and reject invalid report sizes.
  begin
    perform executive_visuals.run_subscription_financial_reconciliation(501);
    raise exception 'Out-of-range reconciliation limit unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;

  raise notice 'Batch 146 subscription financial reconciliation PostgreSQL acceptance passed';
end;
$batch146$;
reset role;
rollback;

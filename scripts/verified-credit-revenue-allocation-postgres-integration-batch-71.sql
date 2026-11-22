-- Batch 71: payment -> source grant -> FIFO credit consumption -> verified job revenue.
reset role;
do $batch71_seed$
declare
  v_owner constant uuid:='71717171-7171-4171-8171-717171717171';
  v_job_paid constant uuid:='71717171-7171-4171-8171-717171717101';
  v_job_pending constant uuid:='71717171-7171-4171-8171-717171717102';
  v_payment_paid constant uuid:='71717171-7171-4171-8171-717171717201';
  v_payment_subscription constant uuid:='71717171-7171-4171-8171-717171717202';
  v_old_paid_grant uuid;
  v_old_subscription_grant uuid;
  v_paid_grant uuid;
  v_subscription_grant uuid;
  v_promo_grant uuid;
  v_paid_reservation uuid;
  v_pending_reservation uuid;
  v_source jsonb;
begin
  insert into auth.users(id,email) values(v_owner,'batch71-owner@example.invalid')
    on conflict(id) do nothing;
  insert into executive_visuals.platform_admins(user_id,role,reason)
    values(v_owner,'billing_admin','Batch 71 disposable PostgreSQL integration')
    on conflict(user_id) do update set role=excluded.role,reason=excluded.reason;

  insert into executive_visuals.jobs(id,owner_id,job_type) values
    (v_job_paid,v_owner,'video.generate'),
    (v_job_pending,v_owner,'video.generate')
  on conflict(id) do nothing;

  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,provider_transaction_id,tx_ref,amount_minor,currency,status,
    payment_method,customer_email,description,paid_at,verified_at,metadata
  ) values
    (v_payment_paid,v_owner,'pesapal','batch71-provider-paid','batch71-paid-ref',1000,'USD','successful',
     'hosted_checkout','batch71-owner@example.invalid','Verified credit pack',
     '2026-11-22T09:00:00Z','2026-11-22T09:00:00Z',
     '{"payment_purpose":"credit_pack_purchase","credit_pack_applied":true}'),
    (v_payment_subscription,v_owner,'paddle','txn_batch71_subscription','batch71-sub-ref',3000,'USD','successful',
     'card','batch71-owner@example.invalid','Subscription payment',
     '2026-11-22T09:01:00Z','2026-11-22T09:01:00Z',
     '{"payment_purpose":"subscription_renewal","subscription_applied":true}');
  insert into executive_visuals.credit_ledger(
    owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata
  ) values(v_owner,'purchase_grant',100,'batch71-old-ledger-paid',v_payment_paid,'Verified paid credit pack','{}')
  returning id into v_old_paid_grant;
  insert into executive_visuals.credit_ledger(
    owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata
  ) values(v_owner,'purchase_grant',50,'batch71-old-ledger-subscription',v_payment_subscription,'Verified subscription allowance','{}')
  returning id into v_old_subscription_grant;

  select id into v_paid_grant from executive_visuals.billing_credit_ledger
   where idempotency_key='payment-credit-ledger:'||v_old_paid_grant::text;
  select id into v_subscription_grant from executive_visuals.billing_credit_ledger
   where idempotency_key='payment-credit-ledger:'||v_old_subscription_grant::text;
  if v_paid_grant is null or v_subscription_grant is null then
    raise exception 'Verified payment ledger grants were not mirrored into the generation wallet';
  end if;
  select ledger_id into v_promo_grant
    from executive_visuals.grant_generation_credits(
      v_owner,20,'batch71-wallet-promo','Promotional credits',
      '{"sourceType":"promotional"}'
    );

  v_source:=executive_visuals.register_generation_credit_revenue_source(
    v_owner,v_paid_grant,'paid_credit_pack',v_payment_paid,1000,'USD',
    '{"evidenceType":"verified_provider_payment","batch":71}'
  );
  if (v_source->>'replayed')::boolean is distinct from true then raise exception 'Payment-ledger trigger did not register the paid source idempotently'; end if;
  v_source:=executive_visuals.register_generation_credit_revenue_source(
    v_owner,v_paid_grant,'paid_credit_pack',v_payment_paid,1000,'USD',
    '{"evidenceType":"verified_provider_payment","batch":71}'
  );
  if (v_source->>'replayed')::boolean is distinct from true then raise exception 'Paid source registration is not idempotent'; end if;

  perform executive_visuals.register_generation_credit_revenue_source(
    v_owner,v_subscription_grant,'subscription_allowance',v_payment_subscription,null,'USD',
    '{"evidenceType":"verified_subscription_payment","batch":71}'
  );
  perform executive_visuals.register_generation_credit_revenue_source(
    v_owner,v_promo_grant,'promotional',null,0,null,
    '{"evidenceType":"promotion_approval","batch":71}'
  );

  select reservation_id into v_paid_reservation
    from executive_visuals.reserve_generation_credits(v_owner,v_job_paid,50,'batch71-reserve-paid');
  select reservation_id into v_pending_reservation
    from executive_visuals.reserve_generation_credits(v_owner,v_job_pending,120,'batch71-reserve-pending');

  perform * from executive_visuals.settle_generation_credit_reservation(
    v_paid_reservation,40,
    '{"provider":"runway","evidenceType":"provider_invoice","evidenceId":"batch71-paid-job-invoice"}'
  );
  perform * from executive_visuals.settle_generation_credit_reservation(
    v_pending_reservation,120,
    '{"provider":"runway","evidenceType":"provider_invoice","evidenceId":"batch71-pending-job-invoice"}'
  );

  if not exists(
    select 1 from executive_visuals.billing_credit_revenue_allocation_runs
    where reservation_id=v_paid_reservation and status='complete'
      and actual_credits=40 and allocated_credits=40 and unattributed_credits=0
  ) then raise exception 'Paid reservation did not receive complete revenue allocation'; end if;

  if not exists(
    select 1 from executive_visuals.billing_credit_revenue_allocations
    where reservation_id=v_paid_reservation and credits_consumed=40
      and revenue_minor=400 and currency='USD' and allocation_status='verified'
  ) then raise exception 'Paid credit pack revenue was not allocated proportionally'; end if;

  if not exists(
    select 1 from executive_visuals.billing_credit_revenue_allocation_runs
    where reservation_id=v_pending_reservation and status='pending_subscription_split'
      and actual_credits=120 and allocated_credits=120 and pending_split_credits=50
  ) then raise exception 'Mixed paid/promo/subscription credits were not conservatively flagged'; end if;

  if not exists(
    select 1 from executive_visuals.billing_credit_revenue_allocations
    where reservation_id=v_pending_reservation and allocation_status='non_revenue'
      and credits_consumed=10 and revenue_minor=0
  ) then raise exception 'Promotional credits were not explicitly allocated as zero-revenue usage'; end if;

  if (select count(*) from executive_visuals.billing_credit_revenue_allocations
      where reservation_id=v_paid_reservation)<>1 then
    raise exception 'Unexpected paid allocation row count';
  end if;

  -- A subscription allowance never inherits the full subscription payment as generation revenue.
  if exists(
    select 1 from executive_visuals.billing_credit_revenue_allocations
    where reservation_id=v_pending_reservation
      and allocation_status='pending_subscription_split' and revenue_minor is not null
  ) then raise exception 'Subscription revenue was inferred without an approved credit-component split'; end if;

  -- Source registration must reject a mismatched currency and unverified payment.
  begin
    perform executive_visuals.register_generation_credit_revenue_source(
      v_owner,v_paid_grant,'paid_credit_pack',v_payment_paid,1000,'UGX','{}'
    );
    raise exception 'Mismatched currency unexpectedly accepted';
  exception when sqlstate '23514' then null;
  end;

  -- A repeated settlement must not double-allocate revenue.
  perform * from executive_visuals.settle_generation_credit_reservation(
    v_paid_reservation,40,
    '{"provider":"runway","evidenceType":"provider_invoice","evidenceId":"batch71-paid-job-invoice"}'
  );
  if (select count(*) from executive_visuals.billing_credit_revenue_allocations
      where reservation_id=v_paid_reservation)<>1 then
    raise exception 'Settlement replay duplicated revenue allocation';
  end if;
end
$batch71_seed$;

set role service_role;
do $batch71_verify$
declare
  v_owner constant uuid:='71717171-7171-4171-8171-717171717171';
  v_job_paid constant uuid:='71717171-7171-4171-8171-717171717101';
  v_report jsonb;
  v_row jsonb;
  v_source uuid;
begin
  v_report:=executive_visuals.get_verified_job_cost_coverage(v_owner,'2026-11-01',100);
  select value into v_row from jsonb_array_elements(v_report->'rows')
    where value->>'job_id'=v_job_paid::text;
  if v_row is null or (v_row->>'recognized_revenue_minor')::bigint<>400
     or v_row->>'revenue_currency'<>'USD' then
    raise exception 'Verified paid revenue was not exposed by the job cost report: %',v_row;
  end if;
  if (v_report->>'profitabilityAvailable')::boolean is distinct from false then
    raise exception 'Profitability must remain blocked while provider invoice costs are missing';
  end if;

  -- Subscription revenue must be assigned to its credit component by a billing administrator.
  select id into v_source from executive_visuals.billing_credit_revenue_sources
   where source_type='subscription_allowance' and owner_id=v_owner;
  perform executive_visuals.approve_subscription_credit_revenue_split(
    v_owner,v_source,600,'Approved credit component of the verified subscription price',
    '{"review":"batch71_subscription_credit_component","approvedBy":"billing_admin"}'
  );
  v_report:=executive_visuals.get_verified_job_cost_coverage(v_owner,'2026-11-01',100);
  select value into v_row from jsonb_array_elements(v_report->'rows')
    where value->>'job_id'='71717171-7171-4171-8171-717171717102';
  if v_row is null or (v_row->>'recognized_revenue_minor')::bigint<>1200
     or v_row->>'revenue_currency'<>'USD' then
    raise exception 'Approved subscription credit split was not allocated to historical consumed credits: %',v_row;
  end if;
  if (v_report->>'revenueAllocationAvailable')::boolean is distinct from true
     or (v_report->>'profitabilityAvailable')::boolean is distinct from false then
    raise exception 'Revenue coverage and profitability gates were not independently enforced: %',v_report;
  end if;
end
$batch71_verify$;
reset role;

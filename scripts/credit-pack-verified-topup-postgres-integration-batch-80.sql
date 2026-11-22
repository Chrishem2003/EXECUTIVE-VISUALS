-- Batch 80: a verified Flutterwave top-up must create exactly one wallet grant
-- and one paid-credit revenue source. No live provider request is made here.
reset role;
do $batch80_seed$
declare
  v_owner constant uuid:='80808080-8080-4080-8080-808080808001';
  v_payment constant uuid:='80808080-8080-4080-8080-808080808002';
  v_bad_payment constant uuid:='80808080-8080-4080-8080-808080808003';
begin
  insert into auth.users(id,email) values(v_owner,'batch80-owner@example.invalid')
    on conflict(id) do nothing;

  insert into executive_visuals.billing_products(
    product_code,product_type,name,description,amount_minor,currency,credit_units,active
  ) values(
    'batch80-credit-pack','credit_pack','Batch 80 test pack','Disposable integration fixture',5000,'UGX',100,true
  ) on conflict(product_code) do update set
    product_type=excluded.product_type,name=excluded.name,amount_minor=excluded.amount_minor,
    currency=excluded.currency,credit_units=excluded.credit_units,active=excluded.active;

  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,
    customer_email,description,metadata
  ) values(
    v_payment,v_owner,'flutterwave','batch80-topup-ref',5000,'UGX','pending',
    'mobile_money','batch80-owner@example.invalid','Batch 80 verified credit pack',
    jsonb_build_object(
      'product_code','batch80-credit-pack','credit_units',100,
      'payment_purpose','credit_pack_purchase','credit_pack_applied',false,
      'credit_pack_snapshot',jsonb_build_object(
        'productCode','batch80-credit-pack','productType','credit_pack',
        'amountMinor',5000,'currency','UGX','creditUnits',100
      ),
      'idempotency_key','batch80-topup-idempotency'
    )
  ) on conflict(id) do nothing;

  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,
    customer_email,description,metadata
  ) values(
    v_bad_payment,v_owner,'flutterwave','batch80-bad-topup-ref',6000,'UGX','pending',
    'mobile_money','batch80-owner@example.invalid','Mismatched Batch 80 test pack',
    jsonb_build_object(
      'product_code','batch80-credit-pack','credit_units',100,
      'payment_purpose','credit_pack_purchase','credit_pack_applied',false,
      'credit_pack_snapshot',jsonb_build_object(
        'productCode','batch80-credit-pack','productType','credit_pack',
        'amountMinor',5000,'currency','UGX','creditUnits',100
      )
    )
  ) on conflict(id) do nothing;
end
$batch80_seed$;

set role service_role;
do $batch80_verify$
declare
  v_owner constant uuid:='80808080-8080-4080-8080-808080808001';
  v_payment constant uuid:='80808080-8080-4080-8080-808080808002';
  v_bad_payment constant uuid:='80808080-8080-4080-8080-808080808003';
  v_result jsonb;
  v_grants bigint;
  v_wallet_grants bigint;
  v_sources bigint;
  v_amount bigint;
begin
  v_result:=executive_visuals.finalize_payment_purchase(
    v_payment,'batch80-provider-charge',
    '{"id":"batch80-provider-charge","flw_ref":"batch80-provider-reference"}'::jsonb,
    '2026-11-22T12:00:00Z'
  );
  if v_result->>'status'<>'successful' or (v_result->>'credit_units')::bigint<>100 then
    raise exception 'Verified top-up finalizer returned an unexpected result: %',v_result;
  end if;

  if not exists(select 1 from executive_visuals.payment_transactions
    where id=v_payment and status='successful' and verified_at is not null
      and metadata->>'payment_purpose'='credit_pack_purchase'
      and (metadata->>'credit_pack_applied')::boolean is true) then
    raise exception 'Verified payment provenance flags were not persisted';
  end if;

  select count(*) into v_grants from executive_visuals.credit_ledger
   where owner_id=v_owner and payment_transaction_id=v_payment and entry_type='purchase_grant';
  select count(*) into v_wallet_grants from executive_visuals.billing_credit_ledger
   where owner_id=v_owner and event_type='grant' and idempotency_key like 'payment-credit-ledger:%';
  select count(*) into v_sources from executive_visuals.billing_credit_revenue_sources
   where owner_id=v_owner and source_reference_id=v_payment and source_type='paid_credit_pack'
     and revenue_status='verified' and allocatable_revenue_minor=5000 and currency='UGX';
  if v_grants<>1 or v_wallet_grants<>1 or v_sources<>1 then
    raise exception 'Top-up did not create exactly one legacy grant, wallet grant and paid revenue source: %, %, %',
      v_grants,v_wallet_grants,v_sources;
  end if;

  -- Provider retries are idempotent and do not grant a second pack.
  v_result:=executive_visuals.finalize_payment_purchase(
    v_payment,'batch80-provider-charge',
    '{"id":"batch80-provider-charge","flw_ref":"batch80-provider-reference"}'::jsonb,
    '2026-11-22T12:00:00Z'
  );
  select count(*) into v_grants from executive_visuals.credit_ledger
   where owner_id=v_owner and payment_transaction_id=v_payment and entry_type='purchase_grant';
  select count(*) into v_wallet_grants from executive_visuals.billing_credit_ledger
   where owner_id=v_owner and event_type='grant' and idempotency_key like 'payment-credit-ledger:%';
  if v_grants<>1 or v_wallet_grants<>1 then
    raise exception 'Webhook replay duplicated a credit-pack grant';
  end if;

  -- A mismatch between the immutable checkout snapshot and payment amount
  -- must fail before any grant or revenue source is written.
  begin
    perform executive_visuals.finalize_payment_purchase(
      v_bad_payment,'batch80-bad-provider-charge',
      '{"id":"batch80-bad-provider-charge"}'::jsonb,
      '2026-11-22T12:01:00Z'
    );
    raise exception 'Mismatched credit-pack snapshot was accepted';
  exception when sqlstate '23514' then
    if sqlerrm not like '%CREDIT_PACK_SNAPSHOT_PAYMENT_MISMATCH%' then raise; end if;
  end;

  if exists(select 1 from executive_visuals.credit_ledger
    where payment_transaction_id=v_bad_payment and entry_type='purchase_grant') then
    raise exception 'Mismatched checkout unexpectedly granted credits';
  end if;
  if exists(select 1 from executive_visuals.billing_credit_revenue_sources
    where source_reference_id=v_bad_payment and source_type='paid_credit_pack') then
    raise exception 'Mismatched checkout unexpectedly recognized credit-pack revenue';
  end if;

  select allocatable_revenue_minor into v_amount
    from executive_visuals.billing_credit_revenue_sources
   where source_reference_id=v_payment and source_type='paid_credit_pack';
  if v_amount<>5000 then raise exception 'Recognized revenue does not match the verified payment amount'; end if;
end
$batch80_verify$;
reset role;
